import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  addWorkspaceParticipant,
  appendWorkspaceEvent,
  claimWorkspaceWork,
  createWorkspaceSession,
  getWorkspaceSessionForParticipant,
  handoffWorkspaceWork,
  listWorkspaceSessionsForParticipant,
  resolveAuthorizedVaultScope,
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

const WORK_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const USER_EVENT_TYPES = new Set([
  "FINDING",
  "BLOCKER",
  "QUESTION",
  "ARTIFACT",
  "DECISION_CANDIDATE",
  "NOTE",
]);

function boundedLeaseSeconds(value: unknown): number | null {
  const candidate = Number(value ?? 120);
  if (!Number.isInteger(candidate) || candidate < 15 || candidate > 900) {
    return null;
  }
  return candidate;
}

function boundedEventPayload(
  value: unknown,
): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) return null;
  return value as Record<string, unknown>;
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
    await reply.code(404).send({ code: "SESSION_NOT_FOUND" });
    return null;
  }
  return session;
}

async function userHasFullVaultRead(
  db: Postgres,
  userId: string,
  session: WorkspaceSessionAccess,
): Promise<boolean> {
  try {
    const scope = await resolveAuthorizedVaultScope(db, {
      userId,
      spaceId: session.spaceId,
      permission: "knowledge:read",
      vaultId: session.vaultId,
      vaultIds: [session.vaultId],
      federated: false,
    });
    return scope.accessByVault[session.vaultId]?.pathPrefix === null;
  } catch {
    return false;
  }
}

export function registerSessionRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.get(
    "/v1/sessions",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const actor = actorOf(request);
      const spaces = unrestrictedSpaceIdsForPermission(actor, "knowledge:read");
      if (!spaces.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const vaultIds: string[] = [];
      for (const spaceId of spaces) {
        try {
          const scope = await resolveAuthorizedVaultScope(db, {
            userId: actor.id,
            spaceId,
            permission: "knowledge:read",
            federated: true,
          });
          for (const vaultId of scope.vaultIds) {
            // Sessions are pathless context containers. A prefix grant cannot
            // safely authorize the whole session record.
            if (scope.accessByVault[vaultId]?.pathPrefix === null) {
              vaultIds.push(vaultId);
            }
          }
        } catch {
          // No visible vault in this otherwise authorized space.
        }
      }
      if (!vaultIds.length) return { sessions: [] };
      const sessions = await listWorkspaceSessionsForParticipant(
        db,
        actor.id,
        spaces,
        [...new Set(vaultIds)],
      );
      return { sessions };
    },
  );

  app.post<{
    Body: {
      purpose: string;
      contextBudget?: number;
      projectId?: string;
      spaceId: string;
      vaultId: string;
    };
  }>(
    "/v1/sessions",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      if (!request.body?.purpose?.trim()) {
        return reply.code(400).send({ code: "SESSION_PURPOSE_REQUIRED" });
      }
      const actor = actorOf(request);
      const budget = Math.max(
        256,
        Math.min(Number(request.body.contextBudget ?? 6000), 32000),
      );
      const spaceId = request.body.spaceId;
      const vaultId = request.body.vaultId;
      if (!spaceId || !vaultId) {
        return reply.code(400).send({ code: "VAULT_SCOPE_REQUIRED" });
      }
      if (
        !unrestrictedSpaceIdsForPermission(actor, "knowledge:read").includes(
          spaceId,
        )
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      try {
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId,
          permission: "knowledge:read",
          vaultId,
          vaultIds: [vaultId],
          federated: false,
        });
        if (scope.accessByVault[vaultId]?.pathPrefix !== null) {
          return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
        }
      } catch (error) {
        return reply.code(403).send({
          code: error instanceof Error ? error.message : "VAULT_ACCESS_DENIED",
        });
      }
      if (request.body.projectId) {
        const project = await db.pool.query(
          `select id from projects
             where id=$1 and space_id=$2 and vault_id=$3`,
          [request.body.projectId, spaceId, vaultId],
        );
        if (!project.rowCount) {
          return reply.code(404).send({ code: "PROJECT_NOT_FOUND" });
        }
      }
      const session = await createWorkspaceSession(db, {
        spaceId,
        vaultId,
        actorId: actor.id,
        projectId: request.body.projectId,
        purpose: request.body.purpose.trim(),
        contextBudget: budget,
      });
      await audit(
        db,
        request,
        "agent_session.create",
        "agent_session",
        session.id,
        { vaultId },
        spaceId,
      );
      return reply.code(201).send(session);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id/state",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(db, request, reply, request.params.id);
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const snapshot = await workspaceSessionSnapshot(
        db,
        session.id,
        actor.id,
      );
      if (!snapshot) return reply.code(404).send({ code: "SESSION_NOT_FOUND" });
      return snapshot;
    },
  );

  app.post<{
    Params: { id: string };
    Body: { userId: string };
  }>(
    "/v1/sessions/:id/participants",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(db, request, reply, request.params.id);
      if (!session) return;
      if (session.role !== "OWNER") {
        return reply
          .code(403)
          .send({ code: "WORKSPACE_SESSION_OWNER_REQUIRED" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const userId = request.body?.userId?.trim();
      if (!userId) {
        return reply.code(400).send({ code: "PARTICIPANT_USER_REQUIRED" });
      }
      if (!(await userHasFullVaultRead(db, userId, session))) {
        return reply
          .code(422)
          .send({ code: "PARTICIPANT_NOT_AUTHORIZED" });
      }
      await addWorkspaceParticipant(db, {
        sessionId: session.id,
        actorId: actor.id,
        userId,
      });
      await audit(
        db,
        request,
        "workspace.participant.add",
        "agent_session",
        session.id,
        { vaultId: session.vaultId, userId },
        session.spaceId,
      );
      return reply.code(201).send({ sessionId: session.id, userId });
    },
  );

  app.post<{
    Params: { id: string };
    Body: { workKey: string; leaseSeconds?: number };
  }>(
    "/v1/sessions/:id/claims",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(db, request, reply, request.params.id);
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const workKey = request.body?.workKey?.trim();
      if (!workKey || !WORK_KEY_PATTERN.test(workKey)) {
        return reply.code(400).send({ code: "INVALID_WORK_KEY" });
      }
      const leaseSeconds = boundedLeaseSeconds(request.body.leaseSeconds);
      if (!leaseSeconds) {
        return reply.code(400).send({ code: "INVALID_CLAIM_LEASE" });
      }
      const claim = await claimWorkspaceWork(db, {
        sessionId: session.id,
        actorId: actor.id,
        workKey,
        leaseSeconds,
      });
      await audit(
        db,
        request,
        "workspace.claim.acquire",
        "agent_session",
        session.id,
        {
          vaultId: session.vaultId,
          claimId: claim.id,
          workKey,
          fencingToken: claim.fencingToken,
        },
        session.spaceId,
      );
      return reply.code(201).send(claim);
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      workKey: string;
      toUserId: string;
      fencingToken: number;
      leaseSeconds?: number;
      note?: string;
    };
  }>(
    "/v1/sessions/:id/claims/handoff",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(db, request, reply, request.params.id);
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const workKey = request.body?.workKey?.trim();
      const toUserId = request.body?.toUserId?.trim();
      if (!workKey || !WORK_KEY_PATTERN.test(workKey) || !toUserId) {
        return reply.code(400).send({ code: "INVALID_WORK_HANDOFF" });
      }
      const fencingToken = Number(request.body.fencingToken);
      if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
        return reply.code(400).send({ code: "INVALID_FENCING_TOKEN" });
      }
      const leaseSeconds = boundedLeaseSeconds(request.body.leaseSeconds);
      if (!leaseSeconds) {
        return reply.code(400).send({ code: "INVALID_CLAIM_LEASE" });
      }
      const note = request.body.note?.trim();
      if (note && Buffer.byteLength(note, "utf8") > 2048) {
        return reply.code(413).send({ code: "HANDOFF_NOTE_TOO_LARGE" });
      }
      const claim = await handoffWorkspaceWork(db, {
        sessionId: session.id,
        actorId: actor.id,
        workKey,
        toUserId,
        fencingToken,
        leaseSeconds,
        ...(note ? { note } : {}),
      });
      await audit(
        db,
        request,
        "workspace.claim.handoff",
        "agent_session",
        session.id,
        {
          vaultId: session.vaultId,
          claimId: claim.id,
          workKey,
          toUserId,
          fencingToken: claim.fencingToken,
        },
        session.spaceId,
      );
      return claim;
    },
  );

  app.post<{
    Params: { id: string };
    Body: { eventType: string; payload?: Record<string, unknown> };
  }>(
    "/v1/sessions/:id/events",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const session = await authorizedSession(db, request, reply, request.params.id);
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const eventType = request.body?.eventType?.trim().toUpperCase();
      if (!eventType || !USER_EVENT_TYPES.has(eventType)) {
        return reply.code(400).send({ code: "INVALID_WORKSPACE_EVENT_TYPE" });
      }
      const payload = boundedEventPayload(request.body?.payload ?? {});
      if (!payload) {
        return reply.code(413).send({ code: "WORKSPACE_EVENT_PAYLOAD_INVALID" });
      }
      const event = await appendWorkspaceEvent(db, {
        sessionId: session.id,
        actorId: actor.id,
        eventType: eventType as
          | "FINDING"
          | "BLOCKER"
          | "QUESTION"
          | "ARTIFACT"
          | "DECISION_CANDIDATE"
          | "NOTE",
        payload,
      });
      await audit(
        db,
        request,
        "workspace.event.append",
        "agent_session",
        session.id,
        {
          vaultId: session.vaultId,
          eventId: event.id,
          eventType,
        },
        session.spaceId,
      );
      return reply.code(201).send(event);
    },
  );
}
