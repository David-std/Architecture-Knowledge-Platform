import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Postgres, AppendOutboxEventInput } from "@akp/postgres";
import { IngestRequest } from "@akp/contracts";
import {
  actorOf,
  audit,
  hasSpaceAccess,
  hasUnrestrictedPathAccess,
  requirePermission,
  spaceIdsForPermission,
} from "../auth.js";

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
  if (!canonical || !(await stat(canonical)).isFile()) return null;
  const roots = (process.env.AKP_INGEST_ROOTS ?? process.cwd())
    .split(path.delimiter)
    .map((root) => path.resolve(root.trim()))
    .filter(Boolean);
  const inside = roots.some((root) => {
    const relative = path.relative(root, canonical);
    return (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    );
  });
  return inside ? canonical : null;
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

export function registerIngestRoutes(app: FastifyInstance, db: Postgres): void {
  app.post(
    "/v1/ingest",
    { preHandler: requirePermission("source:write") },
    async (request, reply) => {
      const parsed = IngestRequest.safeParse(request.body);
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
        await resolveVaultScope(db, {
          userId: actor.id,
          spaceId: parsed.data.spaceId,
          permission: "source:write",
          vaultId: parsed.data.vaultId,
          vaultIds: [parsed.data.vaultId],
          federated: false,
        });
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
          [id, JSON.stringify({ sourceUri: canonicalSource })],
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
          sourceUri: canonicalSource,
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
      const result = await db.pool.query(
        `
      select id, space_id, state, result, error, attempts, max_attempts, stage_outputs,
             lease_owner, lease_expires_at, heartbeat_at, cancelled_at, created_at, updated_at
        from ingest_jobs where id = $1 and space_id=any($2::uuid[])
      `,
        [
          request.params.id,
          spaceIdsForPermission(actorOf(request), "source:read"),
        ],
      );
      if (!result.rowCount)
        return reply.code(404).send({ code: "JOB_NOT_FOUND" });
      if (
        !hasUnrestrictedPathAccess(
          actorOf(request),
          String(result.rows[0]?.space_id),
          "source:read",
        )
      ) {
        return reply.code(404).send({ code: "JOB_NOT_FOUND" });
      }
      const events = await db.pool.query(
        "select state,event_type,payload,created_at from ingest_job_events where job_id=$1 order by id",
        [request.params.id],
      );
      return { ...result.rows[0], events: events.rows };
    },
  );

  app.get(
    "/v1/ingest",
    { preHandler: requirePermission("source:read") },
    async (request) => {
      const actor = actorOf(request);
      const spaces = spaceIdsForPermission(actor, "source:read").filter(
        (spaceId) => hasUnrestrictedPathAccess(actor, spaceId, "source:read"),
      );
      const result = await db.pool.query(
        `
        select id, source_uri, state, attempts, max_attempts, created_at, updated_at
          from ingest_jobs where space_id=any($1::uuid[]) order by created_at desc limit 100
        `,
        [spaces],
      );
      return { jobs: result.rows };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/ingest/:id/cancel",
    { preHandler: requirePermission("source:write") },
    async (request, reply) => {
      const actor = actorOf(request);
      const spaces = spaceIdsForPermission(actor, "source:write").filter(
        (spaceId) => hasUnrestrictedPathAccess(actor, spaceId, "source:write"),
      );
      const result = await db.pool.query(
        `
        update ingest_jobs set state='CANCELLED', cancelled_at=now(), lease_owner=null,
               lease_expires_at=null, updated_at=now()
         where id=$1 and space_id=any($2::uuid[])
           and state not in ('COMPLETED','CANCELLED','MERGED')
         returning id,state,space_id
        `,
        [request.params.id, spaces],
      );
      if (!result.rowCount)
        return reply.code(409).send({ code: "JOB_NOT_CANCELLABLE" });
      await audit(
        db,
        request,
        "ingest.cancel",
        "ingest_job",
        request.params.id,
        {},
        String(result.rows[0]?.space_id),
      );
      return result.rows[0];
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/ingest/:id/retry",
    { preHandler: requirePermission("source:write") },
    async (request, reply) => {
      const actor = actorOf(request);
      const spaces = spaceIdsForPermission(actor, "source:write").filter(
        (spaceId) => hasUnrestrictedPathAccess(actor, spaceId, "source:write"),
      );
      const result = await db.pool.query(
        `
        update ingest_jobs set state='RECEIVED', error=null, next_attempt_at=now(),
               cancelled_at=null, lease_owner=null, lease_expires_at=null, updated_at=now()
         where id=$1 and space_id=any($2::uuid[])
           and state in ('FAILED','QUARANTINED','CANCELLED')
         returning id,state,space_id
        `,
        [request.params.id, spaces],
      );
      if (!result.rowCount)
        return reply.code(409).send({ code: "JOB_NOT_RETRYABLE" });
      await audit(
        db,
        request,
        "ingest.retry",
        "ingest_job",
        request.params.id,
        {},
        String(result.rows[0]?.space_id),
      );
      return result.rows[0];
    },
  );
}
