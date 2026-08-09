import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import {
  actorOf,
  audit,
  requirePermission,
  spaceIdsForPermission,
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
      const result = await db.pool.query(
        "select * from agent_sessions where actor_id=$1 and space_id=any($2::uuid[]) order by updated_at desc limit 100",
        [actor?.id ?? null, spaces],
      );
      return { sessions: result.rows };
    },
  );

  app.post<{
    Body: {
      purpose: string;
      contextBudget?: number;
      projectId?: string;
      spaceId?: string;
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
      const spaceId =
        request.body.spaceId ??
        unrestrictedSpaceIdsForPermission(actor, "knowledge:read")[0] ??
        "00000000-0000-0000-0000-000000000003";
      if (
        !unrestrictedSpaceIdsForPermission(actor, "knowledge:read").includes(
          spaceId,
        )
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        `
        insert into agent_sessions(space_id,actor_id,project_id,purpose,context_budget,state)
        values($1,$2,$3,$4,$5,$6::jsonb) returning *
        `,
        [
          spaceId,
          actor?.id ?? null,
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
