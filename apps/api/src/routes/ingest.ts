import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Postgres, AppendOutboxEventInput } from "@akp/postgres";
import { IngestRequest } from "@akp/contracts";
import { z } from "zod";
import {
  actorOf,
  audit,
  hasSpaceAccess,
  hasUnrestrictedPathAccess,
  requirePermission,
  unrestrictedSpaceIdsForPermission,
} from "../auth.js";

const DocumentIntelligenceIngestOptions = z
  .object({
    complexity: z
      .enum([
        "simple",
        "digital",
        "complex",
        "scanned",
        "formula",
        "table-heavy",
        "unknown",
      ])
      .optional(),
    ocrRequired: z.boolean().default(false),
    tables: z.boolean().default(false),
    formula: z.boolean().default(false),
    costPolicy: z.enum(["NO_PAID", "STANDARD", "QUALITY"]).default("STANDARD"),
    privacyPolicy: z
      .enum(["LOCAL_ONLY", "LOCAL_PREFERRED", "REMOTE_ALLOWED"])
      .default("LOCAL_PREFERRED"),
    language: z.string().trim().min(2).max(32).optional(),
  })
  .strict();

const DocumentIntelligenceIngestRequest = IngestRequest.extend({
  documentIntelligence: DocumentIntelligenceIngestOptions.optional(),
});

async function allowedLocalSource(sourceUri: string): Promise<string | null> {
  if (/^https?:/i.test(sourceUri)) return null;
  let candidate: string;
  try {
    candidate = sourceUri.startsWith("file:")
      ? fileURLToPath(sourceUri)
      : sourceUri;
  } catch {
    return null;
  }
  const canonical = await realpath(path.resolve(candidate)).catch(() => null);
  if (!canonical) return null;
  const sourceStat = await stat(canonical).catch(() => null);
  if (!sourceStat?.isFile()) return null;
  const configuredRoots = process.env.AKP_INGEST_ROOTS;
  // Ingestion is deliberately fail-closed. An unset variable or an empty
  // path component must never expand to process.cwd() (or the cwd itself).
  if (!configuredRoots?.trim()) return null;
  const rootValues = configuredRoots
    .split(path.delimiter)
    .map((root) => root.trim());
  if (rootValues.length === 0 || rootValues.some((root) => root.length === 0)) {
    return null;
  }
  const roots = rootValues.map((root) => path.resolve(root));
  const inside = roots.some((root) => {
    const relative = path.relative(root, canonical);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  });
  return inside ? canonical : null;
}

/**
 * Operational job rows are pathless resources. Never echo the canonical
 * local source path or object-store key back to a caller, even when the
 * caller has whole-vault source:read access. The worker still receives the
 * immutable values from PostgreSQL; this boundary only shapes HTTP output.
 *
 * Keep this recursive because stage outputs and persisted job events contain
 * nested payloads written by several lifecycle stages. Unknown fields stay
 * intact so clients can inspect deterministic state without receiving raw
 * source routing details.
 */
function sanitizeOperationalPayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeOperationalPayload);
  if (typeof value === "string") {
    return value.replace(
      /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var)\/)[^\s"']+/g,
      "[REDACTED_PATH]",
    );
  }
  if (!value || typeof value !== "object") return value;
  const sensitiveKeys =
    /^(?:source(?:uri|_uri|path|_path)|local(?:path|_path)|absolute(?:path|_path)|repository(?:path|_path)|object(?:key|_key)|key)$/i;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !sensitiveKeys.test(key))
      .map(([key, entry]) => [key, sanitizeOperationalPayload(entry)]),
  );
}

// Keep the route importable by lightweight health-test mocks that only expose
// the Postgres class. Production and integration paths resolve the real append
// helper on first use, still inside the caller's SQL transaction.
type AppendHelper = (typeof import("@akp/postgres"))["appendOutboxEvent"];
type AppendTarget = Parameters<AppendHelper>[0];
type ResolveVaultScope =
  (typeof import("@akp/postgres"))["resolveAuthorizedVaultScope"];
let outboxModule: Promise<typeof import("@akp/postgres")> | undefined;
async function appendEvent(
  client: AppendTarget,
  input: AppendOutboxEventInput,
): Promise<Awaited<ReturnType<AppendHelper>>> {
  const module = await (outboxModule ??= import("@akp/postgres"));
  return module.appendOutboxEvent(client, input);
}
async function resolveVaultScope(
  ...args: Parameters<ResolveVaultScope>
): Promise<Awaited<ReturnType<ResolveVaultScope>>> {
  const module = await (outboxModule ??= import("@akp/postgres"));
  return module.resolveAuthorizedVaultScope(...args);
}

type IngestPermission = "source:read" | "source:write";

/**
 * Jobs have no canonical knowledge path of their own. Resolve their vault
 * scope before reading or mutating them so an unrestricted membership in a
 * space cannot reach a private vault that was never granted to that actor.
 */
async function authorizedOperationalVaults(
  db: Postgres,
  actor: ReturnType<typeof actorOf>,
  permission: IngestPermission,
): Promise<{
  spaces: string[];
  vaultIds: string[];
  accessByVault: Awaited<ReturnType<ResolveVaultScope>>["accessByVault"];
}> {
  const spaces = unrestrictedSpaceIdsForPermission(actor, permission);
  const accessByVault: Awaited<ReturnType<ResolveVaultScope>>["accessByVault"] =
    {};
  if (!actor || spaces.length === 0) {
    return { spaces, vaultIds: [], accessByVault };
  }
  const vaultIds = new Set<string>();
  await Promise.all(
    spaces.map(async (spaceId) => {
      try {
        const scope = await resolveVaultScope(db, {
          userId: actor.id,
          spaceId,
          permission,
          federated: true,
        });
        scope.vaultIds.forEach((vaultId) => {
          const access = scope.accessByVault[vaultId];
          // Job endpoints do not carry a knowledge path. Only a whole-vault
          // grant can safely authorize them; prefix-scoped grants remain
          // usable for path-bearing APIs.
          if (access?.pathPrefix === null) {
            vaultIds.add(vaultId);
            accessByVault[vaultId] = access;
          }
        });
      } catch {
        // A private vault without an explicit grant remains invisible.
      }
    }),
  );
  return { spaces, vaultIds: [...vaultIds], accessByVault };
}

export function registerIngestRoutes(app: FastifyInstance, db: Postgres): void {
  app.post(
    "/v1/ingest",
    { preHandler: requirePermission("source:write") },
    async (request, reply) => {
      const parsed = DocumentIntelligenceIngestRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_INGEST_REQUEST",
          issues: parsed.error.issues,
        });
      }
      if (
        !hasSpaceAccess(actorOf(request), parsed.data.spaceId, "source:write")
      ) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      if (
        !hasUnrestrictedPathAccess(
          actorOf(request),
          parsed.data.spaceId,
          "source:write",
        )
      ) {
        return reply.code(403).send({ code: "PATH_SCOPE_DENIED" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      try {
        const scope = await resolveVaultScope(db, {
          userId: actor.id,
          spaceId: parsed.data.spaceId,
          permission: "source:write",
          vaultId: parsed.data.vaultId,
          vaultIds: [parsed.data.vaultId],
          federated: false,
        });
        const access = scope.accessByVault[parsed.data.vaultId];
        if (!access) throw new Error("VAULT_ACCESS_DENIED");
        if (access.pathPrefix !== null) throw new Error("PATH_SCOPE_DENIED");
      } catch (error) {
        return reply.code(403).send({
          code: error instanceof Error ? error.message : "VAULT_ACCESS_DENIED",
        });
      }
      const canonicalSource = await allowedLocalSource(parsed.data.sourceUri);
      if (!canonicalSource) {
        return reply.code(403).send({
          code: "SOURCE_PATH_NOT_ALLOWED",
          guidance:
            "Capture the source below an AKP_INGEST_ROOTS directory before ingestion.",
        });
      }

      const id = randomUUID();
      const payload = { ...parsed.data, sourceUri: canonicalSource };
      const actorId = actorOf(request)?.id;
      const client = await db.pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `
        insert into ingest_jobs(id, space_id, vault_id, source_uri, state, payload, created_by)
        values ($1, $2, $3, $4, 'RECEIVED', $5::jsonb, $6)
        `,
          [
            id,
            parsed.data.spaceId,
            parsed.data.vaultId,
            canonicalSource,
            JSON.stringify(payload),
            actorId ?? null,
          ],
        );
        await client.query(
          "insert into ingest_job_events(job_id,state,event_type,payload) values ($1,'RECEIVED','SUBMITTED',$2::jsonb)",
          [
            id,
            JSON.stringify({
              sourceUri: canonicalSource,
              documentIntelligence: parsed.data.documentIntelligence ?? null,
            }),
          ],
        );
        const registered = await appendEvent(client, {
          eventType: "SourceRegistered",
          resourceId: id,
          spaceId: parsed.data.spaceId,
          vaultId: parsed.data.vaultId,
          correlationId: id,
          payload: {
            jobId: id,
            sourceUri: canonicalSource,
            title: parsed.data.title ?? null,
            mediaType: parsed.data.mediaType ?? null,
          },
        });
        await appendEvent(client, {
          eventType: "ExtractionRequested",
          resourceId: id,
          spaceId: parsed.data.spaceId,
          vaultId: parsed.data.vaultId,
          correlationId: id,
          causationId: registered.eventId,
          payload: {
            jobId: id,
            sourceUri: canonicalSource,
            expectedSha256: parsed.data.expectedSha256 ?? null,
            documentIntelligence: parsed.data.documentIntelligence ?? null,
          },
        });
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      await audit(
        db,
        request,
        "ingest.submit",
        "ingest_job",
        id,
        {
          vaultId: parsed.data.vaultId,
          sourceUri: canonicalSource,
          documentIntelligence: parsed.data.documentIntelligence ?? null,
        },
        parsed.data.spaceId,
      );

      return reply.code(202).send({ jobId: id, state: "RECEIVED" });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/ingest/:id",
    { preHandler: requirePermission("source:read") },
    async (request, reply) => {
      const scope = await authorizedOperationalVaults(
        db,
        actorOf(request),
        "source:read",
      );
      const result = await db.pool.query(
        `
      select id, space_id, state, result, error, attempts, max_attempts, stage_outputs,
             lease_owner, lease_expires_at, heartbeat_at, cancelled_at, created_at, updated_at
        from ingest_jobs
       where id = $1 and space_id=any($2::uuid[]) and vault_id=any($3::uuid[])
      `,
        [request.params.id, scope.spaces, scope.vaultIds],
      );
      if (!result.rowCount)
        return reply.code(404).send({ code: "JOB_NOT_FOUND" });
      const events = await db.pool.query(
        "select state,event_type,payload,created_at from ingest_job_events where job_id=$1 order by id",
        [request.params.id],
      );
      const job = sanitizeOperationalPayload(result.rows[0]) as Record<
        string,
        unknown
      >;
      return {
        ...job,
        events: sanitizeOperationalPayload(events.rows),
      };
    },
  );

  app.get(
    "/v1/ingest",
    { preHandler: requirePermission("source:read") },
    async (request) => {
      const scope = await authorizedOperationalVaults(
        db,
        actorOf(request),
        "source:read",
      );
      const result = await db.pool.query(
        `
        select id, state, attempts, max_attempts, created_at, updated_at
          from ingest_jobs
         where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
         order by created_at desc limit 100
        `,
        [scope.spaces, scope.vaultIds],
      );
      return { jobs: sanitizeOperationalPayload(result.rows) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/ingest/:id/cancel",
    { preHandler: requirePermission("source:write") },
    async (request, reply) => {
      const scope = await authorizedOperationalVaults(
        db,
        actorOf(request),
        "source:write",
      );
      const result = await db.pool.query(
        `
        update ingest_jobs set state='CANCELLED', cancelled_at=now(), lease_owner=null,
               lease_expires_at=null, updated_at=now()
         where id=$1 and space_id=any($2::uuid[])
           and vault_id=any($3::uuid[])
           and state not in ('COMPLETED','CANCELLED','MERGED')
         returning id,state,space_id,vault_id
        `,
        [request.params.id, scope.spaces, scope.vaultIds],
      );
      if (!result.rowCount)
        return reply.code(409).send({ code: "JOB_NOT_CANCELLABLE" });
      await audit(
        db,
        request,
        "ingest.cancel",
        "ingest_job",
        request.params.id,
        { vaultId: String(result.rows[0]?.vault_id) },
        String(result.rows[0]?.space_id),
      );
      return result.rows[0];
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/ingest/:id/retry",
    { preHandler: requirePermission("source:write") },
    async (request, reply) => {
      const scope = await authorizedOperationalVaults(
        db,
        actorOf(request),
        "source:write",
      );
      const result = await db.pool.query(
        `
        update ingest_jobs set state='RECEIVED', error=null, next_attempt_at=now(),
               cancelled_at=null, lease_owner=null, lease_expires_at=null, updated_at=now()
         where id=$1 and space_id=any($2::uuid[])
           and vault_id=any($3::uuid[])
           and state in ('FAILED','QUARANTINED','CANCELLED')
         returning id,state,space_id,vault_id
        `,
        [request.params.id, scope.spaces, scope.vaultIds],
      );
      if (!result.rowCount)
        return reply.code(409).send({ code: "JOB_NOT_RETRYABLE" });
      await audit(
        db,
        request,
        "ingest.retry",
        "ingest_job",
        request.params.id,
        { vaultId: String(result.rows[0]?.vault_id) },
        String(result.rows[0]?.space_id),
      );
      return result.rows[0];
    },
  );
}
