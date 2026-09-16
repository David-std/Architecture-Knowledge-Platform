import type { FastifyInstance } from "fastify";
import {
  getWorkspaceSessionForParticipant,
  heartbeatWorkspacePresence,
  listWorkspacePresence,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import { actorOf, audit, requirePermission } from "../auth.js";

async function ensureAuthorizedSession(
  db: Postgres,
  actorId: string,
  sessionId: string,
): Promise<{ spaceId: string; vaultId: string } | null> {
  const session = await getWorkspaceSessionForParticipant(
    db,
    sessionId,
    actorId,
  );
  if (!session) return null;
  try {
    const scope = await resolveAuthorizedVaultScope(db, {
      userId: actorId,
      spaceId: session.spaceId,
      permission: "knowledge:read",
      vaultId: session.vaultId,
      vaultIds: [session.vaultId],
      federated: false,
    });
    if (scope.accessByVault[session.vaultId]?.pathPrefix !== null) return null;
  } catch {
    return null;
  }
  return { spaceId: session.spaceId, vaultId: session.vaultId };
}

export function registerWorkspacePresenceRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.get<{ Params: { id: string } }>(
    "/v1/sessions/:id/presence",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const scope = await ensureAuthorizedSession(
        db,
        actor.id,
        request.params.id,
      );
      if (!scope) return reply.code(404).send({ code: "SESSION_NOT_FOUND" });
      return {
        sessionId: request.params.id,
        participants: await listWorkspacePresence(
          db,
          request.params.id,
          actor.id,
        ),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { ttlSeconds?: number } }>(
    "/v1/sessions/:id/presence/heartbeat",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const scope = await ensureAuthorizedSession(
        db,
        actor.id,
        request.params.id,
      );
      if (!scope) return reply.code(404).send({ code: "SESSION_NOT_FOUND" });
      const presence = await heartbeatWorkspacePresence(db, {
        sessionId: request.params.id,
        actorId: actor.id,
        ttlSeconds: request.body?.ttlSeconds,
      });
      await audit(
        db,
        request,
        "workspace.presence.heartbeat",
        "agent_session",
        request.params.id,
        {
          vaultId: scope.vaultId,
          presenceExpiresAt: presence.presenceExpiresAt?.toISOString() ?? null,
        },
        scope.spaceId,
      );
      return presence;
    },
  );
}
