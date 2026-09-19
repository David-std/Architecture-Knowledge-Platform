import type { FastifyInstance } from "fastify";
import { getOpenTelemetryStatus } from "@akp/observability";
import { resolveAuthorizedVaultScope, type Postgres } from "@akp/postgres";
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
  actor: Actor | null | undefined,
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

function boundedLimit(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
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

  app.get(
    "/v1/operator/workspace-home",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const scope = await operatorScope(db, actorOf(request), "knowledge:read");
      if (!scope.vaultIds.length) {
        return reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      }

      const [
        projects,
        workObjects,
        reviews,
        findings,
        sessions,
        claims,
        handoffs,
        indexes,
        connectors,
        federation,
      ] = await Promise.all([
        db.pool.query(
          `select id,space_id,vault_id,slug,
                  metadata-'rootPath'-'repositoryPath'-'localPath' metadata,
                  created_at
             from projects
            where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
            order by created_at desc
            limit 20`,
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          `select id,space_id,vault_id,provider,object_type,external_id,title,
                  authority,source_revision,work_object_class,metadata,
                  observed_at,updated_at
             from external_object_refs
            where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
              and work_object_class is not null
            order by updated_at desc,id
            limit 80`,
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          `select id,space_id,vault_id,status,base_commit,head_commit,
                  decision_at,decision_reason,created_at,updated_at
             from reviews
            where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
              and status in ('PENDING','CHANGES_REQUESTED')
            order by created_at desc
            limit 30`,
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          `select id,space_id,vault_id,severity,category,detector,code,summary,
                  status,proposed_action,target_ids,last_seen_at
             from assurance_findings
            where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
              and status in ('OPEN','ACKNOWLEDGED')
            order by
              case severity
                when 'CRITICAL' then 1
                when 'HIGH' then 2
                when 'MEDIUM' then 3
                when 'LOW' then 4
                else 5
              end,
              last_seen_at desc
            limit 30`,
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          `select s.id,s.space_id,s.vault_id,s.project_id,s.purpose,s.state,
                  s.created_at,s.updated_at,
                  r.revision_set_hash,r.pinned_at,
                  count(p.user_id) filter (
                    where p.left_at is null
                      and (
                        p.presence_expires_at is null
                        or p.presence_expires_at>now()
                      )
                  )::int active_participants
             from agent_sessions s
             left join workspace_context_revision_sets r on r.session_id=s.id
             left join workspace_session_participants p on p.session_id=s.id
            where s.space_id=any($1::uuid[]) and s.vault_id=any($2::uuid[])
              and coalesce(s.state->>'workStatus','OPEN') not in (
                'COMPLETED','ABANDONED'
              )
            group by s.id,r.revision_set_hash,r.pinned_at
            order by s.updated_at desc
            limit 30`,
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          `select c.id,c.session_id,c.work_key,c.status,c.fencing_token,
                  c.lease_expires_at,c.updated_at,s.space_id,s.vault_id,
                  p.kind owner_principal_kind,p.label owner_principal_label
             from workspace_claims c
             join agent_sessions s on s.id=c.session_id
             join principals p on p.id=c.owner_principal_id
            where s.space_id=any($1::uuid[]) and s.vault_id=any($2::uuid[])
              and c.status='ACTIVE'
            order by c.lease_expires_at,c.updated_at desc
            limit 40`,
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          `select e.id,e.session_id,e.space_id,e.vault_id,e.claim_id,e.payload,
                  e.created_at
             from workspace_events e
            where e.space_id=any($1::uuid[]) and e.vault_id=any($2::uuid[])
              and e.event_type='CLAIM_HANDOFF'
            order by e.created_at desc,e.id desc
            limit 20`,
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          `select vault_id,corpus_revision,lexical_revision,vector_revision,
                  graph_revision,context_pack_revision,status,warnings,
                  updated_at
             from vault_index_revisions
            where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
            order by vault_id`,
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          `select r.vault_id,r.state,count(*)::int count,
                  count(*) filter (
                    where exists (
                      select 1
                        from source_connector_events e
                       where e.connector_id=r.id
                         and e.status in ('PENDING','REJECTED')
                    )
                  )::int attention
             from source_connector_registrations r
            where r.space_id=any($1::uuid[]) and r.vault_id=any($2::uuid[])
            group by r.vault_id,r.state
            order by r.vault_id,r.state`,
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          `select space_id,trust_state,discovery_mode,count(*)::int count,
                  max(last_seen_at) last_seen_at
             from context_fabric_peers
            where space_id=any($1::uuid[])
            group by space_id,trust_state,discovery_mode
            order by space_id,trust_state,discovery_mode`,
          [scope.spaces],
        ),
      ]);

      const workByClass = new Map<string, unknown[]>();
      for (const row of workObjects.rows) {
        const key = String(row.work_object_class);
        const values = workByClass.get(key) ?? [];
        values.push(row);
        workByClass.set(key, values);
      }

      const currentWork = (classes: string[], limit: number) =>
        classes
          .flatMap((key) => workByClass.get(key) ?? [])
          .sort((left, right) => {
            const a = new Date(
              String((left as Record<string, unknown>).updated_at ?? 0),
            ).getTime();
            const b = new Date(
              String((right as Record<string, unknown>).updated_at ?? 0),
            ).getTime();
            return b - a;
          })
          .slice(0, limit);

      return sanitizeOperationalValue({
        generatedAt: new Date().toISOString(),
        scope: {
          spaces: scope.spaces,
          vaultIds: scope.vaultIds,
        },
        projects: projects.rows,
        goals: currentWork(["GOAL", "PROJECT"], 20),
        workItems: currentWork(["WORK_ITEM"], 30),
        pullRequests: currentWork(["PULL_REQUEST", "CODE_REVIEW"], 20),
        incidentsAndDeployments: currentWork(
          ["INCIDENT", "DEPLOYMENT", "CHANGE", "BUILD", "TEST_RUN"],
          30,
        ),
        pendingReviews: reviews.rows,
        assuranceFindings: findings.rows,
        activeSessions: sessions.rows,
        activeClaims: claims.rows,
        recentHandoffs: handoffs.rows,
        freshness: indexes.rows,
        connectors: connectors.rows,
        federation: federation.rows,
      });
    },
  );

  app.get<{
    Querystring: { limit?: string; vaultId?: string; asOf?: string };
  }>(
    "/v1/operator/graph",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      const scope = await operatorScope(db, actorOf(request), "knowledge:read");
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
      const asOfRaw = request.query.asOf?.trim();
      const asOfDate = asOfRaw ? new Date(asOfRaw) : null;
      if (asOfDate && Number.isNaN(asOfDate.getTime())) {
        return reply.code(400).send({ code: "INVALID_GRAPH_AS_OF" });
      }
      const asOf = asOfDate?.toISOString() ?? null;

      const [knowledgeNodesResult, federatedNodesResult] = await Promise.all([
        db.pool.query(
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
        ),
        db.pool.query(
          `
          select distinct
                 n.id,n.space_id,n.vault_id,n.graph_domain,n.scope_id,n.kind,
                 n.canonical_key,n.revision,n.authorization_path,n.payload,
                 p.lifecycle projection_lifecycle,p.freshness,
                 p.updated_at projection_updated_at
            from federated_graph_projection_revisions p
            join federated_graph_projection_nodes pn
              on pn.projection_revision_id=p.id
            join federated_graph_nodes n on n.id=pn.node_id
           where p.space_id=any($1::uuid[])
             and p.vault_id=any($2::uuid[])
             and n.vault_id=any($2::uuid[])
             and p.lifecycle='ACTIVE'
           order by p.updated_at desc,n.id
           limit $3
          `,
          [scope.spaces, vaultIds, limit],
        ),
      ]);

      const knowledgeNodes = knowledgeNodesResult.rows.map((row) => ({
        id: `knowledge:${String(row.id)}`,
        entityId: String(row.id),
        nodeSource: "KNOWLEDGE",
        graph_domain: "EPISTEMIC",
        scope_id: `vault:${String(row.vault_id)}`,
        kind: String(row.type),
        canonical_key: String(row.external_id ?? row.path ?? row.id),
        vault_id: row.vault_id,
        external_id: row.external_id,
        path: row.path,
        title: row.title,
        type: row.type,
        layer: row.layer ?? "EPISTEMIC",
        lifecycle: row.lifecycle,
        trust_tier: row.trust_tier,
        refresh_status: row.refresh_status,
        current_revision: row.current_revision,
        updated_at: row.updated_at,
        payload: {
          documentId: row.id,
          externalId: row.external_id,
          path: row.path,
          title: row.title,
        },
      }));
      const federatedNodes = federatedNodesResult.rows.map((row) => {
        const payload =
          row.payload && typeof row.payload === "object"
            ? (row.payload as Record<string, unknown>)
            : {};
        return {
          id: `federated:${String(row.id)}`,
          entityId: String(row.id),
          nodeSource: "FEDERATED",
          graph_domain: String(row.graph_domain),
          scope_id: String(row.scope_id),
          kind: String(row.kind),
          canonical_key: String(row.canonical_key),
          vault_id: row.vault_id,
          external_id: row.canonical_key,
          path: row.authorization_path ?? null,
          title: String(
            payload.title ??
              payload.name ??
              payload.qualifiedName ??
              row.canonical_key,
          ),
          type: row.kind,
          layer: row.graph_domain,
          lifecycle: row.projection_lifecycle,
          trust_tier: String(
            payload.trustTier ?? payload.trust_tier ?? "DERIVED",
          ),
          refresh_status: row.freshness,
          current_revision: row.revision,
          updated_at: row.projection_updated_at,
          payload,
        };
      });

      const nodes = [...knowledgeNodes, ...federatedNodes]
        .sort(
          (left, right) =>
            new Date(String(right.updated_at ?? 0)).getTime() -
            new Date(String(left.updated_at ?? 0)).getTime(),
        )
        .slice(0, limit);
      const knowledgeIds = nodes
        .filter((node) => node.nodeSource === "KNOWLEDGE")
        .map((node) => node.entityId);
      const federatedIds = nodes
        .filter((node) => node.nodeSource === "FEDERATED")
        .map((node) => node.entityId);

      const [knowledgeEdgesResult, federatedEdgesResult] = await Promise.all([
        knowledgeIds.length === 0
          ? Promise.resolve({ rows: [] as Record<string, unknown>[] })
          : db.pool.query(
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
              [knowledgeIds, scope.spaces, vaultIds],
            ),
        federatedIds.length === 0
          ? Promise.resolve({ rows: [] as Record<string, unknown>[] })
          : db.pool.query(
              `
              select distinct
                     e.id,e.from_node_id "from",e.to_node_id "to",
                     e.relation_type "type",e.owner_graph_domain,
                     e.derivation,e.confidence,e.source_ids,e.evidence_ids,
                     e.locator_refs,e.provenance_revision,e.support_set_id,
                     e.valid_from,e.valid_to,e.recorded_at
                from federated_graph_projection_revisions p
                join federated_graph_projection_edges pe
                  on pe.projection_revision_id=p.id
                join federated_graph_edges e on e.id=pe.edge_id
               where p.space_id=any($2::uuid[])
                 and p.vault_id=any($3::uuid[])
                 and p.lifecycle='ACTIVE'
                 and e.from_node_id=any($1::uuid[])
                 and e.to_node_id=any($1::uuid[])
                 and (
                   $4::timestamptz is null
                   or (
                     (e.valid_from is null or e.valid_from<=$4::timestamptz)
                     and (e.valid_to is null or e.valid_to>$4::timestamptz)
                   )
                 )
               order by e.owner_graph_domain,e.relation_type,e.id
              `,
              [federatedIds, scope.spaces, vaultIds, asOf],
            ),
      ]);

      const edges = [
        ...knowledgeEdgesResult.rows.map((row) => ({
          id: `knowledge-edge:${String(row.id)}`,
          entityId: String(row.id),
          edgeSource: "KNOWLEDGE",
          from: `knowledge:${String(row.from)}`,
          to: `knowledge:${String(row.to)}`,
          type: row.type,
          weight: row.weight,
          owner_graph_domain: "EPISTEMIC",
          derivation: null,
          confidence: null,
          provenance: row.provenance,
          provenance_revision: null,
          source_ids: [],
          evidence_ids: [],
          locator_refs: [],
          support_set_id: null,
          valid_from: null,
          valid_to: null,
          recorded_at: null,
        })),
        ...federatedEdgesResult.rows.map((row) => ({
          id: `federated-edge:${String(row.id)}`,
          entityId: String(row.id),
          edgeSource: "FEDERATED",
          from: `federated:${String(row.from)}`,
          to: `federated:${String(row.to)}`,
          type: row.type,
          weight: null,
          owner_graph_domain: row.owner_graph_domain,
          derivation: row.derivation,
          confidence: row.confidence,
          provenance: {
            sourceIds: row.source_ids,
            evidenceIds: row.evidence_ids,
            locatorRefs: row.locator_refs,
          },
          provenance_revision: row.provenance_revision,
          source_ids: row.source_ids,
          evidence_ids: row.evidence_ids,
          locator_refs: row.locator_refs,
          support_set_id: row.support_set_id,
          valid_from: row.valid_from,
          valid_to: row.valid_to,
          recorded_at: row.recorded_at,
        })),
      ];

      const byRelationType = new Map<string, number>();
      const byLayer = new Map<string, number>();
      const connected = new Set<string>();
      for (const node of nodes) {
        const layer = String(node.graph_domain);
        byLayer.set(layer, (byLayer.get(layer) ?? 0) + 1);
      }
      for (const edge of edges) {
        const type = String(edge.type);
        byRelationType.set(type, (byRelationType.get(type) ?? 0) + 1);
        connected.add(String(edge.from));
        connected.add(String(edge.to));
      }

      return sanitizeOperationalValue({
        scope: { vaultIds },
        asOf,
        truncated:
          knowledgeNodesResult.rowCount === limit ||
          federatedNodesResult.rowCount === limit ||
          nodes.length === limit,
        nodes,
        edges,
        byLayer: [...byLayer.entries()]
          .map(([graph_domain, count]) => ({ graph_domain, nodes: count }))
          .sort((left, right) => right.nodes - left.nodes),
        byRelationType: [...byRelationType.entries()]
          .map(([relation_type, count]) => ({ relation_type, edges: count }))
          .sort((left, right) => right.edges - left.edges),
        orphanDocuments: nodes.filter((node) => !connected.has(node.id)).length,
      });
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
          (row.stage_outputs as Record<string, unknown> | null)
            ?.providerTasks ?? {},
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
      const [
        database,
        rawStore,
        extractor,
        providerCapabilities,
        indexes,
        outbox,
        stuck,
        assuranceRuns,
        assuranceFindings,
        connectorStates,
      ] = await Promise.all([
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
        db.pool.query(
          `
            select id,space_id,vault_id,trigger,detectors,status,cursor,
                   attempts,max_attempts,next_attempt_at,completed_at,
                   result_summary,created_at,updated_at
              from assurance_runs
             where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
             order by created_at desc
             limit 50
            `,
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          `
            select id,run_id,space_id,vault_id,detector,detector_version,
                   severity,category,scope_id,target_ids,
                   evidence_refs evidence_ids,support_set_ids,code,summary,
                   status,proposed_action,revision_set,first_seen_at,last_seen_at
              from assurance_findings
             where space_id=any($1::uuid[]) and vault_id=any($2::uuid[])
               and status='OPEN'
             order by
               case severity
                 when 'CRITICAL' then 1
                 when 'HIGH' then 2
                 when 'MEDIUM' then 3
                 when 'LOW' then 4
                 else 5
               end,
               last_seen_at desc
             limit 100
            `,
          [scope.spaces, scope.vaultIds],
        ),
        db.pool.query(
          `
            select r.id,r.space_id,r.vault_id,r.connector_key,r.source_system,
                   r.state,r.descriptor,r.last_event_at,c.applied_sequence,
                   c.updated_at checkpoint_updated_at,
                   case
                     when r.state<>'ACTIVE' then 'DISABLED'
                     when r.descriptor#>>'{incremental,webhook}'='true'
                       then 'ENABLED'
                     else 'NOT_CONFIGURED'
                   end webhook_status,
                   (
                     select count(*)::int
                       from source_connector_events e
                      where e.connector_id=r.id and e.status='PENDING'
                   ) pending_events,
                   (
                     select count(*)::int
                       from source_connector_events e
                      where e.connector_id=r.id and e.status='PENDING'
                        and e.sequence>c.applied_sequence+1
                   ) gap_events,
                   (
                     select count(*)::int
                       from source_connector_events e
                      where e.connector_id=r.id and e.status='PENDING'
                        and e.sequence=c.applied_sequence+1
                        and e.next_attempt_at>now()
                   ) retry_events,
                   (
                     select count(*)::int
                       from source_connector_events e
                      where e.connector_id=r.id and e.status='REJECTED'
                   ) rejected_events,
                   (
                     select coalesce(sum(e.apply_attempts),0)::int
                       from source_connector_events e
                      where e.connector_id=r.id
                   ) total_apply_attempts,
                   (
                     select e.error_code
                       from source_connector_events e
                      where e.connector_id=r.id and e.error_code is not null
                      order by e.last_error_at desc nulls last,e.received_at desc
                      limit 1
                   ) last_error_code,
                   (
                     select count(*)::int
                       from source_connector_objects o
                      where o.connector_id=r.id and o.lifecycle='ACTIVE'
                   ) active_objects,
                   (
                     select count(*)::int
                       from source_connector_objects o
                      where o.connector_id=r.id and o.lifecycle='ACTIVE'
                        and o.permission_uncertain
                   ) uncertain_acl_objects,
                   (
                     select count(*)::int
                       from source_connector_objects o
                      where o.connector_id=r.id
                        and o.lifecycle='DELETED_TOMBSTONE'
                   ) tombstones
              from source_connector_registrations r
              join source_connector_checkpoints c on c.connector_id=r.id
             where r.space_id=any($1::uuid[]) and r.vault_id=any($2::uuid[])
             order by r.updated_at desc,r.id
             limit 100
            `,
          [scope.spaces, scope.vaultIds],
        ),
      ]);
      const telemetry = getOpenTelemetryStatus();
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
        observability: {
          enabled: telemetry.enabled,
          started: telemetry.started,
          serviceName: telemetry.serviceName,
          tracesExporter: telemetry.tracesExporter,
          metricsExporter: telemetry.metricsExporter,
          endpointConfigured: Boolean(telemetry.endpoint),
          protocol: telemetry.protocol,
          w3cTraceContext: telemetry.w3cTraceContext,
          logs: telemetry.logs,
          lastError: telemetry.lastError,
        },
        indexes: indexes.rows,
        outbox: outbox.rows,
        stuckJobs: stuck.rows,
        assurance: {
          runs: assuranceRuns.rows,
          openFindings: assuranceFindings.rows,
        },
        connectors: connectorStates.rows,
      });
    },
  );
}
