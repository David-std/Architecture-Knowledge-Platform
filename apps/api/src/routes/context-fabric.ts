import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  applyWorkspaceOfflineDraft,
  getWorkspaceSessionForParticipant,
  listContextFabricPeers,
  listExternalObjectRefsForSession,
  listWorkspaceOfflineDrafts,
  queueWorkspaceOfflineDraft,
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
      const deploymentMode =
        process.env.AKP_CONTEXT_FABRIC_MODE?.trim() || "SOLO_LOCAL";
      return {
        schemaVersion: 1,
        deploymentMode,
        node: {
          id:
            process.env.AKP_CONTEXT_FABRIC_NODE_ID?.trim() ||
            "local-context-node",
          sharedDerivedState:
            deploymentMode === "TEAM_NODE" ||
            deploymentMode === "FEDERATED_ORG",
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
            | "FINDING"
            | "ARTIFACT"
            | "DECISION_CANDIDATE"
            | "NOTE",
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

  app.get<{ Querystring: { spaceId?: string } }>(
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
      return {
        peers: await listContextFabricPeers(db, organizationId, spaces),
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
      capabilities?: Record<string, unknown>;
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
      const capabilities = boundedObject(
        request.body?.capabilities ?? {},
        32 * 1024,
      );
      if (
        !spaceId ||
        !peerKey ||
        !displayName ||
        !DISCOVERY_MODES.has(discoveryMode) ||
        !PEER_TRUST_STATES.has(trustState) ||
        !capabilities
      ) {
        return reply.code(400).send({ code: "INVALID_CONTEXT_FABRIC_PEER" });
      }
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
      return reply.code(201).send({
        peer,
        boundary: "DISCOVERY_METADATA_ONLY",
        networkContactPerformed: false,
      });
    },
  );
}
