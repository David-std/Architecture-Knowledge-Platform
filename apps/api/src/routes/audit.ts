import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import {
  actorOf,
  requirePermission,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";

export function registerAuditRoutes(app: FastifyInstance, db: Postgres): void {
  app.get<{
    Querystring: { limit?: string; before?: string; action?: string };
  }>(
    "/v1/audit-events",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const limit = Math.max(
        1,
        Math.min(Number(request.query.limit ?? 100), 500),
      );
      const before = /^\d+$/.test(String(request.query.before ?? ""))
        ? Number(request.query.before)
        : null;
      const action = request.query.action?.trim() || null;
      const spaceIds = unrestrictedSpaceIdsForPermission(
        actorOf(request),
        "admin",
      );
      if (!spaceIds.length) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const result = await db.pool.query(
        `
        select id,organization_id,space_id,actor_id,action,resource_type,
               resource_id,metadata,trace_id,created_at
          from audit_events
         where space_id=any($1::uuid[])
           and ($2::bigint is null or id < $2)
           and ($3::text is null or action=$3)
         order by id desc limit $4
        `,
        [spaceIds, before, action, limit],
      );
      return {
        events: result.rows,
        nextBefore:
          result.rows.length === limit
            ? String(result.rows[result.rows.length - 1]?.id)
            : null,
      };
    },
  );
}
