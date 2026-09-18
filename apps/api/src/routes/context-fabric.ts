import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
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
  listContextFabricPeers,
  listExternalObjectRefsForSession,
  isWorkActivityAction,
  isWorkObjectClass,
  isWorkActivityDerivation,
  listWorkActivityForSession,
  listWorkspaceOfflineDrafts,
  recordWorkActivity,
  queueWorkspaceOfflineDraft,
  readContextFabricNodeClaim,
  resolveAuthorizedVaultScope,
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
      return {
        schemaVersion: 1,
        deploymentMode,
        node: {
          id:
            claim?.nodeId ??
            (process.env.AKP_CONTEXT_FABRIC_NODE_ID?.trim() ||
              "local-context-node"),
          claimed: claim !== null,
          claimedAt: claim?.claimedAt.toISOString() ?? null,
          adoptedFrom: claim?.adoptedFrom ?? null,
          sharedDerivedState:
            claim !== null &&
            (claim.deploymentMode === "TEAM_NODE" ||
              claim.deploymentMode === "FEDERATED_ORG"),
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
          federationRemoteQuery: false,
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
      if (!provider || !objectType || !externalId || !metadata) {
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
      const capturedAt = new Date().toISOString();
      if (
        state.contextRevision.status !== "CURRENT" ||
        !state.contextRevision.pinned
      ) {
        return reply.code(409).send({
          schemaVersion: 1,
          capturedAt,
          stale: true,
          ageSeconds: 0,
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
        capturedAt,
        stale: false,
        ageSeconds: 0,
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
          objectRefId: event.objectRefId,
          targetRefId: event.targetRefId,
        },
        session.spaceId,
      );
      return reply.code(201).send(event);
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
        endpoint: request.body?.endpoint ?? null,
        discoveryMode: discoveryMode as
          "CATALOG_ONLY" | "REMOTE_QUERY" | "MIRROR_BUNDLE",
        trustState: trustState as "DISCOVERED" | "APPROVED" | "DISABLED",
        capabilities,
        revision: request.body?.revision ?? null,
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
}
