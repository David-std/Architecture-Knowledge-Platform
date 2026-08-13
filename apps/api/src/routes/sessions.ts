import type { FastifyInstance } from "fastify";
import { resolveAuthorizedVaultScope, type Postgres } from "@akp/postgres";
import {
  actorOf,
  audit,
  requirePermission,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";

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
          vaultIds.push(...scope.vaultIds);
        } catch {
          // No visible vault in this otherwise authorized space.
        }
      }
      if (!vaultIds.length) return { sessions: [] };
      const result = await db.pool.query(
        "select * from agent_sessions where actor_id=$1 and space_id=any($2::uuid[]) and vault_id=any($3::uuid[]) order by updated_at desc limit 100",
        [actor.id, spaces, [...new Set(vaultIds)]],
      );
      return { sessions: result.rows };
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
        await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId,
          permission: "knowledge:read",
          vaultId,
          vaultIds: [vaultId],
          federated: false,
        });
      } catch (error) {
        return reply.code(403).send({
          code: error instanceof Error ? error.message : "VAULT_ACCESS_DENIED",
        });
      }
      const result = await db.pool.query(
        `
        insert into agent_sessions(space_id,vault_id,actor_id,project_id,purpose,context_budget,state)
        values($1,$2,$3,$4,$5,$6,$7::jsonb) returning *
        `,
        [
          spaceId,
          vaultId,
          actor.id,
          request.body.projectId ?? null,
          request.body.purpose.trim(),
          budget,
          JSON.stringify({ status: "ACTIVE", createdBy: "api" }),
        ],
      );
      await audit(
        db,
        request,
        "agent_session.create",
        "agent_session",
        String(result.rows[0]?.id),
      );
      return reply.code(201).send(result.rows[0]);
    },
  );
}
