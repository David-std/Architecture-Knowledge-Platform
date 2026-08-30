import type { FastifyInstance } from "fastify";
import { resolveAuthorizedVaultScope, type Postgres } from "@akp/postgres";
import {
  actorOf,
  requirePermission,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";

const SENSITIVE_METADATA_KEY =
  /^(?:source(?:uri|_uri|path|_path)|local(?:path|_path)|absolute(?:path|_path)|repository(?:path|_path)|canonical(?:path|_path)|object(?:key|_key)|endpoint|host)$/i;
const ABSOLUTE_PATH_TOKEN =
  /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var)\/)[^\s"']+/g;

/**
 * Audit metadata is operator-visible and may have been assembled by several
 * lifecycle stages. Keep stable identifiers and decisions, but never echo
 * host-specific routing details or raw source paths through this endpoint.
 */
function sanitizeAuditMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditMetadata);
  if (typeof value === "string") {
    return value.replaceAll(ABSOLUTE_PATH_TOKEN, "[REDACTED_PATH]");
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_METADATA_KEY.test(key))
      .map(([key, entry]) => [key, sanitizeAuditMetadata(entry)]),
  );
}

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
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const vaultIds = new Set<string>();
      for (const spaceId of spaceIds) {
        try {
          const scope = await resolveAuthorizedVaultScope(db, {
            userId: actor.id,
            spaceId,
            permission: "admin",
            federated: true,
          });
          for (const vaultId of scope.vaultIds) {
            // Audit rows have no document path. Only a whole-vault grant can
            // therefore authorize their metadata projection.
            if (scope.accessByVault[vaultId]?.pathPrefix === null) {
              vaultIds.add(vaultId);
            }
          }
        } catch {
          // Keep inaccessible private vaults indistinguishable from absent
          // records in the audit stream.
        }
      }
      if (!vaultIds.size) return { events: [], nextBefore: null };
      const result = await db.pool.query(
        `
        select id,organization_id,space_id,actor_id,action,resource_type,
               resource_id,metadata,trace_id,created_at,vault_id
          from audit_events
         where space_id=any($1::uuid[])
           and vault_id=any($2::uuid[])
           and ($3::bigint is null or id < $3)
           and ($4::text is null or action=$4)
         order by id desc limit $5
        `,
        [spaceIds, [...vaultIds], before, action, limit],
      );
      return {
        events: result.rows.map((event) => ({
          ...event,
          metadata: sanitizeAuditMetadata(event.metadata),
        })),
        nextBefore:
          result.rows.length === limit
            ? String(result.rows[result.rows.length - 1]?.id)
            : null,
      };
    },
  );
}
