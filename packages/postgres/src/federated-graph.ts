import { createHash } from "node:crypto";
import {
  GraphDirection as GraphDirectionSchema,
  GraphDomain as GraphDomainSchema,
  GraphFreshnessPolicy as GraphFreshnessPolicySchema,
  GraphNodeIdentity as GraphNodeIdentitySchema,
  GraphPathResult as GraphPathResultSchema,
  GraphProjectionRevision as GraphProjectionRevisionSchema,
  GraphProvenanceEnvelope as GraphProvenanceEnvelopeSchema,
  GraphTraversalBounds as GraphTraversalBoundsSchema,
  graphNodeIdentityKey,
  type GraphAuthorizationScope,
  type GraphDirection,
  type GraphDomain,
  type GraphImpactQuery,
  type GraphImpactResult,
  type GraphNeighborQuery,
  type GraphNodeIdentity,
  type GraphNodeRef,
  type GraphNodeSelector,
  type GraphPathQuery,
  type GraphPathResult,
  type GraphPathStep,
  type GraphProjectionArtifact,
  type GraphProjectionEdgeInput,
  type GraphProjectionPort,
  type GraphProjectionRevision,
  type GraphProjectionRevisionState,
  type GraphQueryBase,
  type GraphQueryPort,
} from "@akp/contracts";
import {
  intersectVaultPathPrefixes,
  normalizeVaultPathPrefix,
  pathMatchesVaultPrefix,
} from "./vault-registry.js";
import type { Postgres, PostgresPoolClient } from "./index.js";

interface ProjectionRow {
  id: string;
  space_id: string;
  vault_id: string | null;
  graph_domain: GraphDomain;
  scope_id: string;
  revision: string;
  source_revision: string;
  source_hash: string | null;
  provider: string;
  provider_version: string | null;
  configuration_version: string;
  lifecycle: GraphProjectionRevision["lifecycle"];
  freshness: GraphProjectionRevision["freshness"];
  requested_at: Date | string;
  built_at: Date | string | null;
  activated_at: Date | string | null;
  last_successful_update: Date | string | null;
}

interface ActiveNodeRow {
  id: string;
  space_id: string;
  vault_id: string | null;
  graph_domain: GraphDomain;
  scope_id: string;
  kind: string;
  canonical_key: string;
  revision: string;
  authorization_path: string | null;
  payload: Record<string, unknown>;
  projection_id: string;
  projection_revision: string;
  projection_lifecycle: GraphProjectionRevision["lifecycle"];
  projection_freshness: GraphProjectionRevision["freshness"];
}

interface ActiveEdgeRow {
  id: string;
  owner_graph_domain: GraphDomain;
  from_node_id: string;
  to_node_id: string;
  relation_type: string;
  authorization_path: string | null;
  derivation: GraphProjectionEdgeInput["provenance"]["derivation"];
  source_ids: string[];
  evidence_ids: string[];
  locator_refs: string[];
  provenance_revision: string;
  support_set_id: string | null;
  confidence: number | null;
  valid_from: Date | string | null;
  valid_to: Date | string | null;
  recorded_at: Date | string;
}

interface LoadedGraph {
  nodes: Map<string, GraphNodeRef>;
  identityToNodeId: Map<string, string>;
  outgoing: Map<string, ActiveEdgeRow[]>;
  incoming: Map<string, ActiveEdgeRow[]>;
  authorizationPrefixes: Map<string, string | null>;
  allowSpaceScoped: boolean;
}

interface TraversalState {
  nodeId: string;
  visited: string[];
  steps: GraphPathStep[];
}

interface OrientedEdge {
  edge: ActiveEdgeRow;
  nextNodeId: string;
  direction: "outgoing" | "incoming";
}

function graphError(code: string): Error {
  const error = new Error(code) as Error & { code?: string };
  error.code = code;
  return error;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function mapProjection(row: ProjectionRow): GraphProjectionRevision {
  return GraphProjectionRevisionSchema.parse({
    id: row.id,
    graphDomain: row.graph_domain,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    scopeId: row.scope_id,
    revision: row.revision,
    sourceRevision: row.source_revision,
    sourceHash: row.source_hash,
    provider: row.provider,
    providerVersion: row.provider_version,
    configurationVersion: row.configuration_version,
    lifecycle: row.lifecycle,
    freshness: row.freshness,
    requestedAt: iso(row.requested_at),
    builtAt: iso(row.built_at),
    activatedAt: iso(row.activated_at),
    lastSuccessfulUpdate: iso(row.last_successful_update),
  });
}

function normalizeAuthorizationScope(
  authorization: GraphAuthorizationScope,
): Map<string, string | null> {
  const byVault = new Map<string, string | null>();
  for (const scope of authorization.vaults) {
    const normalized = normalizeVaultPathPrefix(scope.pathPrefix);
    if (normalized === undefined) throw graphError("GRAPH_AUTH_SCOPE_INVALID");
    const current = byVault.get(scope.vaultId);
    if (current === undefined && !byVault.has(scope.vaultId)) {
      byVault.set(scope.vaultId, normalized);
      continue;
    }
    const intersection = intersectVaultPathPrefixes(current, normalized);
    if (intersection === undefined) {
      byVault.delete(scope.vaultId);
      continue;
    }
    byVault.set(scope.vaultId, intersection);
  }
  return byVault;
}

function authorizationPath(
  value: string | null | undefined,
): string | null {
  const normalized = normalizeVaultPathPrefix(value);
  if (normalized === undefined) {
    throw graphError("GRAPH_AUTHORIZATION_PATH_INVALID");
  }
  return normalized;
}

function nodeAllowed(
  node: Pick<GraphNodeRef, "vaultId" | "authorizationPath">,
  prefixes: Map<string, string | null>,
  allowSpaceScoped: boolean,
): boolean {
  if (node.vaultId === null) {
    return allowSpaceScoped && node.authorizationPath === null;
  }
  if (!prefixes.has(node.vaultId)) return false;
  const prefix = prefixes.get(node.vaultId) ?? null;
  if (prefix === null) return true;
  if (node.authorizationPath === null) return false;
  return pathMatchesVaultPrefix(node.authorizationPath, prefix);
}

function edgeAllowed(
  edge: ActiveEdgeRow,
  from: GraphNodeRef,
  prefixes: Map<string, string | null>,
  allowSpaceScoped: boolean,
): boolean {
  if (from.vaultId === null) {
    return allowSpaceScoped && edge.authorization_path === null;
  }
  if (!prefixes.has(from.vaultId)) return false;
  const prefix = prefixes.get(from.vaultId) ?? null;
  if (prefix === null) return true;
  if (edge.authorization_path === null) return false;
  return pathMatchesVaultPrefix(edge.authorization_path, prefix);
}

function validateProjectionArtifact(input: GraphProjectionArtifact): void {
  GraphDomainSchema.parse(input.graphDomain);
  if (!input.scopeId.trim()) throw graphError("GRAPH_SCOPE_REQUIRED");
  if (!input.revision.trim()) throw graphError("GRAPH_REVISION_REQUIRED");
  if (!input.sourceRevision.trim())
    throw graphError("GRAPH_SOURCE_REVISION_REQUIRED");
  if (!input.provider.trim()) throw graphError("GRAPH_PROVIDER_REQUIRED");
  if (!input.configurationVersion.trim())
    throw graphError("GRAPH_CONFIGURATION_VERSION_REQUIRED");
  if (input.sourceHash && !/^[a-f0-9]{64}$/.test(input.sourceHash)) {
    throw graphError("GRAPH_SOURCE_HASH_INVALID");
  }

  const identities = new Set<string>();
  for (const node of input.nodes) {
    const identity = GraphNodeIdentitySchema.parse(node.identity);
    if (
      identity.graphDomain !== input.graphDomain ||
      identity.scopeId !== input.scopeId
    ) {
      throw graphError("GRAPH_PROJECTION_NODE_SCOPE_MISMATCH");
    }
    if (node.vaultId !== input.vaultId) {
      throw graphError("GRAPH_PROJECTION_NODE_VAULT_MISMATCH");
    }
    authorizationPath(node.authorizationPath);
    const key = graphNodeIdentityKey(identity);
    if (identities.has(key)) {
      throw graphError("GRAPH_PROJECTION_DUPLICATE_NODE");
    }
    identities.add(key);
  }

  for (const edge of input.edges) {
    const from = GraphNodeIdentitySchema.parse(edge.from);
    GraphNodeIdentitySchema.parse(edge.to);
    GraphProvenanceEnvelopeSchema.parse(edge.provenance);
    if (
      from.graphDomain !== input.graphDomain ||
      from.scopeId !== input.scopeId
    ) {
      throw graphError("GRAPH_BRIDGE_OWNER_SCOPE_MISMATCH");
    }
    const relation = edge.relation.trim();
    if (!relation || relation.length > 160) {
      throw graphError("GRAPH_RELATION_INVALID");
    }
    authorizationPath(edge.authorizationPath ?? null);
  }
}

function projectionMetadataMatches(
  row: ProjectionRow,
  artifact: GraphProjectionArtifact,
): boolean {
  return (
    row.vault_id === artifact.vaultId &&
    row.source_revision === artifact.sourceRevision &&
    row.source_hash === artifact.sourceHash &&
    row.provider === artifact.provider &&
    row.provider_version === artifact.providerVersion &&
    row.configuration_version === artifact.configurationVersion
  );
}

async function withTransaction<T>(
  db: Postgres,
  operation: (client: PostgresPoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const value = await operation(client);
    await client.query("commit");
    return value;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function projectionRow(
  queryable: Pick<PostgresPoolClient, "query">,
  spaceId: string,
  graphDomain: GraphDomain,
  scopeId: string,
  revision: string,
  forUpdate = false,
): Promise<ProjectionRow | null> {
  const result = await queryable.query<ProjectionRow>(
    `select *
       from federated_graph_projection_revisions
      where space_id=$1 and graph_domain=$2 and scope_id=$3 and revision=$4
      ${forUpdate ? "for update" : ""}`,
    [spaceId, graphDomain, scopeId, revision],
  );
  return result.rows[0] ?? null;
}

async function resolveNodeId(
  client: PostgresPoolClient,
  spaceId: string,
  identity: GraphNodeIdentity,
  known: Map<string, string>,
): Promise<string> {
  const key = graphNodeIdentityKey(identity);
  const cached = known.get(key);
  if (cached) return cached;
  const result = await client.query<{ id: string }>(
    `select id
       from federated_graph_nodes
      where space_id=$1 and graph_domain=$2 and scope_id=$3
        and kind=$4 and canonical_key=$5 and revision=$6`,
    [
      spaceId,
      identity.graphDomain,
      identity.scopeId,
      identity.kind,
      identity.canonicalKey,
      identity.revision,
    ],
  );
  const id = result.rows[0]?.id;
  if (!id) throw graphError("GRAPH_EDGE_NODE_NOT_FOUND");
  known.set(key, id);
  return id;
}

function activeNodeRef(row: ActiveNodeRow): GraphNodeRef {
  return {
    id: row.id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    authorizationPath: row.authorization_path,
    identity: {
      graphDomain: row.graph_domain,
      scopeId: row.scope_id,
      kind: row.kind,
      canonicalKey: row.canonical_key,
      revision: row.revision,
    },
    payload: row.payload ?? {},
    projection: {
      id: row.projection_id,
      revision: row.projection_revision,
      lifecycle: row.projection_lifecycle,
      freshness: row.projection_freshness,
    },
  };
}

function edgeProvenance(edge: ActiveEdgeRow) {
  return GraphProvenanceEnvelopeSchema.parse({
    derivation: edge.derivation,
    sourceIds: edge.source_ids ?? [],
    evidenceIds: edge.evidence_ids ?? [],
    locatorRefs: edge.locator_refs ?? [],
    revision: edge.provenance_revision,
    ...(edge.support_set_id ? { supportSetId: edge.support_set_id } : {}),
    ...(edge.confidence === null ? {} : { confidence: edge.confidence }),
    ...(edge.valid_from ? { validFrom: iso(edge.valid_from) } : {}),
    ...(edge.valid_to ? { validTo: iso(edge.valid_to) } : {}),
    recordedAt: iso(edge.recorded_at),
  });
}

function relationAllowlist(values: readonly string[]): string[] {
  if (values.length > 256) throw graphError("GRAPH_RELATION_ALLOWLIST_TOO_LARGE");
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  ].sort();
}

function domainAllowlist(values: readonly GraphDomain[] | undefined): GraphDomain[] {
  if (!values?.length) return [...GraphDomainSchema.options];
  return [...new Set(values.map((value) => GraphDomainSchema.parse(value)))];
}

function compositeRevision(values: Array<{ scopeId: string; revision: string }>): string {
  const sorted = values
    .map((value) => ({ scopeId: value.scopeId, revision: value.revision }))
    .sort(
      (left, right) =>
        left.scopeId.localeCompare(right.scopeId) ||
        left.revision.localeCompare(right.revision),
    );
  const unique = sorted.filter(
    (value, index) =>
      index === 0 ||
      value.scopeId !== sorted[index - 1]?.scopeId ||
      value.revision !== sorted[index - 1]?.revision,
  );
  if (unique.length === 1) return unique[0]!.revision;
  return `federated:${sha256(stableJson(unique))}`;
}

function revisionSetForPath(
  seed: GraphNodeRef,
  steps: readonly GraphPathStep[],
): Partial<Record<GraphDomain, string>> {
  const byDomain = new Map<GraphDomain, Array<{ scopeId: string; revision: string }>>();
  const nodes = [seed, ...steps.map((step) => step.to)];
  for (const node of nodes) {
    const entries = byDomain.get(node.identity.graphDomain) ?? [];
    entries.push({
      scopeId: node.identity.scopeId,
      revision: node.projection.revision,
    });
    byDomain.set(node.identity.graphDomain, entries);
  }
  return Object.fromEntries(
    [...byDomain.entries()].map(([domain, revisions]) => [
      domain,
      compositeRevision(revisions),
    ]),
  ) as Partial<Record<GraphDomain, string>>;
}

function pathSignature(path: GraphPathResult): string {
  return [
    String(path.steps.length).padStart(4, "0"),
    graphNodeIdentityKey(path.target.identity),
    ...path.steps.map(
      (step) =>
        `${step.direction}:${step.relation}:${graphNodeIdentityKey(step.to.identity)}`,
    ),
  ].join("|");
}

export class PostgresFederatedGraphStore
  implements GraphQueryPort, GraphProjectionPort<GraphProjectionArtifact>
{
  constructor(private readonly db: Postgres) {}

  async build(input: GraphProjectionArtifact): Promise<GraphProjectionRevision> {
    validateProjectionArtifact(input);
    const requested = await this.db.pool.query<ProjectionRow>(
      `insert into federated_graph_projection_revisions(
         space_id,vault_id,graph_domain,scope_id,revision,source_revision,
         source_hash,provider,provider_version,configuration_version,
         lifecycle,freshness
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'REQUESTED','FRESH')
       on conflict(space_id,graph_domain,scope_id,revision) do nothing
       returning *`,
      [
        input.spaceId,
        input.vaultId,
        input.graphDomain,
        input.scopeId,
        input.revision,
        input.sourceRevision,
        input.sourceHash,
        input.provider,
        input.providerVersion,
        input.configurationVersion,
      ],
    );
    let requestRow =
      requested.rows[0] ??
      (await projectionRow(
        this.db.pool,
        input.spaceId,
        input.graphDomain,
        input.scopeId,
        input.revision,
      ));
    if (!requestRow) throw graphError("GRAPH_PROJECTION_REQUEST_FAILED");
    if (!projectionMetadataMatches(requestRow, input)) {
      throw graphError("GRAPH_PROJECTION_REVISION_CONFLICT");
    }
    if (requestRow.lifecycle === "ACTIVE" || requestRow.lifecycle === "STALE") {
      return mapProjection(requestRow);
    }
    if (requestRow.lifecycle !== "REQUESTED") {
      const reset = await this.db.pool.query<ProjectionRow>(
        `update federated_graph_projection_revisions
            set lifecycle='REQUESTED',freshness='FRESH',error=null,
                requested_at=now(),built_at=null,activated_at=null,
                last_successful_update=null,updated_at=now()
          where id=$1
          returning *`,
        [requestRow.id],
      );
      requestRow = reset.rows[0] ?? requestRow;
    }

    try {
      return await withTransaction(this.db, async (client) => {
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1,0))",
          [`${input.spaceId}|${input.graphDomain}|${input.scopeId}`],
        );
        const locked = await projectionRow(
          client,
          input.spaceId,
          input.graphDomain,
          input.scopeId,
          input.revision,
          true,
        );
        if (!locked) throw graphError("GRAPH_PROJECTION_REQUEST_FAILED");
        if (locked.lifecycle === "ACTIVE" || locked.lifecycle === "STALE") {
          return mapProjection(locked);
        }

        const nodeIds = new Map<string, string>();
        for (const node of input.nodes) {
          const identity = GraphNodeIdentitySchema.parse(node.identity);
          const normalizedPath = authorizationPath(node.authorizationPath);
          const payloadHash = sha256(stableJson(node.payload));
          const inserted = await client.query<{
            id: string;
            payload_hash: string;
            vault_id: string | null;
            authorization_path: string | null;
          }>(
            `insert into federated_graph_nodes(
               space_id,vault_id,graph_domain,scope_id,kind,canonical_key,
               revision,authorization_path,payload,payload_hash
             ) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
             on conflict(space_id,graph_domain,scope_id,kind,canonical_key,revision)
             do nothing
             returning id,payload_hash,vault_id,authorization_path`,
            [
              input.spaceId,
              node.vaultId,
              identity.graphDomain,
              identity.scopeId,
              identity.kind,
              identity.canonicalKey,
              identity.revision,
              normalizedPath,
              JSON.stringify(node.payload),
              payloadHash,
            ],
          );
          let persisted = inserted.rows[0];
          if (!persisted) {
            const existing = await client.query<{
              id: string;
              payload_hash: string;
              vault_id: string | null;
              authorization_path: string | null;
            }>(
              `select id,payload_hash,vault_id,authorization_path
                 from federated_graph_nodes
                where space_id=$1 and graph_domain=$2 and scope_id=$3
                  and kind=$4 and canonical_key=$5 and revision=$6`,
              [
                input.spaceId,
                identity.graphDomain,
                identity.scopeId,
                identity.kind,
                identity.canonicalKey,
                identity.revision,
              ],
            );
            persisted = existing.rows[0];
          }
          if (
            !persisted ||
            persisted.payload_hash !== payloadHash ||
            persisted.vault_id !== node.vaultId ||
            persisted.authorization_path !== normalizedPath
          ) {
            throw graphError("GRAPH_NODE_IDENTITY_CONFLICT");
          }
          nodeIds.set(graphNodeIdentityKey(identity), persisted.id);
          await client.query(
            `insert into federated_graph_projection_nodes(
               projection_revision_id,node_id
             ) values($1,$2)
             on conflict do nothing`,
            [locked.id, persisted.id],
          );
        }

        for (const edge of input.edges) {
          const fromIdentity = GraphNodeIdentitySchema.parse(edge.from);
          const toIdentity = GraphNodeIdentitySchema.parse(edge.to);
          const provenance = GraphProvenanceEnvelopeSchema.parse(edge.provenance);
          const fromId = await resolveNodeId(
            client,
            input.spaceId,
            fromIdentity,
            nodeIds,
          );
          const toId = await resolveNodeId(
            client,
            input.spaceId,
            toIdentity,
            nodeIds,
          );
          const relation = edge.relation.trim();
          const edgePath = authorizationPath(edge.authorizationPath ?? null);
          const provenanceHash = sha256(stableJson(provenance));
          const inserted = await client.query<{
            id: string;
            authorization_path: string | null;
          }>(
            `insert into federated_graph_edges(
               space_id,owner_graph_domain,from_node_id,to_node_id,
               relation_type,authorization_path,derivation,source_ids,
               evidence_ids,locator_refs,provenance_revision,support_set_id,
               confidence,valid_from,valid_to,recorded_at,provenance_hash
             ) values(
               $1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11,
               $12,$13,$14,$15,$16,$17
             )
             on conflict(
               space_id,owner_graph_domain,from_node_id,to_node_id,
               relation_type,provenance_revision,derivation,provenance_hash
             ) do nothing
             returning id,authorization_path`,
            [
              input.spaceId,
              input.graphDomain,
              fromId,
              toId,
              relation,
              edgePath,
              provenance.derivation,
              JSON.stringify(provenance.sourceIds),
              JSON.stringify(provenance.evidenceIds),
              JSON.stringify(provenance.locatorRefs),
              provenance.revision,
              provenance.supportSetId ?? null,
              provenance.confidence ?? null,
              provenance.validFrom ?? null,
              provenance.validTo ?? null,
              provenance.recordedAt,
              provenanceHash,
            ],
          );
          let persisted = inserted.rows[0];
          if (!persisted) {
            const existing = await client.query<{
              id: string;
              authorization_path: string | null;
            }>(
              `select id,authorization_path
                 from federated_graph_edges
                where space_id=$1 and owner_graph_domain=$2
                  and from_node_id=$3 and to_node_id=$4
                  and relation_type=$5 and provenance_revision=$6
                  and derivation=$7 and provenance_hash=$8`,
              [
                input.spaceId,
                input.graphDomain,
                fromId,
                toId,
                relation,
                provenance.revision,
                provenance.derivation,
                provenanceHash,
              ],
            );
            persisted = existing.rows[0];
          }
          if (!persisted || persisted.authorization_path !== edgePath) {
            throw graphError("GRAPH_EDGE_IDENTITY_CONFLICT");
          }
          await client.query(
            `insert into federated_graph_projection_edges(
               projection_revision_id,edge_id
             ) values($1,$2)
             on conflict do nothing`,
            [locked.id, persisted.id],
          );
        }

        await client.query(
          `update federated_graph_projection_revisions
              set lifecycle='BUILT',freshness='FRESH',built_at=now(),
                  last_successful_update=now(),error=null,updated_at=now()
            where id=$1`,
          [locked.id],
        );
        await client.query(
          `update federated_graph_projection_revisions
              set lifecycle='STALE',freshness='STALE',updated_at=now()
            where space_id=$1 and graph_domain=$2 and scope_id=$3
              and lifecycle='ACTIVE' and id<>$4`,
          [input.spaceId, input.graphDomain, input.scopeId, locked.id],
        );
        const activated = await client.query<ProjectionRow>(
          `update federated_graph_projection_revisions
              set lifecycle='ACTIVE',freshness='FRESH',activated_at=now(),
                  last_successful_update=now(),updated_at=now()
            where id=$1
            returning *`,
          [locked.id],
        );
        const row = activated.rows[0];
        if (!row) throw graphError("GRAPH_PROJECTION_ACTIVATION_FAILED");
        return mapProjection(row);
      });
    } catch (error) {
      await this.db.pool
        .query(
          `update federated_graph_projection_revisions
              set lifecycle='FAILED',freshness='STALE',
                  error=$2::jsonb,updated_at=now()
            where id=$1 and lifecycle not in ('ACTIVE','STALE')`,
          [
            requestRow.id,
            JSON.stringify({
              code: error instanceof Error ? error.message : String(error),
            }),
          ],
        )
        .catch(() => undefined);
      throw error;
    }
  }

  async update(input: {
    baseRevision: string;
    next: GraphProjectionArtifact;
  }): Promise<GraphProjectionRevision> {
    const state = await this.revisionState(
      input.next.graphDomain,
      input.next.spaceId,
      input.next.scopeId,
    );
    if (state.activeRevision !== input.baseRevision) {
      throw graphError("GRAPH_PROJECTION_BASE_REVISION_CHANGED");
    }
    return this.build(input.next);
  }

  async revisionState(
    domain: GraphDomain,
    spaceId: string,
    scopeId: string,
  ): Promise<GraphProjectionRevisionState> {
    GraphDomainSchema.parse(domain);
    const result = await this.db.pool.query<{
      requested_revision: string | null;
      built_revision: string | null;
      active_revision: string | null;
      active_freshness: GraphProjectionRevision["freshness"] | null;
      last_successful_update: Date | string | null;
      vault_id: string | null;
    }>(
      `select
         (
           select revision
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain=$2 and scope_id=$3
            order by requested_at desc,id desc
            limit 1
         ) requested_revision,
         (
           select revision
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain=$2 and scope_id=$3
              and built_at is not null
            order by built_at desc,id desc
            limit 1
         ) built_revision,
         (
           select revision
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain=$2 and scope_id=$3
              and lifecycle='ACTIVE'
            order by activated_at desc nulls last,id desc
            limit 1
         ) active_revision,
         (
           select freshness
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain=$2 and scope_id=$3
              and lifecycle='ACTIVE'
            order by activated_at desc nulls last,id desc
            limit 1
         ) active_freshness,
         (
           select last_successful_update
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain=$2 and scope_id=$3
              and last_successful_update is not null
            order by last_successful_update desc,id desc
            limit 1
         ) last_successful_update,
         (
           select vault_id
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain=$2 and scope_id=$3
            order by requested_at desc,id desc
            limit 1
         ) vault_id`,
      [spaceId, domain, scopeId],
    );
    const row = result.rows[0];
    return {
      graphDomain: domain,
      spaceId,
      vaultId: row?.vault_id ?? null,
      scopeId,
      requestedRevision: row?.requested_revision ?? null,
      builtRevision: row?.built_revision ?? null,
      activeRevision: row?.active_revision ?? null,
      activeFreshness: row?.active_freshness ?? null,
      lastSuccessfulUpdate: iso(row?.last_successful_update ?? null),
    };
  }

  async neighbors(input: GraphNeighborQuery): Promise<GraphPathResult[]> {
    return this.traverse({
      ...input,
      bounds: { ...input.bounds, maxHops: 1 },
    });
  }

  async paths(input: GraphPathQuery): Promise<GraphPathResult[]> {
    return this.traverse(input);
  }

  async impact(input: GraphImpactQuery): Promise<GraphImpactResult> {
    const graph = await this.loadGraph(input);
    const seed = this.resolveSelector(graph, input.seed);
    const affected = await this.traverseLoaded(graph, input, seed, undefined);
    const revisions = new Map<GraphDomain, string[]>();
    for (const path of affected) {
      for (const [domain, revision] of Object.entries(path.revisionSet) as Array<
        [GraphDomain, string | undefined]
      >) {
        if (!revision) continue;
        const values = revisions.get(domain) ?? [];
        values.push(revision);
        revisions.set(domain, values);
      }
    }
    return {
      seed,
      affected,
      revisionSet: Object.fromEntries(
        [...revisions.entries()].map(([domain, values]) => [
          domain,
          compositeRevision(
            [...new Set(values)].map((revision) => ({
              scopeId: domain,
              revision,
            })),
          ),
        ]),
      ) as Partial<Record<GraphDomain, string>>,
    };
  }

  private async traverse(input: GraphPathQuery): Promise<GraphPathResult[]> {
    const graph = await this.loadGraph(input);
    const seed = this.resolveSelector(graph, input.seed);
    const target = input.target
      ? this.resolveSelector(graph, input.target)
      : undefined;
    return this.traverseLoaded(graph, input, seed, target);
  }

  private async loadGraph(input: GraphQueryBase): Promise<LoadedGraph> {
    const bounds = GraphTraversalBoundsSchema.parse(input.bounds);
    void bounds;
    GraphDirectionSchema.parse(input.direction);
    GraphFreshnessPolicySchema.parse(input.freshnessPolicy);
    const domains = domainAllowlist(input.domains);
    const prefixes = normalizeAuthorizationScope(input.authorization);
    const freshnessClause =
      input.freshnessPolicy === "FRESH_ONLY"
        ? "and pr.freshness='FRESH'"
        : "";

    const nodesResult = await this.db.pool.query<ActiveNodeRow>(
      `select distinct on (n.id)
         n.id,n.space_id,n.vault_id,n.graph_domain,n.scope_id,n.kind,
         n.canonical_key,n.revision,n.authorization_path,n.payload,
         pr.id projection_id,pr.revision projection_revision,
         pr.lifecycle projection_lifecycle,pr.freshness projection_freshness
       from federated_graph_nodes n
       join federated_graph_projection_nodes pn on pn.node_id=n.id
       join federated_graph_projection_revisions pr
         on pr.id=pn.projection_revision_id
        and pr.space_id=n.space_id
        and pr.graph_domain=n.graph_domain
        and pr.scope_id=n.scope_id
      where n.space_id=$1
        and n.graph_domain=any($2::text[])
        and pr.lifecycle='ACTIVE'
        ${freshnessClause}
      order by n.id,pr.activated_at desc nulls last,pr.id`,
      [input.authorization.spaceId, domains],
    );

    const nodes = new Map<string, GraphNodeRef>();
    const identityToNodeId = new Map<string, string>();
    for (const row of nodesResult.rows) {
      const node = activeNodeRef(row);
      if (
        !nodeAllowed(
          node,
          prefixes,
          input.authorization.allowSpaceScoped === true,
        )
      ) {
        continue;
      }
      nodes.set(node.id, node);
      identityToNodeId.set(graphNodeIdentityKey(node.identity), node.id);
    }

    const outgoing = new Map<string, ActiveEdgeRow[]>();
    const incoming = new Map<string, ActiveEdgeRow[]>();
    const relations = relationAllowlist(input.relationAllowlist);
    if (nodes.size > 0 && relations.length > 0) {
      const edges = await this.db.pool.query<ActiveEdgeRow>(
        `select distinct on (e.id)
           e.id,e.owner_graph_domain,e.from_node_id,e.to_node_id,
           e.relation_type,e.authorization_path,e.derivation,
           e.source_ids,e.evidence_ids,e.locator_refs,e.provenance_revision,
           e.support_set_id,e.confidence,e.valid_from,e.valid_to,e.recorded_at
         from federated_graph_edges e
         join federated_graph_projection_edges pe on pe.edge_id=e.id
         join federated_graph_projection_revisions pr
           on pr.id=pe.projection_revision_id
          and pr.space_id=e.space_id
          and pr.graph_domain=e.owner_graph_domain
        where e.space_id=$1
          and e.relation_type=any($2::text[])
          and pr.lifecycle='ACTIVE'
          ${freshnessClause}
        order by e.id,pr.activated_at desc nulls last,pr.id`,
        [input.authorization.spaceId, relations],
      );
      for (const edge of edges.rows) {
        const from = nodes.get(edge.from_node_id);
        const to = nodes.get(edge.to_node_id);
        if (!from || !to) continue;
        if (
          !edgeAllowed(
            edge,
            from,
            prefixes,
            input.authorization.allowSpaceScoped === true,
          )
        ) {
          continue;
        }
        const out = outgoing.get(edge.from_node_id) ?? [];
        out.push(edge);
        outgoing.set(edge.from_node_id, out);
        const inc = incoming.get(edge.to_node_id) ?? [];
        inc.push(edge);
        incoming.set(edge.to_node_id, inc);
      }
    }

    const sortEdges = (left: ActiveEdgeRow, right: ActiveEdgeRow) =>
      left.relation_type.localeCompare(right.relation_type) ||
      graphNodeIdentityKey(nodes.get(left.to_node_id)!.identity).localeCompare(
        graphNodeIdentityKey(nodes.get(right.to_node_id)!.identity),
      ) ||
      left.id.localeCompare(right.id);
    for (const edges of outgoing.values()) edges.sort(sortEdges);
    for (const edges of incoming.values()) {
      edges.sort(
        (left, right) =>
          left.relation_type.localeCompare(right.relation_type) ||
          (nodes.get(left.from_node_id)
            ? graphNodeIdentityKey(nodes.get(left.from_node_id)!.identity)
            : left.from_node_id
          ).localeCompare(
            nodes.get(right.from_node_id)
              ? graphNodeIdentityKey(nodes.get(right.from_node_id)!.identity)
              : right.from_node_id,
          ) ||
          left.id.localeCompare(right.id),
      );
    }

    return {
      nodes,
      identityToNodeId,
      outgoing,
      incoming,
      authorizationPrefixes: prefixes,
      allowSpaceScoped: input.authorization.allowSpaceScoped === true,
    };
  }

  private resolveSelector(
    graph: LoadedGraph,
    selector: GraphNodeSelector,
  ): GraphNodeRef {
    const byId = selector.nodeId?.trim();
    const byIdentity = selector.identity
      ? graph.identityToNodeId.get(
          graphNodeIdentityKey(GraphNodeIdentitySchema.parse(selector.identity)),
        )
      : undefined;
    if (byId && byIdentity && byId !== byIdentity) {
      throw graphError("GRAPH_SELECTOR_CONFLICT");
    }
    const id = byId || byIdentity;
    const node = id ? graph.nodes.get(id) : undefined;
    if (!node) throw graphError("GRAPH_NODE_NOT_FOUND_OR_UNAUTHORIZED");
    return node;
  }

  private orientedEdges(
    graph: LoadedGraph,
    nodeId: string,
    direction: GraphDirection,
    maxFanout: number,
  ): OrientedEdge[] {
    const candidates: OrientedEdge[] = [];
    if (direction === "outgoing" || direction === "both") {
      for (const edge of graph.outgoing.get(nodeId) ?? []) {
        candidates.push({
          edge,
          nextNodeId: edge.to_node_id,
          direction: "outgoing",
        });
      }
    }
    if (direction === "incoming" || direction === "both") {
      for (const edge of graph.incoming.get(nodeId) ?? []) {
        candidates.push({
          edge,
          nextNodeId: edge.from_node_id,
          direction: "incoming",
        });
      }
    }
    candidates.sort((left, right) => {
      const leftNode = graph.nodes.get(left.nextNodeId);
      const rightNode = graph.nodes.get(right.nextNodeId);
      return (
        left.edge.relation_type.localeCompare(right.edge.relation_type) ||
        (leftNode
          ? graphNodeIdentityKey(leftNode.identity)
          : left.nextNodeId
        ).localeCompare(
          rightNode
            ? graphNodeIdentityKey(rightNode.identity)
            : right.nextNodeId,
        ) ||
        left.direction.localeCompare(right.direction) ||
        left.edge.id.localeCompare(right.edge.id)
      );
    });
    return candidates.slice(0, maxFanout);
  }

  private async traverseLoaded(
    graph: LoadedGraph,
    input: GraphPathQuery | GraphImpactQuery,
    seed: GraphNodeRef,
    target: GraphNodeRef | undefined,
  ): Promise<GraphPathResult[]> {
    const bounds = GraphTraversalBoundsSchema.parse(input.bounds);
    const deadline = Date.now() + bounds.timeBudgetMs;
    const frontier: TraversalState[] = [
      { nodeId: seed.id, visited: [seed.id], steps: [] },
    ];
    const bestByTarget = new Map<string, GraphPathResult>();

    while (frontier.length > 0) {
      if (Date.now() > deadline) {
        throw graphError("GRAPH_QUERY_TIME_BUDGET_EXCEEDED");
      }
      const current = frontier.shift()!;
      if (current.steps.length >= bounds.maxHops) continue;
      const edges = this.orientedEdges(
        graph,
        current.nodeId,
        input.direction,
        bounds.maxFanout,
      );
      for (const oriented of edges) {
        if (current.visited.includes(oriented.nextNodeId)) continue;
        const from = graph.nodes.get(current.nodeId);
        const to = graph.nodes.get(oriented.nextNodeId);
        if (!from || !to) continue;
        const step: GraphPathStep = {
          from,
          relation: oriented.edge.relation_type,
          direction: oriented.direction,
          to,
          provenance: edgeProvenance(oriented.edge),
        };
        const steps = [...current.steps, step];
        const result = GraphPathResultSchema.parse({
          seed,
          target: to,
          steps,
          revisionSet: revisionSetForPath(seed, steps),
        });
        if (!target || target.id === to.id) {
          const existing = bestByTarget.get(to.id);
          if (!existing || pathSignature(result) < pathSignature(existing)) {
            bestByTarget.set(to.id, result);
          }
        }
        if (
          (!target || target.id !== to.id) &&
          steps.length < bounds.maxHops
        ) {
          frontier.push({
            nodeId: to.id,
            visited: [...current.visited, to.id],
            steps,
          });
        }
        if (bestByTarget.size >= bounds.maxCandidates && !target) break;
      }
      if (bestByTarget.size >= bounds.maxCandidates && !target) break;
      if (target && bestByTarget.has(target.id)) break;
    }

    return [...bestByTarget.values()]
      .sort((left, right) => pathSignature(left).localeCompare(pathSignature(right)))
      .slice(0, bounds.maxCandidates);
  }
}
