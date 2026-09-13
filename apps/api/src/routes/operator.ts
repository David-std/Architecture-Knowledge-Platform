import type { FastifyInstance } from "fastify";
import {
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import {
  actorOf,
  requirePermission,
  unrestrictedSpaceIdsForPermission,
  type Actor,
  type Permission,
} from "../auth.js";

const ABSOLUTE_OPERATIONAL_PATH =
  /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var)\/)[^\s"']+/g;
const SENSITIVE_OPERATIONAL_KEY =
  /^(?:source(?:uri|_uri|path|_path)|local(?:path|_path)|absolute(?:path|_path)|repository(?:path|_path)|canonical(?:path|_path)|object(?:key|_key)|endpoint|host|password|secret|token|credential|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i;

function sanitizeOperationalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeOperationalValue);
  if (typeof value === "string") {
    return value.replaceAll(ABSOLUTE_OPERATIONAL_PATH, "[REDACTED_PATH]");
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !SENSITIVE_OPERATIONAL_KEY.test(key))
      .map(([key, entry]) => [key, sanitizeOperationalValue(entry)]),
  );
}

interface OperatorScope {
  spaces: string[];
  vaultIds: string[];
}

async function operatorScope(
  db: Postgres,
  actor: Actor | undefined,
  permission: Permission,
): Promise<OperatorScope> {
  if (!actor) return { spaces: [], vaultIds: [] };
  const spaces = unrestrictedSpaceIdsForPermission(actor, permission);
  const vaultIds = new Set<string>();
  for (const spaceId of spaces) {
    try {
      const scope = await resolveAuthorizedVaultScope(db, {
        userId: actor.id,
        spaceId,
        permission,
        federated: true,
      });
      for (const vaultId of scope.vaultIds) {
        if (scope.accessByVault[vaultId]?.pathPrefix === null) {
          vaultIds.add(vaultId);
        }
      }
    } catch {
      // Private or prefix-scoped vaults remain invisible to pathless operator projections.
    }
  }
  return { spaces, vaultIds: [...vaultIds] };
}

function boundedLimit(value: unknown, fallback: number, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(maximum, Math.trunc(parsed)));
}

async function probeJson(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number | null; body: unknown | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { ok: response.ok, status: response.status, body };
  } catch {
    return { ok: false, status: null, body: null };
  } finally {
    clearTimeout(timer);
  }
}

export function registerOperatorRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.get(
    "/v1/operator/me",
    { preHandler: requirePermission("knowledge:read") },
    async (request) => {
      const actor = actorOf(request);
      return {
        actor: actor
          ? {
              id: actor.id,
              email: actor.email,
              roles: actor.roles,
              authenticationKind: actor.authenticationKind,
              memberships: actor.memberships.map((membership) => ({
                spaceId: membership.spaceId,
                role: membership.role,
                pathPrefix: membership.pathPrefix,
                permissions: membership.permissions ?? [],
              })),
            }
          : null,
      };
    },
  );

  app.get<{ Querystring: { limit?: string; vaultId?: string } }>(
    "/v1/operator/graph",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const scope = await operatorScope(
        db,
        actorOf(request),
        "knowledge:read",
      );
      if (!scope.vaultIds.length) {
        return reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      }
      const requestedVault = request.query.vaultId?.trim();
      const vaultIds = requestedVault
        ? scope.vaultIds.includes(requestedVault)
          ? [requestedVault]
          : []
        : scope.vaultIds;
      if (!vaultIds.length) {
        return reply.code(404).send({ code: "VAULT_NOT_FOUND" });
      }
      const limit = boundedLimit(request.query.limit, 120, 250);
      const nodes = await db.pool.query(
        `
        select id,space_id,vault_id,external_id,path,title,type,layer,lifecycle,
               trust_tier,refresh_status,current_revision,updated_at
          from knowledge_documents
         where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
           and lifecycle <> 'DELETED_TOMBSTONE'
         order by updated_at desc,id
         limit $3
        `,
        [scope.spaces, vaultIds, limit],
      );
      const nodeIds = nodes.rows.map((node) => String(node.id));
      const edges =
        nodeIds.length === 0
          ? { rows: [] }
          : await db.pool.query(
              `
              select r.id,r.from_document_id "from",r.to_document_id "to",
                     r.relation_type "type",r.weight,r.provenance
                from knowledge_relations r
                join knowledge_documents source on source.id=r.from_document_id
                join knowledge_documents target on target.id=r.to_document_id
               where r.space_id=any($2::uuid[])
                 and source.vault_id=any($3::uuid[])
                 and target.vault_id=source.vault_id
                 and r.from_document_id=any($1::uuid[])
                 and r.to_document_id=any($1::uuid[])
               order by r.relation_type,r.from_document_id,r.to_document_id
              `,
              [nodeIds, scope.spaces, vaultIds],
            );
      const byRelationType = new Map<string, number>();
      const connected = new Set<string>();
      for (const edge of edges.rows) {
        const type = String(edge.type);
        byRelationType.set(type, (byRelationType.get(type) ?? 0) + 1);
        connected.add(String(edge.from));
        connected.add(String(edge.to));
      }
      return {
        scope: { vaultIds },
        truncated: nodes.rowCount === limit,
        nodes: nodes.rows,
        edges: edges.rows,
        byRelationType: [...byRelationType.entries()]
          .map(([relation_type, count]) => ({ relation_type, edges: count }))
          .sort((left, right) => right.edges - left.edges),
        orphanDocuments: nodeIds.filter((id) => !connected.has(id)).length,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/operator/sources/:id",
    { preHandler: requirePermission("source:read") },
    async (request, reply) => {
      const scope = await operatorScope(db, actorOf(request), "source:read");
      if (!scope.vaultIds.length) {
        return reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      }
      const source = await db.pool.query(
        `
        select id,space_id,vault_id,title,media_type,sha256,byte_size,status,
               metadata,created_at
          from sources
         where id=$1 and space_id=any($2::uuid[]) and vault_id=any($3::uuid[])
        `,
        [request.params.id, scope.spaces, scope.vaultIds],
      );
      const row = source.rows[0];
      if (!row) return reply.code(404).send({ code: "SOURCE_NOT_FOUND" });
      const [artifacts, evidence, descendants, reviews] = await Promise.all([
        db.pool.query(
          `
          select id,kind,source_hash,extractor,extractor_version,quality,metadata,
                 document_artifact,artifact_schema_version,structured_content_hash,created_at
            from source_artifacts
           where source_id=$1
           order by created_at desc
           limit 20
          `,
          [request.params.id],
        ),
        db.pool.query(
          `
          select id,locator,content_hash,excerpt,review_status,created_at
            from evidence
           where source_id=$1 and space_id=$2 and vault_id=$3
           order by created_at desc
           limit 50
          `,
          [request.params.id, row.space_id, row.vault_id],
        ),
        db.pool.query(
          `
          select id,external_id,path,title,type,lifecycle,trust_tier,current_revision,
                 refresh_status,updated_at
            from knowledge_documents
           where space_id=$2 and vault_id=$3
             and (
               frontmatter->>'source_id'=$1
               or frontmatter->>'source_sha256'=$4
             )
           order by updated_at desc
           limit 100
          `,
          [request.params.id, row.space_id, row.vault_id, row.sha256],
        ),
        db.pool.query(
          `
          select r.id,r.status,r.base_commit,r.head_commit,r.merged_commit,
                 r.impact_manifest,r.validation_report,r.created_at,r.updated_at
            from reviews r
           where r.space_id=$2 and r.vault_id=$3
             and (
               r.impact_manifest->>'sourceId'=$1
               or exists (
                 select 1 from ingest_jobs j
                  where j.id::text=r.impact_manifest->>'jobId'
                    and j.space_id=$2 and j.vault_id=$3
                    and j.stage_outputs->>'sourceId'=$1
               )
             )
           order by r.created_at desc
           limit 50
          `,
          [request.params.id, row.space_id, row.vault_id],
        ),
      ]);
      return sanitizeOperationalValue({
        source: row,
        artifacts: artifacts.rows,
        evidence: evidence.rows,
        descendants: descendants.rows,
        reviews: reviews.rows,
      });
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/operator/jobs/:id",
    { preHandler: requirePermission("source:read") },
    async (request, reply) => {
      const scope = await operatorScope(db, actorOf(request), "source:read");
      if (!scope.vaultIds.length) {
        return reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      }
      const job = await db.pool.query(
        `
        select id,space_id,vault_id,state,result,error,attempts,max_attempts,
               stage_outputs,lease_owner,lease_expires_at,heartbeat_at,cancelled_at,
               next_attempt_at,created_at,updated_at
          from ingest_jobs
         where id=$1 and space_id=any($2::uuid[]) and vault_id=any($3::uuid[])
        `,
        [request.params.id, scope.spaces, scope.vaultIds],
      );
      const row = job.rows[0];
      if (!row) return reply.code(404).send({ code: "JOB_NOT_FOUND" });
      const [events, outbox] = await Promise.all([
        db.pool.query(
          `
          select id,state,event_type,payload,created_at
            from ingest_job_events
           where job_id=$1
           order by id
          `,
          [request.params.id],
        ),
        db.pool.query(
          `
          select e.event_id,e.event_type,e.resource_id,e.correlation_id,e.causation_id,
                 e.occurred_at,e.payload,
                 coalesce(
                   jsonb_agg(
                     jsonb_build_object(
                       'consumer',d.consumer_name,
                       'status',d.status,
                       'attempts',d.attempts,
                       'nextAttemptAt',d.next_attempt_at,
                       'leaseExpiresAt',d.lease_expires_at,
                       'heartbeatAt',d.heartbeat_at,
                       'lastError',d.last_error,
                       'completedAt',d.completed_at
                     ) order by d.consumer_name
                   ) filter (where d.consumer_name is not null),
                   '[]'::jsonb
                 ) deliveries
            from event_outbox e
            left join event_deliveries d on d.event_id=e.event_id
           where e.space_id=$2 and e.vault_id=$3
             and (e.resource_id=$1 or e.correlation_id=$1)
           group by e.event_id
           order by e.occurred_at,e.event_id
           limit 100
          `,
          [request.params.id, row.space_id, row.vault_id],
        ),
      ]);
      return sanitizeOperationalValue({
        job: row,
        providerTasks:
          (row.stage_outputs as Record<string, unknown> | null)?.providerTasks ??
          {},
        events: events.rows,
        outbox: outbox.rows,
      });
    },
  );

  app.get(
    "/v1/operator/health",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const scope = await operatorScope(db, actorOf(request), "admin");
      if (!scope.vaultIds.length) {
        return reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      }
      const rawEndpoint =
        process.env.AKP_RAW_ENDPOINT ?? "http://127.0.0.1:19000";
      const extractorEndpoint =
        process.env.AKP_EXTRACTOR_URL ?? "http://127.0.0.1:8090";
      const [database, rawStore, extractor, providerCapabilities, indexes, outbox, stuck] =
        await Promise.all([
          db.health().catch(() => false),
          probeJson(`${rawEndpoint}/minio/health/live`),
          probeJson(`${extractorEndpoint}/health`),
          probeJson(`${extractorEndpoint}/v1/capabilities`, {
            headers: {
              "x-akp-extractor-token":
                process.env.AKP_EXTRACTOR_TOKEN ??
                "local-extractor-development-token",
            },
          }),
          db.pool.query(
            `
            select vault_id,corpus_revision,lexical_revision,vector_revision,
                   graph_revision,context_pack_revision,status,warnings,
                   retrieval_configuration_version
              from vault_index_revisions
             where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
             order by vault_id
            `,
            [scope.spaces, scope.vaultIds],
          ),
          db.pool.query(
            `
            select d.status,count(*)::int count
              from event_deliveries d
              join event_outbox e on e.event_id=d.event_id
             where e.space_id=any($1::uuid[]) and e.vault_id=any($2::uuid[])
             group by d.status
             order by d.status
            `,
            [scope.spaces, scope.vaultIds],
          ),
          db.pool.query(
            `
            select id,vault_id,state,attempts,max_attempts,lease_owner,
                   lease_expires_at,heartbeat_at,next_attempt_at,updated_at,error
              from ingest_jobs
             where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
               and state not in ('COMPLETED','CANCELLED','NO_MATERIAL')
               and (
                 (lease_expires_at is not null and lease_expires_at < now())
                 or updated_at < now()-interval '15 minutes'
               )
             order by updated_at
             limit 50
            `,
            [scope.spaces, scope.vaultIds],
          ),
        ]);
      const status =
        database && rawStore.ok && extractor.ok ? "UP" : "DEGRADED";
      return sanitizeOperationalValue({
        status,
        services: {
          database: { ok: database },
          rawStore: { ok: rawStore.ok, status: rawStore.status },
          extractor: { ok: extractor.ok, status: extractor.status },
        },
        providers: providerCapabilities.ok ? providerCapabilities.body : null,
        indexes: indexes.rows,
        outbox: outbox.rows,
        stuckJobs: stuck.rows,
      });
    },
  );
}
