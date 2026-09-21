import { createHash } from "node:crypto";
import {
  intersectVaultPathPrefixes,
  normalizeVaultPathPrefix,
  pathMatchesVaultPrefix,
} from "./vault-registry.js";
import { appendOutboxEvent } from "./outbox.js";
import type { Postgres, PostgresPoolClient } from "./index.js";

// Keep the persistence adapter structurally compatible with @akp/contracts
// without importing contract source into this package's rootDir. Public/API
// boundaries validate the canonical contract; this adapter enforces the same
// invariants needed for durable storage and traversal.
const GRAPH_DOMAINS = [
  "EPISTEMIC",
  "SOFTWARE_CATALOG",
  "CODE",
  "RUNTIME",
  "TEMPORAL",
  "WORK",
  "COMMUNITY",
] as const;
type GraphDomain = (typeof GRAPH_DOMAINS)[number];

const GRAPH_DERIVATIONS = [
  "SOURCE_EXPLICIT",
  "DETERMINISTIC_EXTRACTED",
  "STATICALLY_RESOLVED",
  "MODEL_INFERRED",
  "HUMAN_ASSERTED",
  "RUNTIME_OBSERVED",
  "DYNAMICALLY_PROVEN",
  "DERIVED_SUMMARY",
] as const;
type GraphDerivation = (typeof GRAPH_DERIVATIONS)[number];

const GRAPH_RELATIONSHIP_LIFECYCLES = [
  "ACTIVE",
  "DISPUTED",
  "SUPERSEDED",
  "RETIRED",
] as const;
type GraphRelationshipLifecycle =
  (typeof GRAPH_RELATIONSHIP_LIFECYCLES)[number];

type GraphDirection = "outgoing" | "incoming" | "both";
type GraphFreshnessPolicy = "FRESH_ONLY" | "ALLOW_STALE";

export const MAX_GRAPH_NODE_LOOKUP_LIMIT = 1000;
type GraphProjectionLifecycle =
  "REQUESTED" | "BUILT" | "ACTIVE" | "STALE" | "FAILED";
type GraphProjectionFreshness = "FRESH" | "STALE";
type GraphCatalogStatus =
  "READY" | "BUILDING" | "STALE" | "DEGRADED" | "UNAVAILABLE";

const GRAPH_CATALOG_CAPABILITIES: Readonly<
  Record<GraphDomain, readonly string[]>
> = {
  EPISTEMIC: ["typed-traversal", "provenance", "support"],
  SOFTWARE_CATALOG: ["declared-topology", "ownership", "typed-traversal"],
  CODE: ["symbol-structure", "typed-traversal", "impact"],
  RUNTIME: ["runtime-observation", "temporal-window", "typed-traversal"],
  TEMPORAL: ["temporal-validity", "typed-traversal"],
  WORK: ["work-activity", "typed-traversal"],
  COMMUNITY: ["derived-index", "typed-traversal"],
};

interface GraphCatalogEntry {
  domain: GraphDomain;
  spaceId: string;
  vaultId: string | null;
  scopeId: string;
  activeRevision?: string;
  sourceRevision?: string;
  builder: string;
  builderVersion: string;
  configHash: string;
  status: GraphCatalogStatus;
  capabilities: string[];
  lastSuccessfulBuild?: string;
}

interface GraphCatalogQuery {
  authorization: GraphAuthorizationScope;
  domains?: readonly GraphDomain[];
  scopeIds?: readonly string[];
}

interface GraphNodeIdentity {
  graphDomain: GraphDomain;
  scopeId: string;
  kind: string;
  canonicalKey: string;
  revision: string;
}

interface GraphProvenanceEnvelope {
  derivation: GraphDerivation;
  sourceIds: string[];
  evidenceIds: string[];
  locatorRefs: string[];
  revision: string;
  supportSetId?: string;
  confidence?: number;
  validFrom?: string;
  validTo?: string;
  recordedAt: string;
}

interface GraphRelationshipAssertion {
  id: string;
  spaceId: string;
  ownerGraphDomain: GraphDomain;
  fromNodeId: string;
  toNodeId: string;
  relation: string;
  authorizationPath: string | null;
  lifecycle: GraphRelationshipLifecycle;
  provenance: GraphProvenanceEnvelope;
}

export interface GraphProjectionRevision {
  id: string;
  graphDomain: GraphDomain;
  spaceId: string;
  vaultId: string | null;
  scopeId: string;
  revision: string;
  sourceRevision: string;
  sourceHash: string | null;
  provider: string;
  providerVersion: string | null;
  configurationVersion: string;
  lifecycle: GraphProjectionLifecycle;
  freshness: GraphProjectionFreshness;
  requestedAt: string;
  builtAt: string | null;
  activatedAt: string | null;
  lastSuccessfulUpdate: string | null;
}

interface GraphNodeRef {
  id: string;
  spaceId: string;
  vaultId: string | null;
  authorizationPath: string | null;
  identity: GraphNodeIdentity;
  payload: Record<string, unknown>;
  projection: Pick<
    GraphProjectionRevision,
    "id" | "revision" | "lifecycle" | "freshness"
  >;
}

interface GraphPathStep {
  from: GraphNodeRef;
  relation: string;
  direction: "outgoing" | "incoming";
  to: GraphNodeRef;
  assertion: GraphRelationshipAssertion;
  provenance: GraphProvenanceEnvelope;
}

interface GraphPathResult {
  seed: GraphNodeRef;
  target: GraphNodeRef;
  steps: GraphPathStep[];
  score?: number;
  revisionSet: Partial<Record<GraphDomain, string>>;
}

interface GraphTraversalBounds {
  maxHops: number;
  maxFanout: number;
  maxCandidates: number;
  timeBudgetMs: number;
}

interface GraphAuthorizationScope {
  spaceId: string;
  vaults: readonly { vaultId: string; pathPrefix: string | null }[];
  allowSpaceScoped?: boolean;
}

interface GraphNodeSelector {
  nodeId?: string;
  identity?: GraphNodeIdentity;
}

interface GraphQueryBase {
  authorization: GraphAuthorizationScope;
  domains?: readonly GraphDomain[];
  relationAllowlist: readonly string[];
  direction: GraphDirection;
  freshnessPolicy: GraphFreshnessPolicy;
  bounds: GraphTraversalBounds;
}

interface GraphNodeLookupQuery {
  authorization: GraphAuthorizationScope;
  domains?: readonly GraphDomain[];
  kinds?: readonly string[];
  canonicalKeys?: readonly string[];
  payloadContains?: Readonly<Record<string, string | number | boolean>>;
  freshnessPolicy: GraphFreshnessPolicy;
  limit: number;
}

interface GraphNeighborQuery extends GraphQueryBase {
  seed: GraphNodeSelector;
}

interface GraphPathQuery extends GraphQueryBase {
  seed: GraphNodeSelector;
  target?: GraphNodeSelector;
}

interface GraphImpactQuery extends GraphQueryBase {
  seed: GraphNodeSelector;
}

interface GraphImpactResult {
  seed: GraphNodeRef;
  affected: GraphPathResult[];
  revisionSet: Partial<Record<GraphDomain, string>>;
}

interface GraphProjectionRevisionState {
  graphDomain: GraphDomain;
  spaceId: string;
  vaultId: string | null;
  scopeId: string;
  requested: GraphProjectionRevision | null;
  built: GraphProjectionRevision | null;
  active: GraphProjectionRevision | null;
  requestedRevision: string | null;
  builtRevision: string | null;
  activeRevision: string | null;
  activeFreshness: GraphProjectionFreshness | null;
  lastSuccessfulUpdate: string | null;
}

interface GraphProjectionNodeInput {
  identity: GraphNodeIdentity;
  vaultId: string | null;
  authorizationPath: string | null;
  payload: Record<string, unknown>;
}

interface GraphProjectionEdgeInput {
  from: GraphNodeIdentity;
  relation: string;
  to: GraphNodeIdentity;
  authorizationPath?: string | null;
  assertionLifecycle?: GraphRelationshipLifecycle;
  provenance: GraphProvenanceEnvelope;
}

interface GraphProjectionArtifact {
  graphDomain: GraphDomain;
  spaceId: string;
  vaultId: string | null;
  scopeId: string;
  revision: string;
  sourceRevision: string;
  sourceHash: string | null;
  provider: string;
  providerVersion: string | null;
  configurationVersion: string;
  nodes: readonly GraphProjectionNodeInput[];
  edges: readonly GraphProjectionEdgeInput[];
}

interface GraphQueryPort {
  findNodes(input: GraphNodeLookupQuery): Promise<GraphNodeRef[]>;
  neighbors(input: GraphNeighborQuery): Promise<GraphPathResult[]>;
  paths(input: GraphPathQuery): Promise<GraphPathResult[]>;
  impact(input: GraphImpactQuery): Promise<GraphImpactResult>;
  revisionState(
    domain: GraphDomain,
    spaceId: string,
    scopeId: string,
  ): Promise<GraphProjectionRevisionState>;
}

interface GraphProjectionPort<TArtifact = GraphProjectionArtifact> {
  build(input: TArtifact): Promise<GraphProjectionRevision>;
  update?(input: {
    baseRevision: string;
    next: TArtifact;
  }): Promise<GraphProjectionRevision>;
}

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requiredString(
  value: unknown,
  maxLength: number,
  code: string,
): string {
  if (typeof value !== "string") throw graphError(code);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw graphError(code);
  return normalized;
}

function parseGraphDomain(value: unknown): GraphDomain {
  if (
    typeof value !== "string" ||
    !(GRAPH_DOMAINS as readonly string[]).includes(value)
  ) {
    throw graphError("GRAPH_DOMAIN_INVALID");
  }
  return value as GraphDomain;
}

function parseGraphRelationshipLifecycle(
  value: unknown,
): GraphRelationshipLifecycle {
  if (
    typeof value !== "string" ||
    !(GRAPH_RELATIONSHIP_LIFECYCLES as readonly string[]).includes(value)
  ) {
    throw graphError("GRAPH_RELATIONSHIP_LIFECYCLE_INVALID");
  }
  return value as GraphRelationshipLifecycle;
}

function parseGraphDirection(value: unknown): GraphDirection {
  if (value !== "outgoing" && value !== "incoming" && value !== "both") {
    throw graphError("GRAPH_DIRECTION_INVALID");
  }
  return value;
}

function parseGraphFreshnessPolicy(value: unknown): GraphFreshnessPolicy {
  if (value !== "FRESH_ONLY" && value !== "ALLOW_STALE") {
    throw graphError("GRAPH_FRESHNESS_POLICY_INVALID");
  }
  return value;
}

function parseGraphNodeIdentity(value: GraphNodeIdentity): GraphNodeIdentity {
  return {
    graphDomain: parseGraphDomain(value.graphDomain),
    scopeId: requiredString(value.scopeId, 512, "GRAPH_SCOPE_REQUIRED"),
    kind: requiredString(value.kind, 120, "GRAPH_NODE_KIND_INVALID"),
    canonicalKey: requiredString(
      value.canonicalKey,
      2048,
      "GRAPH_CANONICAL_KEY_INVALID",
    ),
    revision: requiredString(value.revision, 512, "GRAPH_REVISION_REQUIRED"),
  };
}

function parseGraphProvenanceEnvelope(
  value: GraphProvenanceEnvelope,
): GraphProvenanceEnvelope {
  if (!(GRAPH_DERIVATIONS as readonly string[]).includes(value.derivation)) {
    throw graphError("GRAPH_PROVENANCE_DERIVATION_INVALID");
  }
  const boundedList = (
    entries: readonly string[],
    maxItems: number,
    maxLength: number,
    code: string,
  ): string[] => {
    if (!Array.isArray(entries) || entries.length > maxItems) {
      throw graphError(code);
    }
    return entries.map((entry) => requiredString(entry, maxLength, code));
  };
  const revision = requiredString(
    value.revision,
    512,
    "GRAPH_PROVENANCE_REVISION_REQUIRED",
  );
  const recordedAt = requiredString(
    value.recordedAt,
    128,
    "GRAPH_PROVENANCE_RECORDED_AT_INVALID",
  );
  if (Number.isNaN(Date.parse(recordedAt))) {
    throw graphError("GRAPH_PROVENANCE_RECORDED_AT_INVALID");
  }
  const validFrom = value.validFrom
    ? requiredString(
        value.validFrom,
        128,
        "GRAPH_PROVENANCE_VALID_FROM_INVALID",
      )
    : undefined;
  const validTo = value.validTo
    ? requiredString(value.validTo, 128, "GRAPH_PROVENANCE_VALID_TO_INVALID")
    : undefined;
  if (validFrom && Number.isNaN(Date.parse(validFrom))) {
    throw graphError("GRAPH_PROVENANCE_VALID_FROM_INVALID");
  }
  if (validTo && Number.isNaN(Date.parse(validTo))) {
    throw graphError("GRAPH_PROVENANCE_VALID_TO_INVALID");
  }
  if (validFrom && validTo && Date.parse(validTo) <= Date.parse(validFrom)) {
    throw graphError("GRAPH_PROVENANCE_VALID_TO_INVALID");
  }
  if (
    value.confidence !== undefined &&
    (!Number.isFinite(value.confidence) ||
      value.confidence < 0 ||
      value.confidence > 1)
  ) {
    throw graphError("GRAPH_PROVENANCE_CONFIDENCE_INVALID");
  }
  return {
    derivation: value.derivation,
    sourceIds: boundedList(
      value.sourceIds,
      256,
      1024,
      "GRAPH_PROVENANCE_SOURCE_IDS_INVALID",
    ),
    evidenceIds: boundedList(
      value.evidenceIds,
      256,
      1024,
      "GRAPH_PROVENANCE_EVIDENCE_IDS_INVALID",
    ),
    locatorRefs: boundedList(
      value.locatorRefs,
      256,
      2048,
      "GRAPH_PROVENANCE_LOCATORS_INVALID",
    ),
    revision,
    ...(value.supportSetId
      ? {
          supportSetId: requiredString(
            value.supportSetId,
            1024,
            "GRAPH_PROVENANCE_SUPPORT_SET_INVALID",
          ),
        }
      : {}),
    ...(value.confidence === undefined ? {} : { confidence: value.confidence }),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
    recordedAt: new Date(recordedAt).toISOString(),
  };
}

function parseGraphTraversalBounds(
  value: GraphTraversalBounds,
): GraphTraversalBounds {
  const boundedInteger = (
    candidate: number,
    min: number,
    max: number,
    code: string,
  ): number => {
    if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
      throw graphError(code);
    }
    return candidate;
  };
  return {
    maxHops: boundedInteger(value.maxHops, 1, 16, "GRAPH_MAX_HOPS_INVALID"),
    maxFanout: boundedInteger(
      value.maxFanout,
      1,
      1000,
      "GRAPH_MAX_FANOUT_INVALID",
    ),
    maxCandidates: boundedInteger(
      value.maxCandidates,
      1,
      10000,
      "GRAPH_MAX_CANDIDATES_INVALID",
    ),
    timeBudgetMs: boundedInteger(
      value.timeBudgetMs,
      1,
      60000,
      "GRAPH_TIME_BUDGET_INVALID",
    ),
  };
}

function graphNodeIdentityKey(identity: GraphNodeIdentity): string {
  const value = parseGraphNodeIdentity(identity);
  return JSON.stringify([
    value.graphDomain,
    value.scopeId,
    value.kind,
    value.canonicalKey,
    value.revision,
  ]);
}

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
  building_at: Date | string | null;
  ready_at: Date | string | null;
  built_at: Date | string | null;
  activated_at: Date | string | null;
  retired_at: Date | string | null;
  last_successful_update: Date | string | null;
}

interface CatalogProjectionRow extends ProjectionRow {
  node_paths: Array<string | null>;
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
  space_id: string;
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
  assertion_id: string;
  assertion_lifecycle: GraphRelationshipLifecycle;
  assertion_hash: string;
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

function catalogStatus(
  latest: GraphProjectionRevision,
  active: GraphProjectionRevision | null,
): GraphCatalogStatus {
  if (!active) {
    if (
      latest.lifecycle === "REQUESTED" ||
      latest.lifecycle === "BUILDING" ||
      latest.lifecycle === "READY" ||
      latest.lifecycle === "BUILT"
    ) {
      return "BUILDING";
    }
    if (latest.freshness === "STALE" || latest.lifecycle === "STALE") {
      return "STALE";
    }
    return "UNAVAILABLE";
  }
  if (active.freshness === "STALE") return "STALE";
  if (latest.id !== active.id && latest.lifecycle === "FAILED") {
    return "DEGRADED";
  }
  if (
    latest.id !== active.id &&
    (latest.lifecycle === "REQUESTED" ||
      latest.lifecycle === "BUILDING" ||
      latest.lifecycle === "READY" ||
      latest.lifecycle === "BUILT")
  ) {
    return "BUILDING";
  }
  return "READY";
}

function catalogConfigHash(configurationVersion: string): string {
  const normalized = requiredString(
    configurationVersion,
    512,
    "GRAPH_CONFIGURATION_VERSION_REQUIRED",
  );
  return /^[a-f0-9]{64}$/.test(normalized) ? normalized : sha256(normalized);
}

function mapProjection(row: ProjectionRow): GraphProjectionRevision {
  if (!UUID_SHAPE.test(row.id)) throw graphError("GRAPH_PROJECTION_ID_INVALID");
  return {
    id: row.id,
    graphDomain: parseGraphDomain(row.graph_domain),
    spaceId: row.space_id,
    vaultId: row.vault_id,
    scopeId: requiredString(row.scope_id, 512, "GRAPH_SCOPE_REQUIRED"),
    revision: requiredString(row.revision, 512, "GRAPH_REVISION_REQUIRED"),
    sourceRevision: requiredString(
      row.source_revision,
      1024,
      "GRAPH_SOURCE_REVISION_REQUIRED",
    ),
    sourceHash: row.source_hash,
    provider: requiredString(row.provider, 160, "GRAPH_PROVIDER_REQUIRED"),
    providerVersion: row.provider_version,
    configurationVersion: requiredString(
      row.configuration_version,
      512,
      "GRAPH_CONFIGURATION_VERSION_REQUIRED",
    ),
    lifecycle: row.lifecycle,
    freshness: row.freshness,
    requestedAt: iso(row.requested_at)!,
    buildingAt: iso(row.building_at),
    readyAt: iso(row.ready_at),
    builtAt: iso(row.built_at),
    activatedAt: iso(row.activated_at),
    retiredAt: iso(row.retired_at),
    lastSuccessfulUpdate: iso(row.last_successful_update),
  };
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

function authorizationPath(value: string | null | undefined): string | null {
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
  parseGraphDomain(input.graphDomain);
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
    const identity = parseGraphNodeIdentity(node.identity);
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
    const from = parseGraphNodeIdentity(edge.from);
    parseGraphNodeIdentity(edge.to);
    parseGraphProvenanceEnvelope(edge.provenance);
    parseGraphRelationshipLifecycle(edge.assertionLifecycle ?? "ACTIVE");
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
  return parseGraphProvenanceEnvelope({
    derivation: edge.derivation,
    sourceIds: edge.source_ids ?? [],
    evidenceIds: edge.evidence_ids ?? [],
    locatorRefs: edge.locator_refs ?? [],
    revision: edge.provenance_revision,
    ...(edge.support_set_id ? { supportSetId: edge.support_set_id } : {}),
    ...(edge.confidence === null ? {} : { confidence: edge.confidence }),
    ...(edge.valid_from ? { validFrom: iso(edge.valid_from)! } : {}),
    ...(edge.valid_to ? { validTo: iso(edge.valid_to)! } : {}),
    recordedAt: iso(edge.recorded_at)!,
  });
}

function relationshipAssertion(
  edge: ActiveEdgeRow,
): GraphRelationshipAssertion {
  return {
    id: edge.assertion_id,
    spaceId: edge.space_id,
    ownerGraphDomain: edge.owner_graph_domain,
    fromNodeId: edge.from_node_id,
    toNodeId: edge.to_node_id,
    relation: edge.relation_type,
    authorizationPath: edge.authorization_path,
    lifecycle: parseGraphRelationshipLifecycle(edge.assertion_lifecycle),
    provenance: edgeProvenance(edge),
  };
}

function relationAllowlist(values: readonly string[]): string[] {
  if (values.length > 256)
    throw graphError("GRAPH_RELATION_ALLOWLIST_TOO_LARGE");
  return [
    ...new Set(
      values.map((value) => value.trim()).filter((value) => value.length > 0),
    ),
  ].sort();
}

function domainAllowlist(
  values: readonly GraphDomain[] | undefined,
): GraphDomain[] {
  if (!values?.length) return [...GRAPH_DOMAINS];
  return [...new Set(values.map((value) => parseGraphDomain(value)))];
}

function compositeRevision(
  values: Array<{ scopeId: string; revision: string }>,
): string {
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
  const byDomain = new Map<
    GraphDomain,
    Array<{ scopeId: string; revision: string }>
  >();
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

  async build(
    input: GraphProjectionArtifact,
  ): Promise<GraphProjectionRevision> {
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
    if (
      requestRow.lifecycle === "ACTIVE" ||
      requestRow.lifecycle === "RETIRED" ||
      requestRow.lifecycle === "STALE"
    ) {
      return mapProjection(requestRow);
    }
    if (requestRow.lifecycle !== "REQUESTED") {
      const reset = await this.db.pool.query<ProjectionRow>(
        `update federated_graph_projection_revisions
            set lifecycle='REQUESTED',freshness='FRESH',error=null,
                requested_at=now(),building_at=null,ready_at=null,
                built_at=null,activated_at=null,retired_at=null,
                last_successful_update=null,updated_at=now()
          where id=$1
          returning *`,
        [requestRow.id],
      );
      requestRow = reset.rows[0] ?? requestRow;
    }

    const building = await this.db.pool.query<ProjectionRow>(
      `update federated_graph_projection_revisions
          set lifecycle='BUILDING',freshness='FRESH',building_at=now(),
              error=null,updated_at=now()
        where id=$1 and lifecycle='REQUESTED'
        returning *`,
      [requestRow.id],
    );
    requestRow = building.rows[0] ?? requestRow;
    if (requestRow.lifecycle !== "BUILDING") {
      throw graphError("GRAPH_PROJECTION_BUILDING_TRANSITION_FAILED");
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
        if (
          locked.lifecycle === "ACTIVE" ||
          locked.lifecycle === "RETIRED" ||
          locked.lifecycle === "STALE"
        ) {
          return mapProjection(locked);
        }
        if (locked.lifecycle !== "BUILDING") {
          throw graphError("GRAPH_PROJECTION_BUILDING_STATE_REQUIRED");
        }

        const nodeIds = new Map<string, string>();
        for (const node of input.nodes) {
          const identity = parseGraphNodeIdentity(node.identity);
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
          const fromIdentity = parseGraphNodeIdentity(edge.from);
          const toIdentity = parseGraphNodeIdentity(edge.to);
          const provenance = parseGraphProvenanceEnvelope(edge.provenance);
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
          const assertionLifecycle = parseGraphRelationshipLifecycle(
            edge.assertionLifecycle ?? "ACTIVE",
          );
          const assertionInserted = await client.query<{
            id: string;
            authorization_path: string | null;
            lifecycle: GraphRelationshipLifecycle;
          }>(
            `insert into federated_graph_relationship_assertions(
               space_id,owner_graph_domain,from_node_id,to_node_id,
               relation_type,authorization_path,lifecycle,derivation,source_ids,
               evidence_ids,locator_refs,provenance_revision,support_set_id,
               confidence,valid_from,valid_to,recorded_at,assertion_hash
             ) values(
               $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,
               $13,$14,$15,$16,$17,$18
             )
             on conflict(
               space_id,owner_graph_domain,from_node_id,to_node_id,
               relation_type,assertion_hash
             ) do nothing
             returning id,authorization_path,lifecycle`,
            [
              input.spaceId,
              input.graphDomain,
              fromId,
              toId,
              relation,
              edgePath,
              assertionLifecycle,
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
          let persistedAssertion = assertionInserted.rows[0];
          if (!persistedAssertion) {
            const existingAssertion = await client.query<{
              id: string;
              authorization_path: string | null;
              lifecycle: GraphRelationshipLifecycle;
            }>(
              `select id,authorization_path,lifecycle
                 from federated_graph_relationship_assertions
                where space_id=$1 and owner_graph_domain=$2
                  and from_node_id=$3 and to_node_id=$4
                  and relation_type=$5 and assertion_hash=$6`,
              [
                input.spaceId,
                input.graphDomain,
                fromId,
                toId,
                relation,
                provenanceHash,
              ],
            );
            persistedAssertion = existingAssertion.rows[0];
          }
          if (
            !persistedAssertion ||
            persistedAssertion.authorization_path !== edgePath ||
            persistedAssertion.lifecycle !== assertionLifecycle
          ) {
            throw graphError("GRAPH_RELATIONSHIP_ASSERTION_CONFLICT");
          }

          const inserted = await client.query<{
            id: string;
            authorization_path: string | null;
            assertion_id: string;
          }>(
            `insert into federated_graph_edges(
               space_id,owner_graph_domain,from_node_id,to_node_id,
               relation_type,authorization_path,assertion_id,derivation,source_ids,
               evidence_ids,locator_refs,provenance_revision,support_set_id,
               confidence,valid_from,valid_to,recorded_at,provenance_hash
             ) values(
               $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb,$12,
               $13,$14,$15,$16,$17,$18
             )
             on conflict(
               space_id,owner_graph_domain,from_node_id,to_node_id,
               relation_type,provenance_revision,derivation,provenance_hash
             ) do nothing
             returning id,authorization_path,assertion_id`,
            [
              input.spaceId,
              input.graphDomain,
              fromId,
              toId,
              relation,
              edgePath,
              persistedAssertion.id,
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
              assertion_id: string;
            }>(
              `select id,authorization_path,assertion_id
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
          if (
            !persisted ||
            persisted.authorization_path !== edgePath ||
            persisted.assertion_id !== persistedAssertion.id
          ) {
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

        const organization = await client.query<{
          organization_id: string;
        }>("select organization_id from spaces where id=$1", [input.spaceId]);
        const organizationId = organization.rows[0]?.organization_id;
        if (!organizationId) {
          throw graphError("GRAPH_SPACE_ORGANIZATION_NOT_FOUND");
        }

        const built = await client.query<ProjectionRow>(
          `update federated_graph_projection_revisions
              set lifecycle='READY',freshness='FRESH',built_at=now(),
                  ready_at=now(),last_successful_update=now(),
                  error=null,updated_at=now()
            where id=$1 and lifecycle='BUILDING'
            returning *`,
          [locked.id],
        );
        const builtRow = built.rows[0];
        if (!builtRow) throw graphError("GRAPH_PROJECTION_BUILD_FAILED");
        const builtProjection = mapProjection(builtRow);
        const builtEvent = await appendOutboxEvent(client, {
          eventType: "GraphRevisionBuilt",
          resourceId: builtProjection.id,
          organizationId,
          spaceId: input.spaceId,
          vaultId: input.vaultId,
          correlationId: `graph:${input.graphDomain}:${input.scopeId}`,
          payload: {
            projectionRevisionId: builtProjection.id,
            graphDomain: input.graphDomain,
            scopeId: input.scopeId,
            revision: input.revision,
            sourceRevision: input.sourceRevision,
            sourceHash: input.sourceHash,
            provider: input.provider,
            providerVersion: input.providerVersion,
            configurationVersion: input.configurationVersion,
            lifecycle: builtProjection.lifecycle,
            freshness: builtProjection.freshness,
            builtAt: builtProjection.builtAt,
          },
        });

        const previousActive = await client.query<{
          id: string;
          revision: string;
        }>(
          `select id,revision
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain=$2 and scope_id=$3
              and lifecycle='ACTIVE' and id<>$4
            order by activated_at desc nulls last,id`,
          [input.spaceId, input.graphDomain, input.scopeId, locked.id],
        );
        await client.query(
          `update federated_graph_projection_revisions
              set lifecycle='RETIRED',freshness='STALE',retired_at=now(),
                  updated_at=now()
            where space_id=$1 and graph_domain=$2 and scope_id=$3
              and lifecycle='ACTIVE' and id<>$4`,
          [input.spaceId, input.graphDomain, input.scopeId, locked.id],
        );
        const activated = await client.query<ProjectionRow>(
          `update federated_graph_projection_revisions
              set lifecycle='ACTIVE',freshness='FRESH',activated_at=now(),
                  last_successful_update=now(),updated_at=now()
            where id=$1 and lifecycle='READY'
            returning *`,
          [locked.id],
        );
        const row = activated.rows[0];
        if (!row) throw graphError("GRAPH_PROJECTION_ACTIVATION_FAILED");
        const activeProjection = mapProjection(row);
        await appendOutboxEvent(client, {
          eventType: "GraphRevisionActivated",
          resourceId: activeProjection.id,
          organizationId,
          spaceId: input.spaceId,
          vaultId: input.vaultId,
          correlationId: `graph:${input.graphDomain}:${input.scopeId}`,
          causationId: builtEvent.eventId,
          payload: {
            projectionRevisionId: activeProjection.id,
            graphDomain: input.graphDomain,
            scopeId: input.scopeId,
            revision: input.revision,
            sourceRevision: input.sourceRevision,
            sourceHash: input.sourceHash,
            provider: input.provider,
            providerVersion: input.providerVersion,
            configurationVersion: input.configurationVersion,
            lifecycle: activeProjection.lifecycle,
            freshness: activeProjection.freshness,
            activatedAt: activeProjection.activatedAt,
            superseded: previousActive.rows.map((previous) => ({
              projectionRevisionId: previous.id,
              revision: previous.revision,
            })),
          },
        });
        return activeProjection;
      });
    } catch (error) {
      await this.db.pool
        .query(
          `update federated_graph_projection_revisions
              set lifecycle='FAILED',freshness='STALE',
                  error=$2::jsonb,updated_at=now()
            where id=$1 and lifecycle not in ('ACTIVE','RETIRED','STALE')`,
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

  async markStale(
    domain: GraphDomain,
    spaceId: string,
    scopeId: string,
    reason?: string,
  ): Promise<GraphProjectionRevision | null> {
    parseGraphDomain(domain);
    return withTransaction(this.db, async (client) => {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [spaceId + "|" + domain + "|" + scopeId],
      );
      const active = await client.query<ProjectionRow>(
        `select *
           from federated_graph_projection_revisions
          where space_id=$1 and graph_domain=$2 and scope_id=$3
            and lifecycle='ACTIVE'
          order by activated_at desc nulls last,id desc
          limit 1
          for update`,
        [spaceId, domain, scopeId],
      );
      const current = active.rows[0];
      if (!current) return null;
      if (current.freshness === "STALE") return mapProjection(current);

      const updated = await client.query<ProjectionRow>(
        `update federated_graph_projection_revisions
            set freshness='STALE',updated_at=now()
          where id=$1
          returning *`,
        [current.id],
      );
      const row = updated.rows[0];
      if (!row) throw graphError("GRAPH_PROJECTION_STALE_FAILED");
      const projection = mapProjection(row);
      const organization = await client.query<{ organization_id: string }>(
        "select organization_id from spaces where id=$1",
        [spaceId],
      );
      const organizationId = organization.rows[0]?.organization_id;
      if (!organizationId) {
        throw graphError("GRAPH_SPACE_ORGANIZATION_NOT_FOUND");
      }
      await appendOutboxEvent(client, {
        eventType: "GraphRevisionStale",
        resourceId: projection.id,
        organizationId,
        spaceId,
        vaultId: projection.vaultId,
        correlationId: "graph:" + domain + ":" + scopeId,
        payload: {
          projectionRevisionId: projection.id,
          graphDomain: domain,
          scopeId,
          revision: projection.revision,
          lifecycle: projection.lifecycle,
          freshness: projection.freshness,
          ...(reason?.trim() ? { reason: reason.trim().slice(0, 2048) } : {}),
        },
      });
      return projection;
    });
  }

  async catalog(input: GraphCatalogQuery): Promise<GraphCatalogEntry[]> {
    const domains = domainAllowlist(input.domains);
    const prefixes = normalizeAuthorizationScope(input.authorization);
    const scopeIds =
      input.scopeIds === undefined
        ? null
        : input.scopeIds.map((scopeId) =>
            requiredString(scopeId, 512, "GRAPH_SCOPE_REQUIRED"),
          );
    const vaultIds = [...prefixes.keys()];
    const rows = await this.db.pool.query<CatalogProjectionRow>(
      `select p.*,
              coalesce(
                jsonb_agg(distinct n.authorization_path)
                  filter (where n.id is not null),
                '[]'::jsonb
              ) node_paths
         from federated_graph_projection_revisions p
         left join federated_graph_projection_nodes pn
           on pn.projection_revision_id=p.id
         left join federated_graph_nodes n
           on n.id=pn.node_id and n.space_id=p.space_id
        where p.space_id=$1
          and p.graph_domain=any($2::text[])
          and (
            p.vault_id=any($3::uuid[])
            or (p.vault_id is null and $4::boolean)
          )
          and ($5::text[] is null or p.scope_id=any($5::text[]))
        group by p.id
        order by
          p.graph_domain,p.scope_id,p.vault_id nulls first,
          p.requested_at desc,p.id desc`,
      [
        input.authorization.spaceId,
        domains,
        vaultIds,
        input.authorization.allowSpaceScoped === true,
        scopeIds,
      ],
    );

    const visible = rows.rows.filter((row) => {
      if (row.vault_id === null) {
        return input.authorization.allowSpaceScoped === true;
      }
      if (!prefixes.has(row.vault_id)) return false;
      const prefix = prefixes.get(row.vault_id) ?? null;
      if (prefix === null) return true;
      return row.node_paths.some(
        (path) => path !== null && pathMatchesVaultPrefix(path, prefix),
      );
    });

    const grouped = new Map<string, CatalogProjectionRow[]>();
    for (const row of visible) {
      const key = [row.graph_domain, row.scope_id, row.vault_id ?? ""].join(
        "|",
      );
      const entries = grouped.get(key) ?? [];
      entries.push(row);
      grouped.set(key, entries);
    }

    return [...grouped.values()]
      .map((entries) => {
        const latest = mapProjection(entries[0]!);
        const activeRow = entries.find((row) => row.lifecycle === "ACTIVE");
        const active = activeRow ? mapProjection(activeRow) : null;
        const basis = active ?? latest;
        const status = catalogStatus(latest, active);
        const lastSuccessfulBuild = entries
          .map((row) => iso(row.last_successful_update))
          .filter((value): value is string => value !== null)
          .sort()
          .at(-1);
        return {
          domain: basis.graphDomain,
          spaceId: basis.spaceId,
          vaultId: basis.vaultId,
          scopeId: basis.scopeId,
          ...(active ? { activeRevision: active.revision } : {}),
          sourceRevision: basis.sourceRevision,
          builder: basis.provider,
          builderVersion: basis.providerVersion ?? "UNVERSIONED",
          configHash: catalogConfigHash(basis.configurationVersion),
          status,
          capabilities: [...GRAPH_CATALOG_CAPABILITIES[basis.graphDomain]],
          ...(lastSuccessfulBuild ? { lastSuccessfulBuild } : {}),
        };
      })
      .sort((left, right) =>
        [left.domain, left.scopeId, left.vaultId ?? ""]
          .join("|")
          .localeCompare(
            [right.domain, right.scopeId, right.vaultId ?? ""].join("|"),
          ),
      );
  }

  async revisionState(
    domain: GraphDomain,
    spaceId: string,
    scopeId: string,
  ): Promise<GraphProjectionRevisionState> {
    parseGraphDomain(domain);
    const args = [spaceId, domain, scopeId];
    const [requestedResult, builtResult, activeResult, successResult] =
      await Promise.all([
        this.db.pool.query<ProjectionRow>(
          `select *
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain=$2 and scope_id=$3
            order by requested_at desc,id desc
            limit 1`,
          args,
        ),
        this.db.pool.query<ProjectionRow>(
          `select *
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain=$2 and scope_id=$3
              and built_at is not null
            order by built_at desc,id desc
            limit 1`,
          args,
        ),
        this.db.pool.query<ProjectionRow>(
          `select *
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain=$2 and scope_id=$3
              and lifecycle='ACTIVE'
            order by activated_at desc nulls last,id desc
            limit 1`,
          args,
        ),
        this.db.pool.query<{ last_successful_update: Date | string | null }>(
          `select max(last_successful_update) last_successful_update
             from federated_graph_projection_revisions
            where space_id=$1 and graph_domain=$2 and scope_id=$3`,
          args,
        ),
      ]);
    const requested = requestedResult.rows[0]
      ? mapProjection(requestedResult.rows[0])
      : null;
    const built = builtResult.rows[0]
      ? mapProjection(builtResult.rows[0])
      : null;
    const active = activeResult.rows[0]
      ? mapProjection(activeResult.rows[0])
      : null;
    const lastSuccessfulUpdate = iso(
      successResult.rows[0]?.last_successful_update ?? null,
    );
    return {
      graphDomain: domain,
      spaceId,
      vaultId: requested?.vaultId ?? built?.vaultId ?? active?.vaultId ?? null,
      scopeId,
      requested,
      built,
      active,
      requestedRevision: requested?.revision ?? null,
      builtRevision: built?.revision ?? null,
      activeRevision: active?.revision ?? null,
      activeFreshness: active?.freshness ?? null,
      lastSuccessfulUpdate,
    };
  }

  async findNodes(input: GraphNodeLookupQuery): Promise<GraphNodeRef[]> {
    parseGraphFreshnessPolicy(input.freshnessPolicy);
    if (
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > MAX_GRAPH_NODE_LOOKUP_LIMIT
    ) {
      throw graphError("GRAPH_LOOKUP_LIMIT_INVALID");
    }
    const domains = domainAllowlist(input.domains);
    const prefixes = normalizeAuthorizationScope(input.authorization);
    const freshnessClause =
      input.freshnessPolicy === "FRESH_ONLY" ? "and pr.freshness='FRESH'" : "";
    const kinds =
      input.kinds === undefined
        ? null
        : input.kinds.map((kind) =>
            requiredString(kind, 120, "GRAPH_NODE_KIND_INVALID"),
          );
    const canonicalKeys =
      input.canonicalKeys === undefined
        ? null
        : input.canonicalKeys.map((key) =>
            requiredString(key, 2048, "GRAPH_CANONICAL_KEY_INVALID"),
          );
    const payloadContains = input.payloadContains ?? null;
    if (payloadContains && Object.keys(payloadContains).length > 32) {
      throw graphError("GRAPH_LOOKUP_PAYLOAD_FILTER_INVALID");
    }
    const rows = await this.db.pool.query<ActiveNodeRow>(
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
        and ($3::text[] is null or n.kind=any($3::text[]))
        and ($4::text[] is null or n.canonical_key=any($4::text[]))
        and ($5::jsonb is null or n.payload @> $5::jsonb)
      order by n.id,pr.activated_at desc nulls last,pr.id`,
      [
        input.authorization.spaceId,
        domains,
        kinds,
        canonicalKeys,
        payloadContains ? JSON.stringify(payloadContains) : null,
      ],
    );
    return rows.rows
      .map(activeNodeRef)
      .filter((node) =>
        nodeAllowed(
          node,
          prefixes,
          input.authorization.allowSpaceScoped === true,
        ),
      )
      .sort((left, right) =>
        [
          left.identity.graphDomain,
          left.identity.scopeId,
          left.identity.kind,
          left.identity.canonicalKey,
          left.id,
        ]
          .join("|")
          .localeCompare(
            [
              right.identity.graphDomain,
              right.identity.scopeId,
              right.identity.kind,
              right.identity.canonicalKey,
              right.id,
            ].join("|"),
          ),
      )
      .slice(0, input.limit);
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
      for (const [domain, revision] of Object.entries(
        path.revisionSet,
      ) as Array<[GraphDomain, string | undefined]>) {
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
    const bounds = parseGraphTraversalBounds(input.bounds);
    void bounds;
    parseGraphDirection(input.direction);
    parseGraphFreshnessPolicy(input.freshnessPolicy);
    const domains = domainAllowlist(input.domains);
    const prefixes = normalizeAuthorizationScope(input.authorization);
    const freshnessClause =
      input.freshnessPolicy === "FRESH_ONLY" ? "and pr.freshness='FRESH'" : "";

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
           e.id,a.space_id,a.owner_graph_domain,a.from_node_id,a.to_node_id,
           a.relation_type,a.authorization_path,a.derivation,
           a.source_ids,a.evidence_ids,a.locator_refs,a.provenance_revision,
           a.support_set_id,a.confidence,a.valid_from,a.valid_to,a.recorded_at,
           a.id assertion_id,a.lifecycle assertion_lifecycle,
           a.assertion_hash
         from federated_graph_edges e
         join federated_graph_relationship_assertions a
           on a.id=e.assertion_id and a.space_id=e.space_id
         join federated_graph_projection_edges pe on pe.edge_id=e.id
         join federated_graph_projection_revisions pr
           on pr.id=pe.projection_revision_id
          and pr.space_id=e.space_id
          and pr.graph_domain=e.owner_graph_domain
        where e.space_id=$1
          and a.relation_type=any($2::text[])
          and a.lifecycle in ('ACTIVE','DISPUTED')
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
      left.assertion_hash.localeCompare(right.assertion_hash) ||
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
          left.assertion_hash.localeCompare(right.assertion_hash) ||
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
          graphNodeIdentityKey(parseGraphNodeIdentity(selector.identity)),
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
        left.edge.assertion_hash.localeCompare(right.edge.assertion_hash) ||
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
    const bounds = parseGraphTraversalBounds(input.bounds);
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
          assertion: relationshipAssertion(oriented.edge),
          provenance: edgeProvenance(oriented.edge),
        };
        const steps = [...current.steps, step];
        const result: GraphPathResult = {
          seed,
          target: to,
          steps,
          revisionSet: revisionSetForPath(seed, steps),
        };
        if (!target || target.id === to.id) {
          const existing = bestByTarget.get(to.id);
          if (!existing || pathSignature(result) < pathSignature(existing)) {
            bestByTarget.set(to.id, result);
          }
        }
        if ((!target || target.id !== to.id) && steps.length < bounds.maxHops) {
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
      .sort((left, right) =>
        pathSignature(left).localeCompare(pathSignature(right)),
      )
      .slice(0, bounds.maxCandidates);
  }
}
