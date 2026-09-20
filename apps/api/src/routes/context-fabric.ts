import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  FederationFanoutRequest,
  FederationFanoutResponse,
  FederationPeerQueryRequest,
  FederationRemoteQueryRequest,
  FederationRemoteQueryResponse,
  SearchHit,
  type FederationRemoteQueryResponse as FederationRemoteQueryResponseType,
} from "@akp/contracts";
import {
  ConnectorCapabilities,
  connectorReadPlan,
  evaluateConnectorCapabilities,
} from "@akp/contracts/connector-capabilities";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  KnowledgeProfileV1,
} from "@akp/contracts/knowledge-profile";
import {
  applyWorkspaceOfflineDraft,
  getWorkspaceSessionForParticipant,
  getActiveKnowledgeProfileRevision,
  getContextFabricPeerRuntime,
  listContextFabricPeers,
  markContextFabricPeerQueryFailure,
  markContextFabricPeerQuerySuccess,
  listExternalObjectRefsForSession,
  isWorkActivityAction,
  isWorkObjectClass,
  isWorkActivityDerivation,
  isWorkActivityRelationKind,
  listWorkActivityForSession,
  listWorkspaceOfflineDrafts,
  recordWorkActivity,
  queueWorkspaceOfflineDraft,
  readContextFabricNodeClaim,
  resolveAuthorizedVaultScope,
  revokeContextFabricPeer,
  upsertContextFabricPeer,
  upsertExternalObjectRef,
  workspaceSessionSnapshot,
  type Postgres,
  type WorkspaceSessionAccess,
} from "@akp/postgres";
import {
  actorOf,
  audit,
  requirePermission,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";

const OFFLINE_EVENT_TYPES = new Set([
  "FINDING",
  "ARTIFACT",
  "DECISION_CANDIDATE",
  "NOTE",
]);
const DISCOVERY_MODES = new Set([
  "CATALOG_ONLY",
  "REMOTE_QUERY",
  "MIRROR_BUNDLE",
]);
const PEER_TRUST_STATES = new Set(["DISCOVERED", "APPROVED", "DISABLED"]);

function normalizeFederationEndpoint(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const url = new URL(trimmed);
    const hostname = url.hostname.toLowerCase();
    const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      hostname,
    );
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
    ) {
      return null;
    }
    return url.toString().replace(/\/+$/u, "");
  } catch {
    return null;
  }
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const expected = new Set(left);
  return right.every((value) => expected.has(value));
}

function federationSchemaVersion(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const schemaVersion = (value as Record<string, unknown>).schemaVersion;
  return typeof schemaVersion === "number" && Number.isSafeInteger(schemaVersion)
    ? schemaVersion
    : null;
}

async function readBoundedFederationJson(
  response: Response,
  maxBytes: number,
): Promise<unknown> {
  if (!response.body) throw new Error("FEDERATION_RESPONSE_EMPTY");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("FEDERATION_RESPONSE_TOO_LARGE");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("FEDERATION_RESPONSE_INVALID_JSON");
  }
}

function boundedFederationResponse(
  value: FederationRemoteQueryResponseType,
  maxBytes: number,
): FederationRemoteQueryResponseType | null {
  let bounded = FederationRemoteQueryResponse.parse(value);
  if (Buffer.byteLength(JSON.stringify(bounded), "utf8") <= maxBytes) {
    return bounded;
  }
  const hits = [...bounded.hits];
  const warnings = new Set(bounded.warnings);
  warnings.add("FEDERATION_RESPONSE_TRUNCATED");
  while (hits.length) {
    hits.pop();
    bounded = FederationRemoteQueryResponse.parse({
      ...bounded,
      partial: true,
      warnings: [...warnings],
      hits,
    });
    if (Buffer.byteLength(JSON.stringify(bounded), "utf8") <= maxBytes) {
      return bounded;
    }
  }
  return null;
}

function boundedObject(
  value: unknown,
  maxBytes = 16 * 1024,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) return null;
  return value as Record<string, unknown>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function safeText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maxLength ||
    /[\u0000-\u001f]/.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function boundedStringList(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) return null;
  const normalized = value.map((entry) => safeText(entry, maxLength));
  if (normalized.some((entry) => entry === null)) return null;
  return [...new Set(normalized as string[])];
}

function sendFabricError(reply: FastifyReply, error: unknown) {
  if (error && typeof error === "object") {
    const candidate = error as { code?: unknown; statusCode?: unknown };
    if (
      typeof candidate.code === "string" &&
      typeof candidate.statusCode === "number" &&
      candidate.statusCode >= 400 &&
      candidate.statusCode < 600
    ) {
      return reply.code(candidate.statusCode).send({ code: candidate.code });
    }
  }
  throw error;
}

async function authorizedSession(
  db: Postgres,
  request: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
): Promise<WorkspaceSessionAccess | null> {
  const actor = actorOf(request);
  if (!actor) {
    await reply.code(401).send({ code: "AUTH_REQUIRED" });
    return null;
  }
  const session = await getWorkspaceSessionForParticipant(
    db,
    sessionId,
    actor.id,
  );
  if (!session) {
    await reply.code(404).send({ code: "SESSION_NOT_FOUND" });
    return null;
  }
  if (
    actor.principalKind === "AGENT_PROCESS" &&
    (actor.principalSessionId !== session.id ||
      actor.principalVaultId !== session.vaultId)
  ) {
    await reply.code(403).send({ code: "PRINCIPAL_SCOPE_DENIED" });
    return null;
  }
  try {
    const scope = await resolveAuthorizedVaultScope(db, {
      userId: actor.id,
      spaceId: session.spaceId,
      permission: "knowledge:read",
      vaultId: session.vaultId,
      vaultIds: [session.vaultId],
      federated: false,
    });
    if (scope.accessByVault[session.vaultId]?.pathPrefix !== null) {
      await reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      return null;
    }
  } catch {
    await reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
    return null;
  }
  return session;
}

export function registerContextFabricRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.get(
    "/v1/context-fabric/capabilities",
    { preHandler: requirePermission("knowledge:read") },
    async (request) => {
      const actor = actorOf(request);
      // Report the claim this database actually carries, not the environment
      // this process happens to have been handed. A node that never completed
      // its claim must not describe itself as the owner of shared state.
      const claim = await readContextFabricNodeClaim(db);
      const configuredMode =
        process.env.AKP_CONTEXT_FABRIC_MODE?.trim() || "SOLO_LOCAL";
      const deploymentMode = claim?.deploymentMode ?? configuredMode;
      const nodeId =
        claim?.nodeId ??
        (process.env.AKP_CONTEXT_FABRIC_NODE_ID?.trim() ||
          "local-context-node");
      const remoteQueryEnabled = deploymentMode === "FEDERATED_ORG";
      return {
        schemaVersion: 1,
        deploymentMode,
        node: {
          id: nodeId,
          claimed: claim !== null,
          claimedAt: claim?.claimedAt.toISOString() ?? null,
          adoptedFrom: claim?.adoptedFrom ?? null,
          sharedDerivedState:
            claim !== null &&
            (claim.deploymentMode === "TEAM_NODE" ||
              claim.deploymentMode === "FEDERATED_ORG"),
        },
        manifest: {
          nodeId,
          contextApiVersion: "v1",
          requiredAuthenticationModes: ["BEARER_TOKEN", "WEB_SESSION"],
          supportedExchangeFormats: [
            { format: "OKF_0_2", import: true, export: true },
            { format: "JSON_LD", import: false, export: true },
            { format: "GRAPHML", import: false, export: true },
          ],
          graphCapabilities: {
            domains: ["EPISTEMIC", "WORK"],
            authorizationBeforeTraversal: true,
          },
          federationModes: remoteQueryEnabled
            ? ["CATALOG_ONLY", "REMOTE_QUERY"]
            : ["CATALOG_ONLY"],
          federationSchemaVersions: [1],
        },
        capabilities: {
          workspaceCoordination: true,
          revisionPinnedBootstrap: true,
          externalObjectRefs: true,
          offlineApprovedSnapshotCapture: true,
          queuedOfflineDrafts: true,
          staleReconnectDisclosure: true,
          lastWriteWinsApprovedKnowledge: false,
          federationDiscovery: true,
          federationRemoteQuery: remoteQueryEnabled,
          writableDatabaseFileSync: false,
        },
        authorizedSpaces: actor?.spaceIds ?? [],
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id/external-refs",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      return {
        refs: await listExternalObjectRefsForSession(db, session.id, actor.id),
      };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      provider?: string;
      objectType?: string;
      externalId?: string;
      canonicalUrl?: string;
      sourceRevision?: string;
      title?: string;
      authority?: "SYSTEM_OF_RECORD" | "REFERENCE" | "MIRRORED_PROJECTION";
      workObjectClass?: string;
      owners?: string[];
      metadata?: Record<string, unknown>;
    };
  }>(
    "/v1/sessions/:id/external-refs",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const provider = safeText(request.body?.provider, 80);
      const objectType = safeText(request.body?.objectType, 80);
      const externalId = safeText(request.body?.externalId, 512);
      const metadata = boundedObject(request.body?.metadata ?? {});
      const owners = boundedStringList(request.body?.owners, 50, 256);
      if (!provider || !objectType || !externalId || !metadata || !owners) {
        return reply.code(400).send({ code: "INVALID_EXTERNAL_OBJECT_REF" });
      }
      // The work class is what makes a reference traversable as work. It is
      // optional, because a plain reference is still a legitimate projection,
      // but a supplied one must be a class the work graph actually knows.
      const requestedClass = request.body?.workObjectClass
        ?.trim()
        .toUpperCase();
      if (requestedClass && !isWorkObjectClass(requestedClass)) {
        return reply.code(400).send({ code: "INVALID_WORK_OBJECT_CLASS" });
      }
      const workObjectClass =
        requestedClass && isWorkObjectClass(requestedClass)
          ? requestedClass
          : undefined;
      const ref = await upsertExternalObjectRef(db, {
        sessionId: session.id,
        actorId: actor.id,
        provider,
        objectType,
        externalId,
        canonicalUrl: request.body?.canonicalUrl ?? null,
        sourceRevision: request.body?.sourceRevision ?? null,
        title: request.body?.title ?? null,
        ...(request.body?.authority
          ? { authority: request.body.authority }
          : {}),
        ...(workObjectClass ? { workObjectClass } : {}),
        owners,
        metadata,
      });
      await audit(
        db,
        request,
        "context_fabric.external_ref.upsert",
        "external_object_ref",
        ref.id,
        {
          vaultId: session.vaultId,
          sessionId: session.id,
          provider,
          objectType,
        },
        session.spaceId,
      );
      return reply.code(201).send(ref);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id/offline-drafts",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      return {
        drafts: await listWorkspaceOfflineDrafts(db, session.id, actor.id),
      };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      clientDraftId?: string;
      baseRevisionSetHash?: string;
      eventType?: string;
      payload?: Record<string, unknown>;
    };
  }>(
    "/v1/sessions/:id/offline-drafts",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const clientDraftId = safeText(request.body?.clientDraftId, 200);
      const baseRevisionSetHash = safeText(
        request.body?.baseRevisionSetHash,
        64,
      );
      const eventType = request.body?.eventType?.trim().toUpperCase();
      const payload = boundedObject(request.body?.payload ?? {});
      if (
        !clientDraftId ||
        !baseRevisionSetHash ||
        !/^[a-f0-9]{64}$/.test(baseRevisionSetHash) ||
        !eventType ||
        !OFFLINE_EVENT_TYPES.has(eventType) ||
        !payload
      ) {
        return reply.code(400).send({ code: "INVALID_OFFLINE_DRAFT" });
      }
      let draft: Awaited<ReturnType<typeof queueWorkspaceOfflineDraft>>;
      try {
        draft = await queueWorkspaceOfflineDraft(db, {
          sessionId: session.id,
          actorId: actor.id,
          clientDraftId,
          baseRevisionSetHash,
          eventType: eventType as
            "FINDING" | "ARTIFACT" | "DECISION_CANDIDATE" | "NOTE",
          payload,
        });
      } catch (error) {
        return sendFabricError(reply, error);
      }
      await audit(
        db,
        request,
        "context_fabric.offline_draft.queue",
        "workspace_offline_draft",
        draft.id,
        {
          vaultId: session.vaultId,
          sessionId: session.id,
          status: draft.status,
          baseRevisionSetHash,
        },
        session.spaceId,
      );
      return reply.code(draft.status === "QUEUED" ? 201 : 409).send(draft);
    },
  );

  app.post<{ Params: { id: string; draftId: string } }>(
    "/v1/sessions/:id/offline-drafts/:draftId/apply",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      let visibleDrafts: Awaited<ReturnType<typeof listWorkspaceOfflineDrafts>>;
      try {
        visibleDrafts = await listWorkspaceOfflineDrafts(
          db,
          session.id,
          actor.id,
        );
      } catch (error) {
        return sendFabricError(reply, error);
      }
      if (!visibleDrafts.some((draft) => draft.id === request.params.draftId)) {
        return reply.code(404).send({ code: "OFFLINE_DRAFT_NOT_FOUND" });
      }
      let draft: Awaited<ReturnType<typeof applyWorkspaceOfflineDraft>>;
      try {
        draft = await applyWorkspaceOfflineDraft(db, {
          draftId: request.params.draftId,
          actorId: actor.id,
        });
      } catch (error) {
        return sendFabricError(reply, error);
      }
      await audit(
        db,
        request,
        "context_fabric.offline_draft.apply",
        "workspace_offline_draft",
        draft.id,
        {
          vaultId: session.vaultId,
          sessionId: session.id,
          status: draft.status,
        },
        session.spaceId,
      );
      return reply.code(draft.status === "APPLIED" ? 200 : 409).send(draft);
    },
  );

  app.post<{
    Params: { id: string };
    Body: { query?: string; intent?: string };
  }>(
    "/v1/sessions/:id/offline-snapshot",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const state = await workspaceSessionSnapshot(db, session.id, actor.id);
      if (!state) return reply.code(404).send({ code: "SESSION_NOT_FOUND" });
      const capturedAt = new Date();
      const pinnedAt = state.contextRevision.pinned?.pinnedAt ?? null;
      const sharedRevisionAgeSeconds = pinnedAt
        ? Math.max(
            0,
            Math.floor((capturedAt.getTime() - pinnedAt.getTime()) / 1000),
          )
        : null;
      if (
        state.contextRevision.status !== "CURRENT" ||
        !state.contextRevision.pinned
      ) {
        return reply.code(409).send({
          schemaVersion: 1,
          offline: true,
          capturedAt: capturedAt.toISOString(),
          stale: true,
          ageSeconds: sharedRevisionAgeSeconds,
          status: state.contextRevision.status,
          changedDimensions: state.contextRevision.changedDimensions,
          pinnedRevisionSetHash:
            state.contextRevision.pinned?.revisionSetHash ?? null,
          currentRevisionSetHash: state.contextRevision.current.revisionSetHash,
          mustRevalidateOnReconnect: true,
          context: null,
        });
      }
      const bootstrap = await app.inject({
        method: "POST",
        url: `/v1/sessions/${session.id}/bootstrap`,
        headers: {
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
          ...(request.headers["x-csrf-token"]
            ? { "x-csrf-token": String(request.headers["x-csrf-token"]) }
            : {}),
        },
        payload: {
          query: request.body?.query,
          intent: request.body?.intent,
          packetMode: "COMPACT_AGENT_PACKET",
        },
      });
      if (bootstrap.statusCode !== 200) {
        return reply.code(bootstrap.statusCode).send(bootstrap.json());
      }
      const context = bootstrap.json() as Record<string, unknown>;
      const serialized = JSON.stringify(context);
      return {
        schemaVersion: 1,
        offline: true,
        capturedAt: capturedAt.toISOString(),
        stale: false,
        ageSeconds: sharedRevisionAgeSeconds,
        status: "CURRENT",
        pinnedRevisionSetHash: state.contextRevision.pinned.revisionSetHash,
        currentRevisionSetHash: state.contextRevision.current.revisionSetHash,
        snapshotHash: createHash("sha256").update(serialized).digest("hex"),
        mustRevalidateOnReconnect: true,
        context,
      };
    },
  );

  app.get<{
    Params: { id: string };
    Querystring: { objectRefId?: string; limit?: string };
  }>(
    "/v1/sessions/:id/activity",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const objectRefId = request.query?.objectRefId?.trim();
      if (objectRefId && !UUID_PATTERN.test(objectRefId)) {
        return reply.code(400).send({ code: "INVALID_OBJECT_REF_ID" });
      }
      const limit = Number(request.query?.limit ?? 100);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
        return reply.code(400).send({ code: "INVALID_ACTIVITY_LIMIT" });
      }
      try {
        return {
          events: await listWorkActivityForSession(db, {
            sessionId: session.id,
            actorId: actor.id,
            ...(objectRefId ? { objectRefId } : {}),
            limit,
          }),
        };
      } catch (error) {
        return sendFabricError(reply, error);
      }
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      objectRefId?: string;
      targetRefId?: string;
      action?: string;
      occurredAt?: string;
      sourceSystem?: string;
      derivation?: string;
      relationKind?: string;
      actorExternalId?: string;
      evidenceRefs?: string[];
      payload?: Record<string, unknown>;
    };
  }>(
    "/v1/sessions/:id/activity",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(
        db,
        request,
        reply,
        request.params.id,
      );
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });

      const objectRefId = request.body?.objectRefId?.trim();
      const targetRefId = request.body?.targetRefId?.trim();
      if (!objectRefId || !UUID_PATTERN.test(objectRefId)) {
        return reply.code(400).send({ code: "INVALID_OBJECT_REF_ID" });
      }
      if (targetRefId && !UUID_PATTERN.test(targetRefId)) {
        return reply.code(400).send({ code: "INVALID_TARGET_REF_ID" });
      }
      const action = request.body?.action?.trim().toUpperCase();
      if (!action || !isWorkActivityAction(action)) {
        return reply.code(400).send({ code: "INVALID_WORK_ACTIVITY_ACTION" });
      }
      const derivation = request.body?.derivation?.trim().toUpperCase();
      if (!derivation || !isWorkActivityDerivation(derivation)) {
        return reply
          .code(400)
          .send({ code: "INVALID_WORK_ACTIVITY_DERIVATION" });
      }
      const requestedRelationKind = request.body?.relationKind
        ?.trim()
        .toUpperCase();
      if (
        requestedRelationKind &&
        !isWorkActivityRelationKind(requestedRelationKind)
      ) {
        return reply
          .code(400)
          .send({ code: "INVALID_WORK_ACTIVITY_RELATION_KIND" });
      }
      const relationKind =
        requestedRelationKind &&
        isWorkActivityRelationKind(requestedRelationKind)
          ? requestedRelationKind
          : undefined;
      const sourceSystem = safeText(request.body?.sourceSystem, 80);
      if (!sourceSystem) {
        return reply
          .code(400)
          .send({ code: "INVALID_WORK_ACTIVITY_SOURCE_SYSTEM" });
      }
      const occurredAt = new Date(request.body?.occurredAt ?? "");
      if (Number.isNaN(occurredAt.getTime())) {
        return reply
          .code(400)
          .send({ code: "INVALID_WORK_ACTIVITY_TIMESTAMP" });
      }
      const evidenceRefs = Array.isArray(request.body?.evidenceRefs)
        ? request.body.evidenceRefs.map((value) => String(value).trim())
        : [];
      if (evidenceRefs.length > 50 || evidenceRefs.some((value) => !value)) {
        return reply.code(400).send({ code: "INVALID_WORK_ACTIVITY_EVIDENCE" });
      }
      const payload = boundedObject(request.body?.payload ?? {});
      if (!payload) {
        return reply.code(400).send({ code: "INVALID_WORK_ACTIVITY_PAYLOAD" });
      }
      const actorExternalId = safeText(request.body?.actorExternalId, 512);

      let event: Awaited<ReturnType<typeof recordWorkActivity>>;
      try {
        event = await recordWorkActivity(db, {
          sessionId: session.id,
          actorId: actor.id,
          objectRefId,
          ...(targetRefId ? { targetRefId } : {}),
          action,
          occurredAt,
          sourceSystem,
          derivation,
          ...(relationKind ? { relationKind } : {}),
          // The recording principal is always attributed. An external actor id
          // from the source system is additional provenance, never a way to
          // record activity as somebody else.
          actorPrincipalId: actor.principalId,
          ...(actorExternalId ? { actorExternalId } : {}),
          evidenceRefs,
          payload,
        });
      } catch (error) {
        return sendFabricError(reply, error);
      }
      await audit(
        db,
        request,
        "context_fabric.work_activity.record",
        "work_activity_event",
        event.id,
        {
          vaultId: session.vaultId,
          sessionId: session.id,
          action: event.action,
          derivation: event.derivation,
          relationKind: event.relationKind,
          objectRefId: event.objectRefId,
          targetRefId: event.targetRefId,
        },
        session.spaceId,
      );
      return reply.code(201).send(event);
    },
  );

  app.post(
    "/v1/context-fabric/federation/query",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const requestedSchemaVersion = federationSchemaVersion(request.body);
      if (
        requestedSchemaVersion !== null &&
        requestedSchemaVersion !== 1
      ) {
        return reply.code(409).send({
          code: "FEDERATION_SCHEMA_VERSION_UNSUPPORTED",
          supportedSchemaVersions: [1],
        });
      }
      const parsed = FederationRemoteQueryRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_FEDERATION_QUERY",
          issues: parsed.error.issues,
        });
      }
      const claim = await readContextFabricNodeClaim(db);
      if (!claim || claim.deploymentMode !== "FEDERATED_ORG") {
        return reply
          .code(409)
          .send({ code: "FEDERATION_REMOTE_QUERY_DISABLED" });
      }
      if (parsed.data.caller.nodeId === claim.nodeId) {
        return reply.code(409).send({ code: "FEDERATION_SELF_QUERY_DENIED" });
      }

      const startedAt = Date.now();
      const search = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers: {
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
          ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
          ...(request.headers["x-csrf-token"]
            ? { "x-csrf-token": String(request.headers["x-csrf-token"]) }
            : {}),
        },
        payload: {
          ...parsed.data.request,
          spaceId: parsed.data.scope.spaceId,
          vaultIds: parsed.data.scope.vaultIds,
          federated: false,
          limit: parsed.data.budget.maxResults,
        },
      });
      if (search.statusCode !== 200) {
        const body = search.json() as { code?: unknown };
        return reply.code(search.statusCode).send({
          code:
            typeof body.code === "string"
              ? body.code
              : "FEDERATION_REMOTE_SEARCH_FAILED",
        });
      }
      const searchBody = search.json() as Record<string, unknown>;
      const effectiveScope =
        searchBody.scope &&
        typeof searchBody.scope === "object" &&
        !Array.isArray(searchBody.scope)
          ? (searchBody.scope as Record<string, unknown>)
          : {};
      const effectiveSpaceId = String(effectiveScope.spaceId ?? "");
      const effectiveVaultIds = Array.isArray(effectiveScope.vaultIds)
        ? effectiveScope.vaultIds.map(String)
        : [];
      if (
        effectiveSpaceId !== parsed.data.scope.spaceId ||
        !sameStringSet(effectiveVaultIds, parsed.data.scope.vaultIds)
      ) {
        return reply
          .code(403)
          .send({ code: "FEDERATION_SCOPE_NEGOTIATION_FAILED" });
      }

      if (parsed.data.revisionPreferences.length) {
        const revisions = await db.pool.query<{
          vault_id: string;
          corpus_revision: string;
        }>(
          `select vault_id,corpus_revision
             from vault_index_revisions
            where space_id=$1 and vault_id=any($2::uuid[])`,
          [parsed.data.scope.spaceId, parsed.data.scope.vaultIds],
        );
        const byVault = new Map(
          revisions.rows.map((row) => [row.vault_id, row.corpus_revision]),
        );
        const mismatch = parsed.data.revisionPreferences.some(
          (preference) =>
            byVault.get(preference.vaultId) !== preference.corpusRevision,
        );
        if (mismatch) {
          return reply
            .code(409)
            .send({ code: "FEDERATION_REVISION_UNAVAILABLE" });
        }
      }

      const localHits = Array.isArray(searchBody.hits)
        ? searchBody.hits.map((hit) => SearchHit.parse(hit))
        : [];
      const nodeRevision = process.env.AKP_BUILD_REVISION?.trim() || null;
      const remoteHits = localHits.map((hit) => ({
        ...hit,
        remoteProvenance: {
          nodeId: claim.nodeId,
          nodeRevision,
          documentRevision: hit.revision,
          trust: hit.trust,
          lifecycle: hit.lifecycle,
        },
      }));
      const searchWarnings = Array.isArray(searchBody.warnings)
        ? searchBody.warnings.filter(
            (warning): warning is string => typeof warning === "string",
          )
        : [];
      const elapsedMs = Date.now() - startedAt;
      const warnings = new Set(searchWarnings);
      const wallBudgetExceeded = elapsedMs > parsed.data.budget.maxWallMs;
      if (wallBudgetExceeded) {
        warnings.add("FEDERATION_WALL_BUDGET_EXCEEDED");
      }
      const stale =
        remoteHits.some((hit) => hit.refreshStatus !== "CURRENT") ||
        [...warnings].some((warning) => warning.includes("STALE"));
      const responseValue = FederationRemoteQueryResponse.parse({
        schemaVersion: 1,
        requestId: parsed.data.caller.requestId,
        remote: {
          nodeId: claim.nodeId,
          deploymentMode: claim.deploymentMode,
          revision: nodeRevision,
        },
        scope: {
          spaceId: effectiveSpaceId,
          vaultIds: effectiveVaultIds,
        },
        partial: Boolean(searchBody.degraded) || wallBudgetExceeded,
        stale,
        warnings: [...warnings].slice(0, 100),
        indexRevisions:
          searchBody.indexRevisions &&
          typeof searchBody.indexRevisions === "object" &&
          !Array.isArray(searchBody.indexRevisions)
            ? searchBody.indexRevisions
            : {},
        hits: remoteHits,
        noAnswer: searchBody.noAnswer ?? null,
      });
      const bounded = boundedFederationResponse(
        responseValue,
        parsed.data.budget.maxResponseBytes,
      );
      if (!bounded) {
        return reply
          .code(422)
          .send({ code: "FEDERATION_RESPONSE_BUDGET_TOO_SMALL" });
      }
      await audit(
        db,
        request,
        "context_fabric.remote_query.serve",
        "context_fabric_node",
        claim.nodeId,
        {
          callerNodeId: parsed.data.caller.nodeId,
          requestId: parsed.data.caller.requestId,
          spaceId: parsed.data.scope.spaceId,
          vaultCount: parsed.data.scope.vaultIds.length,
          resultCount: bounded.hits.length,
          partial: bounded.partial,
          stale: bounded.stale,
        },
        parsed.data.scope.spaceId,
      );
      return bounded;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/context-fabric/peers/:id/query",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.id)) {
        return reply.code(404).send({ code: "FEDERATION_PEER_NOT_FOUND" });
      }
      const parsed = FederationPeerQueryRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_FEDERATION_PEER_QUERY",
          issues: parsed.error.issues,
        });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const claim = await readContextFabricNodeClaim(db);
      if (!claim || claim.deploymentMode !== "FEDERATED_ORG") {
        return reply
          .code(409)
          .send({ code: "FEDERATION_REMOTE_QUERY_DISABLED" });
      }
      const allowedSpaces = unrestrictedSpaceIdsForPermission(
        actor,
        "knowledge:read",
      );
      const peer = await getContextFabricPeerRuntime(
        db,
        request.params.id,
        allowedSpaces,
      );
      if (!peer) {
        return reply.code(404).send({ code: "FEDERATION_PEER_NOT_FOUND" });
      }
      if (
        peer.trustState !== "APPROVED" ||
        peer.discoveryMode !== "REMOTE_QUERY"
      ) {
        return reply.code(409).send({ code: "FEDERATION_PEER_NOT_QUERYABLE" });
      }
      if (
        peer.circuitOpenUntil &&
        peer.circuitOpenUntil.getTime() > Date.now()
      ) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((peer.circuitOpenUntil.getTime() - Date.now()) / 1_000),
        );
        reply.header("retry-after", String(retryAfterSeconds));
        return reply.code(503).send({
          code: "FEDERATION_PEER_CIRCUIT_OPEN",
          retryAfterSeconds,
        });
      }
      if (!peer.endpoint || !peer.credentialRef) {
        return reply
          .code(503)
          .send({ code: "FEDERATION_PEER_CONFIGURATION_INCOMPLETE" });
      }
      const endpoint = normalizeFederationEndpoint(peer.endpoint);
      const token = process.env[peer.credentialRef]?.trim();
      if (!endpoint || !token) {
        return reply
          .code(503)
          .send({ code: "FEDERATION_PEER_CREDENTIAL_UNAVAILABLE" });
      }

      const requestId = parsed.data.requestId ?? randomUUID();
      const remoteRequest = FederationRemoteQueryRequest.parse({
        schemaVersion: 1,
        caller: { nodeId: claim.nodeId, requestId },
        scope: parsed.data.scope,
        request: parsed.data.request,
        budget: parsed.data.budget,
        revisionPreferences: parsed.data.revisionPreferences,
      });
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        remoteRequest.budget.maxWallMs,
      );
      let remoteResponse: Response;
      try {
        remoteResponse = await fetch(
          `${endpoint}/v1/context-fabric/federation/query`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(remoteRequest),
            signal: controller.signal,
          },
        );
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          await markContextFabricPeerQueryFailure(
            db,
            peer.id,
            "FEDERATION_PEER_TIMEOUT",
          );
          return reply.code(504).send({ code: "FEDERATION_PEER_TIMEOUT" });
        }
        await markContextFabricPeerQueryFailure(
          db,
          peer.id,
          "FEDERATION_PEER_UNAVAILABLE",
        );
        return reply.code(502).send({ code: "FEDERATION_PEER_UNAVAILABLE" });
      } finally {
        clearTimeout(timeout);
      }

      if (!remoteResponse.ok) {
        await remoteResponse.body?.cancel().catch(() => undefined);
        await markContextFabricPeerQueryFailure(
          db,
          peer.id,
          "FEDERATION_PEER_HTTP_ERROR",
        );
        return reply.code(502).send({
          code: `FEDERATION_PEER_HTTP_${remoteResponse.status}`,
        });
      }

      let remoteBody: unknown;
      try {
        remoteBody = await readBoundedFederationJson(
          remoteResponse,
          remoteRequest.budget.maxResponseBytes,
        );
      } catch (error) {
        const code =
          error instanceof Error &&
          /^FEDERATION_RESPONSE_[A-Z_]+$/.test(error.message)
            ? error.message
            : "FEDERATION_RESPONSE_INVALID";
        await markContextFabricPeerQueryFailure(
          db,
          peer.id,
          "FEDERATION_RESPONSE_INVALID",
        );
        return reply.code(502).send({ code });
      }
      const remoteSchemaVersion = federationSchemaVersion(remoteBody);
      if (remoteSchemaVersion !== null && remoteSchemaVersion !== 1) {
        await markContextFabricPeerQueryFailure(
          db,
          peer.id,
          "FEDERATION_PEER_SCHEMA_UNSUPPORTED",
        );
        return reply.code(502).send({
          code: "FEDERATION_PEER_SCHEMA_UNSUPPORTED",
          supportedSchemaVersions: [1],
        });
      }
      const parsedRemote = FederationRemoteQueryResponse.safeParse(remoteBody);
      if (!parsedRemote.success) {
        await markContextFabricPeerQueryFailure(
          db,
          peer.id,
          "FEDERATION_RESPONSE_SCHEMA_INVALID",
        );
        return reply
          .code(502)
          .send({ code: "FEDERATION_RESPONSE_SCHEMA_INVALID" });
      }
      if (
        parsedRemote.data.requestId !== requestId ||
        parsedRemote.data.remote.nodeId !== peer.peerKey ||
        parsedRemote.data.scope.spaceId !== remoteRequest.scope.spaceId ||
        !sameStringSet(
          parsedRemote.data.scope.vaultIds,
          remoteRequest.scope.vaultIds,
        )
      ) {
        await markContextFabricPeerQueryFailure(
          db,
          peer.id,
          "FEDERATION_PEER_IDENTITY_MISMATCH",
        );
        return reply
          .code(502)
          .send({ code: "FEDERATION_PEER_IDENTITY_MISMATCH" });
      }

      await markContextFabricPeerQuerySuccess(db, peer.id);
      let result = parsedRemote.data;
      if (
        peer.revision &&
        result.remote.revision &&
        peer.revision !== result.remote.revision
      ) {
        result = FederationRemoteQueryResponse.parse({
          ...result,
          stale: true,
          warnings: [
            ...new Set([
              ...result.warnings,
              "FEDERATION_PEER_REVISION_CHANGED",
            ]),
          ],
        });
      }
      await audit(
        db,
        request,
        "context_fabric.remote_query.call",
        "context_fabric_peer",
        peer.id,
        {
          peerKey: peer.peerKey,
          requestId,
          spaceId: result.scope.spaceId,
          vaultCount: result.scope.vaultIds.length,
          resultCount: result.hits.length,
          partial: result.partial,
          stale: result.stale,
          remoteRevision: result.remote.revision,
        },
        peer.spaceId ?? undefined,
      );
      return result;
    },
  );

  app.post(
    "/v1/context-fabric/federation/fanout",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const parsed = FederationFanoutRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_FEDERATION_FANOUT",
          issues: parsed.error.issues,
        });
      }
      const forwardedHeaders = {
        ...(request.headers.authorization
          ? { authorization: request.headers.authorization }
          : {}),
        ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
        ...(request.headers["x-csrf-token"]
          ? { "x-csrf-token": String(request.headers["x-csrf-token"]) }
          : {}),
      };
      const local = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers: forwardedHeaders,
        payload: { ...parsed.data.local, federated: false },
      });
      if (local.statusCode !== 200) {
        const body = local.json() as { code?: unknown };
        return reply.code(local.statusCode).send({
          code:
            typeof body.code === "string"
              ? body.code
              : "FEDERATION_LOCAL_SEARCH_FAILED",
        });
      }
      const localBody = local.json() as Record<string, unknown>;

      const remoteAttempts = await Promise.all(
        parsed.data.peers.map(async (peerRequest) => {
          const response = await app.inject({
            method: "POST",
            url: `/v1/context-fabric/peers/${peerRequest.peerId}/query`,
            headers: forwardedHeaders,
            payload: peerRequest.query,
          });
          if (response.statusCode !== 200) {
            const body = response.json() as { code?: unknown };
            return {
              ok: false as const,
              peerId: peerRequest.peerId,
              code:
                typeof body.code === "string" &&
                /^[A-Z][A-Z0-9_]*$/.test(body.code)
                  ? body.code
                  : "FEDERATION_PEER_FAILED",
            };
          }
          const parsedRemote = FederationRemoteQueryResponse.safeParse(
            response.json(),
          );
          if (!parsedRemote.success) {
            return {
              ok: false as const,
              peerId: peerRequest.peerId,
              code: "FEDERATION_RESPONSE_SCHEMA_INVALID",
            };
          }
          return {
            ok: true as const,
            peerId: peerRequest.peerId,
            response: parsedRemote.data,
          };
        }),
      );

      const remotes = remoteAttempts.flatMap((attempt) =>
        attempt.ok
          ? [{ peerId: attempt.peerId, response: attempt.response }]
          : [],
      );
      const failures = remoteAttempts.flatMap((attempt) =>
        attempt.ok ? [] : [{ peerId: attempt.peerId, code: attempt.code }],
      );
      if (parsed.data.requireAllPeers && failures.length) {
        return reply.code(502).send({
          code: "FEDERATION_REQUIRED_PEER_FAILED",
          failures,
        });
      }
      const warnings = [
        ...failures.map(
          (failure) =>
            `FEDERATION_PEER_FAILED:${failure.peerId}:${failure.code}`,
        ),
        ...remotes.flatMap((remote) =>
          remote.response.partial
            ? [`FEDERATION_PEER_PARTIAL:${remote.peerId}`]
            : [],
        ),
      ].slice(0, 100);
      const result = FederationFanoutResponse.parse({
        schemaVersion: 1,
        local: localBody,
        remotes,
        failures,
        partial:
          Boolean(localBody.degraded) ||
          failures.length > 0 ||
          remotes.some((remote) => remote.response.partial),
        warnings,
      });
      await audit(
        db,
        request,
        "context_fabric.federation.fanout",
        "context_fabric",
        "fanout",
        {
          localSpaceId: parsed.data.local.spaceId,
          peerCount: parsed.data.peers.length,
          successCount: remotes.length,
          failureCount: failures.length,
          requireAllPeers: parsed.data.requireAllPeers,
          partial: result.partial,
        },
        parsed.data.local.spaceId,
      );
      return result;
    },
  );

  app.get<{ Querystring: { spaceId?: string; vaultId?: string } }>(
    "/v1/context-fabric/peers",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const allowedSpaces = unrestrictedSpaceIdsForPermission(
        actor,
        "knowledge:read",
      );
      const requestedSpace = request.query.spaceId?.trim();
      const spaces = requestedSpace
        ? allowedSpaces.filter((spaceId) => spaceId === requestedSpace)
        : allowedSpaces;
      if (!spaces.length) {
        return reply.code(403).send({ code: "SPACE_SCOPE_DENIED" });
      }
      const organization = await db.pool.query<{ organization_id: string }>(
        "select organization_id from spaces where id=$1",
        [spaces[0]],
      );
      const organizationId = organization.rows[0]?.organization_id;
      if (!organizationId) {
        return reply.code(404).send({ code: "ORGANIZATION_NOT_FOUND" });
      }
      const peers = await listContextFabricPeers(db, organizationId, spaces);
      const vaultId = request.query.vaultId?.trim();
      let policy: {
        vaultId: string;
        profileId: string;
        version: string;
        revisionId: string | null;
        connectorPolicy:
          typeof DEFAULT_KNOWLEDGE_PROFILE_V1.connectorPolicy | undefined;
      } | null = null;
      if (vaultId) {
        if (!UUID_PATTERN.test(vaultId)) {
          return reply.code(400).send({ code: "INVALID_VAULT_ID" });
        }
        const vault = await db.pool.query<{ space_id: string }>(
          "select space_id from vaults where id=$1 and enabled=true",
          [vaultId],
        );
        const vaultSpaceId = vault.rows[0]?.space_id;
        if (!vaultSpaceId || !spaces.includes(vaultSpaceId)) {
          return reply.code(404).send({ code: "VAULT_NOT_FOUND" });
        }
        const active = await getActiveKnowledgeProfileRevision(
          db,
          vaultSpaceId,
          vaultId,
        );
        const profile = active
          ? KnowledgeProfileV1.parse(active.profile)
          : DEFAULT_KNOWLEDGE_PROFILE_V1;
        policy = {
          vaultId,
          profileId: profile.profileId,
          version: profile.version,
          revisionId: active?.id ?? null,
          connectorPolicy: profile.connectorPolicy,
        };
      }
      return {
        peers: peers.map((peer) => {
          const capabilities = ConnectorCapabilities.parse(peer.capabilities);
          return {
            ...peer,
            capabilities,
            readPlan: connectorReadPlan(capabilities),
            compatibility: policy?.connectorPolicy
              ? evaluateConnectorCapabilities(
                  capabilities,
                  policy.connectorPolicy,
                )
              : null,
          };
        }),
        policy: policy
          ? {
              vaultId: policy.vaultId,
              profileId: policy.profileId,
              version: policy.version,
              revisionId: policy.revisionId,
              evaluated: policy.connectorPolicy !== undefined,
            }
          : null,
        boundary: "DISCOVERY_METADATA_ONLY",
      };
    },
  );

  app.post<{
    Body: {
      spaceId?: string;
      peerKey?: string;
      displayName?: string;
      endpoint?: string;
      discoveryMode?: string;
      trustState?: string;
      capabilities?: unknown;
      revision?: string;
      credentialRef?: string;
    };
  }>(
    "/v1/context-fabric/peers",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const spaceId = safeText(request.body?.spaceId, 36);
      const peerKey = safeText(request.body?.peerKey, 128);
      const displayName = safeText(request.body?.displayName, 200);
      const discoveryMode = request.body?.discoveryMode ?? "CATALOG_ONLY";
      const trustState = request.body?.trustState ?? "DISCOVERED";
      const credentialRef = request.body?.credentialRef?.trim() || null;
      const endpointSupplied =
        typeof request.body?.endpoint === "string" &&
        request.body.endpoint.trim().length > 0;
      const endpoint = endpointSupplied
        ? normalizeFederationEndpoint(request.body?.endpoint)
        : null;
      const rawCapabilities = boundedObject(
        request.body?.capabilities,
        32 * 1024,
      );
      const parsedCapabilities = rawCapabilities
        ? ConnectorCapabilities.safeParse(rawCapabilities)
        : null;
      if (
        !spaceId ||
        !peerKey ||
        !displayName ||
        !DISCOVERY_MODES.has(discoveryMode) ||
        !PEER_TRUST_STATES.has(trustState) ||
        (endpointSupplied && !endpoint) ||
        (credentialRef !== null &&
          !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(credentialRef)) ||
        !parsedCapabilities?.success
      ) {
        return reply.code(400).send({
          code:
            parsedCapabilities?.success === false
              ? "INVALID_CONNECTOR_CAPABILITIES"
              : "INVALID_CONTEXT_FABRIC_PEER",
        });
      }
      const capabilities = parsedCapabilities.data;
      if (
        !unrestrictedSpaceIdsForPermission(actor, "admin").includes(spaceId)
      ) {
        return reply.code(403).send({ code: "SPACE_SCOPE_DENIED" });
      }
      const organization = await db.pool.query<{ organization_id: string }>(
        "select organization_id from spaces where id=$1",
        [spaceId],
      );
      const organizationId = organization.rows[0]?.organization_id;
      if (!organizationId) {
        return reply.code(404).send({ code: "ORGANIZATION_NOT_FOUND" });
      }
      const peer = await upsertContextFabricPeer(db, {
        organizationId,
        spaceId,
        peerKey,
        displayName,
        endpoint,
        discoveryMode: discoveryMode as
          "CATALOG_ONLY" | "REMOTE_QUERY" | "MIRROR_BUNDLE",
        trustState: trustState as "DISCOVERED" | "APPROVED" | "DISABLED",
        capabilities,
        revision: request.body?.revision ?? null,
        credentialRef,
        lastSeenAt: new Date(),
      });
      await audit(
        db,
        request,
        "context_fabric.peer.upsert",
        "context_fabric_peer",
        peer.id,
        { spaceId, peerKey, discoveryMode, trustState },
        spaceId,
      );
      const persistedCapabilities = ConnectorCapabilities.parse(
        peer.capabilities,
      );
      return reply.code(201).send({
        peer: { ...peer, capabilities: persistedCapabilities },
        readPlan: connectorReadPlan(persistedCapabilities),
        boundary: "DISCOVERY_METADATA_ONLY",
        networkContactPerformed: false,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/context-fabric/peers/:id/revoke",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.id)) {
        return reply.code(404).send({ code: "FEDERATION_PEER_NOT_FOUND" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const allowedSpaces = unrestrictedSpaceIdsForPermission(actor, "admin");
      const peer = await getContextFabricPeerRuntime(
        db,
        request.params.id,
        allowedSpaces,
      );
      if (!peer) {
        return reply.code(404).send({ code: "FEDERATION_PEER_NOT_FOUND" });
      }
      const revoked = await revokeContextFabricPeer(db, peer.id);
      await audit(
        db,
        request,
        "context_fabric.peer.revoke",
        "context_fabric_peer",
        peer.id,
        {
          peerKey: peer.peerKey,
          previousTrustState: peer.trustState,
          trustState: "DISABLED",
        },
        peer.spaceId ?? undefined,
      );
      return {
        revoked: true,
        peer: revoked,
      };
    },
  );
}
