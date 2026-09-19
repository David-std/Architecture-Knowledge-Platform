import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  intersectVaultPathPrefixes,
  normalizeVaultPathPrefix,
  pathMatchesVaultPrefix,
  PostgresAuthorizationPort,
  PostgresTemporalTruthStore,
  type AuthorizedVaultScope,
  type Postgres,
  type TruthSnapshot,
} from "@akp/postgres";
import {
  GraphRelationType,
  ContextContinuationResponse,
  ContextPacket as ContextPacketSchema,
  ContextRequest,
  SearchRequest,
  type ContextPacket,
  type ContextSection,
  type GraphPathNode,
  type GraphPathProvenance,
  type SearchHit,
  type SearchRequest as SearchInput,
} from "@akp/contracts";
import {
  buildContextPacket,
  buildContextPacketPair,
  ContextPacketBudgetError,
  DETERMINISTIC_LEXICAL_RERANKER,
  contextBudgetForIntent,
  createEmbeddingProviderForGeneration,
  personalizedPageRank,
  planQuery,
  QueryEmbeddingService,
  rehydrateStructuralContext,
  reciprocalRankFusion,
  validateQueryTransformationResult,
  rerankSearchHits,
  resolvePersonalizedPageRankPolicy,
  resolveRetrievalPolicy,
  resolveSearchHitReranker,
  retrievalCandidatesToRankedChannels,
  runtimeChannelEnabled,
  toPgVector,
  type ActiveEmbeddingGenerationDescriptor,
  type PersonalizedPageRankPolicy,
  type QueryPlan,
  type QueryPlannerCapabilities,
  type QueryTransformationKind,
  type QueryTransformationVariant,
  type QueryTransformerPort,
  type RetrievalCandidate,
  type RetrievalPolicyInput,
  type Tokenizer,
  type ContextContinuationPayload,
} from "@akp/retrieval";
import { OpenTelemetryBridge, withSpan } from "@akp/observability";
import {
  actorOf,
  hasPathAccess,
  hasSpaceAccess,
  pathPrefixesForPermission,
  requirePermission,
  requirePrincipalAction,
} from "../auth.js";
import {
  resolveProjectCodeRetrieval,
  type CodeChannelCandidate,
} from "../project-code-retrieval.js";

const telemetry = new OpenTelemetryBridge();

type RequiredRetrievalChannel =
  "exact" | "lexical" | "vector" | "graph" | "community";

const RETRIEVAL_SPAN_NAMES: Record<RequiredRetrievalChannel, string> = {
  exact: "retrieve.exact",
  lexical: "retrieve.lexical",
  vector: "retrieve.vector",
  graph: "retrieve.graph",
  community: "retrieve.community",
};

async function observedRetrieval<T>(
  channel: RequiredRetrievalChannel,
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await withSpan(
      RETRIEVAL_SPAN_NAMES[channel],
      { "akp.retrieval.channel": channel },
      operation,
    );
  } finally {
    telemetry.histogram(
      "retrieval_channel_latency",
      (performance.now() - started) / 1000,
      { channel },
    );
  }
}

function recordRetrievalCandidates(
  channel: RequiredRetrievalChannel,
  count: number,
): void {
  telemetry.histogram("retrieval_candidates", count, { channel });
}

const TRUST_RANK: Record<string, number> = {
  UNVERIFIED: 0,
  MACHINE_SUPPORTED: 1,
  HUMAN_REVIEWED: 2,
  ATTESTED: 3,
};

const UNSAFE_LOCATOR_KEY =
  /^(?:source(?:uri|_uri)|local(?:path|_path)|absolute(?:path|_path)|repository(?:path|_path)|canonical(?:path|_path)|object(?:key|_key)|endpoint|host|file|url|uri)$/i;
const ABSOLUTE_LOCATOR_TOKEN =
  /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var)\/)[^\s"']+/;

export type GraphDirectionPolicy = "outgoing" | "incoming" | "both";

/** Bounded policy for recursive graph expansion at the API query boundary. */
export interface GraphTraversalPolicy {
  maxHops: number;
  allowedRelationTypes: readonly GraphRelationType[];
  relationWeights: Partial<Record<GraphRelationType, number>>;
  decay: number;
  directionPolicy: GraphDirectionPolicy;
  maxPathsPerCandidate: number;
  maxCandidates: number;
}

interface GraphScope {
  vaultId: string;
  pathPrefix: string | null;
}

interface GraphTraversalRow {
  seed_document_id: string;
  seed_vault_id: string;
  target_document_id: string;
  hops: number;
  graph_score: number;
  path_document_ids: string[];
  path_relation_types: string[];
  path_directions: string[];
}

interface GraphCandidateRow {
  id: string;
  weight: number;
  candidateRevision: string;
  provenance: GraphPathProvenance[];
}

interface GraphDocumentRow {
  id: string;
  space_id: string;
  vault_id: string;
  external_id: string | null;
  path: string;
  current_revision: string;
  lifecycle: string;
  refresh_status: string;
  trust_tier: string;
}

interface ExactSearchRow {
  id: string;
  document_revision: string;
  match_reason: string;
}

interface LexicalSearchRow {
  id: string;
  unit_id: string | null;
  unit_type: string | null;
  document_revision: string;
  score: number;
  match_reason: string;
  query_variant_kind?: QueryTransformationKind;
  query_variant_ordinal?: number;
}

interface DocumentChannelRow {
  id: string;
  document_revision: string;
}

interface CommunityCandidateRow extends DocumentChannelRow {
  community_key: string;
  community_revision: string;
  orientation_score: number;
}

interface CodeChannelRow extends DocumentChannelRow {
  match_reason?: string;
  code_citations?: string[];
}

const ALL_GRAPH_RELATION_TYPES: readonly GraphRelationType[] =
  GraphRelationType.options;

const GRAPH_HARD_MAX_HOPS = 3;
const GRAPH_HARD_MAX_PATHS = 10;
const GRAPH_HARD_MAX_CANDIDATES = 100;
const GRAPH_HARD_MAX_FANOUT = 10;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function boundedNumber(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)));
}

function boundedNonNegativeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(100, value));
}

function normalizeGraphScopes(
  vaultIds: readonly string[],
  graphScopes:
    readonly { vaultId: string; pathPrefix: string | null }[] | undefined,
): GraphScope[] {
  const allowedVaults = new Set(vaultIds);
  const source =
    graphScopes ?? vaultIds.map((vaultId) => ({ vaultId, pathPrefix: null }));
  const scopesByVault = new Map<string, GraphScope>();
  const conflictingVaults = new Set<string>();
  for (const scope of source) {
    if (
      typeof scope?.vaultId !== "string" ||
      !allowedVaults.has(scope.vaultId) ||
      (scope.pathPrefix !== null && typeof scope.pathPrefix !== "string")
    ) {
      continue;
    }
    const pathPrefix = normalizeVaultPathPrefix(scope.pathPrefix);
    if (pathPrefix === undefined) {
      scopesByVault.delete(scope.vaultId);
      conflictingVaults.add(scope.vaultId);
      continue;
    }
    const existing = scopesByVault.get(scope.vaultId);
    if (!existing) {
      scopesByVault.set(scope.vaultId, { vaultId: scope.vaultId, pathPrefix });
      continue;
    }
    const intersection = intersectVaultPathPrefixes(
      existing.pathPrefix,
      pathPrefix,
    );
    if (intersection === undefined) {
      scopesByVault.delete(scope.vaultId);
      conflictingVaults.add(scope.vaultId);
      continue;
    }
    scopesByVault.set(scope.vaultId, {
      vaultId: scope.vaultId,
      pathPrefix: intersection,
    });
  }
  for (const vaultId of conflictingVaults) scopesByVault.delete(vaultId);
  return [...scopesByVault.values()];
}

function normalizeGraphPolicy(
  input: Partial<GraphTraversalPolicy> | undefined,
  plan: QueryPlan,
  limit: number,
): GraphTraversalPolicy {
  const maxHops = boundedNumber(
    input?.maxHops,
    boundedNumber(plan.maxGraphHops, 1, 0, GRAPH_HARD_MAX_HOPS),
    0,
    GRAPH_HARD_MAX_HOPS,
  );
  const maxPathsPerCandidate = boundedNumber(
    input?.maxPathsPerCandidate,
    3,
    1,
    GRAPH_HARD_MAX_PATHS,
  );
  const maxCandidates = boundedNumber(
    input?.maxCandidates,
    Math.max(Number.isFinite(limit) ? Math.trunc(limit) * 2 : 20, 20),
    1,
    GRAPH_HARD_MAX_CANDIDATES,
  );
  const allowedRelationTypes =
    input?.allowedRelationTypes === undefined
      ? [...ALL_GRAPH_RELATION_TYPES]
      : ALL_GRAPH_RELATION_TYPES.filter((relationType) =>
          input.allowedRelationTypes?.includes(relationType),
        );
  const relationWeights: Partial<Record<GraphRelationType, number>> = {};
  for (const relationType of ALL_GRAPH_RELATION_TYPES) {
    relationWeights[relationType] = boundedNonNegativeNumber(
      input?.relationWeights?.[relationType],
      1,
    );
  }
  const directionPolicy =
    input?.directionPolicy === "outgoing" ||
    input?.directionPolicy === "incoming" ||
    input?.directionPolicy === "both"
      ? input.directionPolicy
      : "both";
  const decay =
    typeof input?.decay === "number" && Number.isFinite(input.decay)
      ? Math.max(0, Math.min(1, input.decay))
      : 0.5;
  return {
    maxHops,
    allowedRelationTypes,
    relationWeights,
    decay,
    directionPolicy,
    maxPathsPerCandidate,
    maxCandidates,
  };
}

function kindOf(
  layer: string,
  type: string,
):
  | "rule"
  | "workflow"
  | "concept"
  | "profile"
  | "decision"
  | "example"
  | "counterexample"
  | "evidence"
  | "source" {
  const value = `${layer} ${type}`.toLowerCase();
  if (value.includes("rule") || value.includes("policy")) return "rule";
  if (value.includes("workflow")) return "workflow";
  if (value.includes("profile")) return "profile";
  if (value.includes("decision") || value.includes("adr")) return "decision";
  if (value.includes("counterexample") || value.includes("contraejemplo"))
    return "counterexample";
  if (value.includes("example")) return "example";
  if (value.includes("evidence")) return "evidence";
  if (value.includes("source") || value.includes("resource")) return "source";
  return "concept";
}

export type TruthConsistencyMode = "STRICT" | "BEST_EFFORT";

export interface RetrievalTruthState {
  consistency: TruthConsistencyMode;
  snapshot: TruthSnapshot;
  changedDuringQuery: boolean;
}

export interface RetrievalExecutionOptions {
  channels?: Array<
    "context-pack" | "exact" | "lexical" | "vector" | "graph" | "raw" | "code"
  >;
  plan?: QueryPlan;
  /** P6 typed retrieval policy; legacy execution options remain compatible. */
  retrievalPolicy?: RetrievalPolicyInput;
  /** Runtime capability snapshot. Production callers must provide all fields. */
  plannerCapabilities?: Partial<QueryPlannerCapabilities>;
  graphPolicy?: Partial<GraphTraversalPolicy>;
  /** Optional P6.9 associative expansion policy; disabled unless GRAPH_PPR is enabled. */
  pprPolicy?: Partial<PersonalizedPageRankPolicy>;
  graphScopes?: Array<{ vaultId: string; pathPrefix: string | null }>;
  allowVectorForBenchmark?: boolean;
  deterministicRerank?: boolean;
  /** Optional P6.7 query assistance. It never receives authorization/truth controls. */
  queryTransformer?: QueryTransformerPort;
  queryTransformMaxVariants?: number;
  queryTransformActorId?: string;
  queryTransformTraceId?: string;
  /** Test/provider injection seam; production resolves the active descriptor. */
  queryEmbeddingService?: QueryEmbeddingService;
  /** Safe capability warnings accumulated without changing the legacy hit return type. */
  warningSink?: string[];
  /** Channels that reached their provider/index successfully for this request. */
  availableChannelSink?: Set<RetrievalChannel>;
  vaultIds?: string[];
  /** Exact, authorized Code Graph candidates resolved by the HTTP boundary. */
  codeCandidates?: CodeChannelCandidate[];
  /** Applied after policy/trust filtering so a scoped caller never receives a
   * path it is not allowed to read. */
  pathAuthorizer?: (path: string, vaultId?: string) => boolean;
  truthConsistency?: TruthConsistencyMode;
  truthStateSink?: (state: RetrievalTruthState) => void;
}

export interface SearchRouteDependencies {
  /** Active model/agent tokenizer when the runtime provides one. */
  contextTokenizer?: Tokenizer;
  /** Optional experimental query transformer, normally controlled by feature flag. */
  queryTransformer?: QueryTransformerPort;
}

interface StoredContextPacketRow {
  id: string;
  space_id: string;
  corpus_revision: string;
  packet_hash: string;
  request: unknown;
  packet: unknown;
}

interface StoredContextContinuationRow extends StoredContextPacketRow {
  handle: string;
  reason: string;
  remaining_tokens: number;
  sections: unknown;
}

interface CurrentContextDocumentRow {
  id: string;
  space_id: string;
  vault_id: string;
  path: string;
  current_revision: string;
  lifecycle: string;
  refresh_status: string;
  trust_tier: string;
  layer: string;
  type: string;
}

function sameStringSet(left: readonly string[], right: readonly string[]) {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function modeAllowsCurrentDocument(
  mode: SearchInput["mode"],
  row: CurrentContextDocumentRow,
): boolean {
  const raw = row.layer === "resource" || row.type === "raw-resource";
  if (mode === "RAW_ONLY") return raw;
  if (mode === "COMPILED_ONLY") {
    return row.layer !== "resource" && row.layer !== "source";
  }
  if (mode === "SOURCE_BACKED") return !raw;
  return true;
}

/**
 * Re-authorize a persisted packet snapshot at read time. A handle is not a
 * bearer credential: every vault, path, lifecycle, trust tier and revision is
 * checked again so revocation or corpus mutation fails closed.
 */
async function readableContextSnapshot(
  db: Postgres,
  actor: NonNullable<ReturnType<typeof actorOf>>,
  row: StoredContextPacketRow,
  sections: readonly ContextSection[],
): Promise<{ packet: ContextPacket; request: SearchInput } | null> {
  const packetResult = ContextPacketSchema.safeParse(row.packet);
  const requestResult = SearchRequest.safeParse(row.request);
  if (!packetResult.success || !requestResult.success) return null;
  const packet = packetResult.data;
  const contextRequest = requestResult.data;
  if (
    packet.packetId !== row.id ||
    packet.packetHash !== row.packet_hash ||
    packet.corpusRevision !== row.corpus_revision ||
    packet.scope.spaceId !== row.space_id ||
    contextRequest.spaceId !== row.space_id ||
    contextRequest.query !== packet.query ||
    contextRequest.mode !== packet.mode ||
    !sameStringSet(packet.scope.vaultIds, [
      ...new Set([
        ...(contextRequest.vaultId ? [contextRequest.vaultId] : []),
        ...contextRequest.vaultIds,
      ]),
    ]) ||
    !hasSpaceAccess(actor, row.space_id, "knowledge:read")
  ) {
    return null;
  }

  let accessByVault: AuthorizedVaultScope["accessByVault"];
  try {
    const currentScope = await new PostgresAuthorizationPort(
      db,
    ).resolveVaultScope({
      userId: actor.id,
      spaceId: row.space_id,
      permission: "knowledge:read",
      vaultIds: packet.scope.vaultIds,
      federated: packet.scope.federated,
    });
    if (!sameStringSet(currentScope.vaultIds, packet.scope.vaultIds)) {
      return null;
    }
    accessByVault = currentScope.accessByVault;
  } catch {
    return null;
  }

  const documentIds = [
    ...new Set(sections.map((section) => section.documentId)),
  ];
  const currentDocuments =
    documentIds.length === 0
      ? { rows: [] as CurrentContextDocumentRow[] }
      : await db.pool.query<CurrentContextDocumentRow>(
          `
          select id,space_id,vault_id,path,current_revision,lifecycle,
                 refresh_status,trust_tier,layer,type
            from knowledge_documents
           where space_id=$1 and id=any($2::uuid[])
          `,
          [row.space_id, documentIds],
        );
  const currentById = new Map(
    currentDocuments.rows.map((document) => [String(document.id), document]),
  );
  const allowedLifecycles = new Set(
    contextRequest.mode === "DRAFT_INCLUDED"
      ? ["ACTIVE", "DISPUTED", "DRAFT"]
      : ["ACTIVE", "DISPUTED"],
  );
  const minimumTrust = TRUST_RANK[contextRequest.minimumTrust] ?? 1;
  for (const section of sections) {
    const current = currentById.get(section.documentId);
    const vaultAccess = accessByVault[section.vaultId];
    if (
      !current ||
      !vaultAccess ||
      current.space_id !== row.space_id ||
      current.vault_id !== section.vaultId ||
      current.path !== section.document.path ||
      current.current_revision !== section.documentRevision ||
      !allowedLifecycles.has(current.lifecycle) ||
      ["STALE_BLOCKED", "INVALID"].includes(current.refresh_status) ||
      (TRUST_RANK[current.trust_tier] ?? -1) < minimumTrust ||
      !modeAllowsCurrentDocument(contextRequest.mode, current) ||
      !pathMatchesVaultPrefix(current.path, vaultAccess.pathPrefix) ||
      !hasPathAccess(actor, row.space_id, "knowledge:read", current.path)
    ) {
      return null;
    }
  }
  return { packet, request: contextRequest };
}

interface ActiveEmbeddingGenerationRow {
  id: string;
  space_id: string;
  vault_id: string;
  corpus_revision: string;
  provider: string;
  model: string;
  model_revision: string;
  dimensions: number;
  normalization: string;
  input_strategy: string;
  configuration_version: string;
  runtime: string;
  configuration_hash: string;
}

interface VectorSearchRow {
  generation_id: string;
  vault_id: string;
  id: string;
  unit_id: string;
  unit_type: string;
  document_revision: string;
  score: number;
  query_variant_kind?: QueryTransformationKind;
  query_variant_ordinal?: number;
}

function vectorTruthRef(row: VectorSearchRow): string {
  return `vector:${row.generation_id}:${row.unit_id}`;
}

function activeDescriptor(
  row: ActiveEmbeddingGenerationRow,
): ActiveEmbeddingGenerationDescriptor {
  return {
    generationId: row.id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
    corpusRevision: row.corpus_revision,
    provider: row.provider,
    model: row.model,
    modelRevision: row.model_revision,
    dimensions: Number(row.dimensions),
    normalization: row.normalization,
    inputStrategy: row.input_strategy,
    configurationVersion: row.configuration_version,
    runtime: row.runtime,
    configurationHash: row.configuration_hash,
  };
}

type RetrievalChannel = NonNullable<
  RetrievalExecutionOptions["channels"]
>[number];

type IndexRevisionRow = Record<string, unknown> & {
  vault_id?: string;
  corpus_revision?: string;
};

function combineVaultIndexRows(rows: IndexRevisionRow[]): IndexRevisionRow {
  if (rows.length === 0) return {};
  if (rows.length === 1) return rows[0] ?? {};
  const stable = rows
    .map((row) => ({
      vaultId: String(row.vault_id ?? ""),
      corpusRevision: String(row.corpus_revision ?? ""),
    }))
    .sort((left, right) => left.vaultId.localeCompare(right.vaultId));
  const corpusRevision = `federated:${createHash("sha256")
    .update(JSON.stringify(stable))
    .digest("hex")}`;
  const result: IndexRevisionRow = {
    corpus_revision: corpusRevision,
    status: rows.every((row) => String(row.status) === "CONSISTENT")
      ? "CONSISTENT"
      : "DEGRADED",
    warnings: rows.flatMap((row) =>
      Array.isArray(row.warnings) ? row.warnings : [],
    ),
    retrieval_configuration_version: "federated-rrf-v1",
  };
  for (const field of [
    "lexical_revision",
    "vector_revision",
    "graph_revision",
    "context_pack_revision",
  ]) {
    const everyCurrent = rows.every(
      (row) =>
        String(row[field] ?? "") === String(row.corpus_revision ?? "") &&
        String(row[field] ?? "") !== "",
    );
    if (everyCurrent) {
      result[field] = corpusRevision;
      continue;
    }
    if (
      field === "vector_revision" &&
      rows.some((row) => String(row[field] ?? "") !== "")
    ) {
      const vectorRevisions = rows
        .map((row) => ({
          vaultId: String(row.vault_id ?? ""),
          revision: row[field] ? String(row[field]) : null,
        }))
        .sort((left, right) => left.vaultId.localeCompare(right.vaultId));
      result[field] = `federated-vector:${createHash("sha256")
        .update(JSON.stringify(vectorRevisions))
        .digest("hex")}`;
      continue;
    }
    result[field] = null;
  }
  return result;
}

function revisionIsCurrent(
  index: Record<string, unknown> | undefined,
  field: string,
): boolean {
  const corpus = index?.corpus_revision
    ? String(index.corpus_revision)
    : undefined;
  const revision = index?.[field] ? String(index[field]) : undefined;
  return Boolean(corpus && revision && corpus === revision);
}

export function plannerCapabilitiesForIndex(
  index: Record<string, unknown> | undefined,
  policy: {
    vectorProviderAvailable: boolean;
    communityAvailable?: boolean;
    rawAllowed: boolean;
    codeAdapterAvailable: boolean;
  },
): QueryPlannerCapabilities {
  return {
    vectorAvailable:
      policy.vectorProviderAvailable &&
      revisionIsCurrent(index, "vector_revision"),
    graphConsistent: revisionIsCurrent(index, "graph_revision"),
    communityAvailable: policy.communityAvailable === true,
    rawAllowed: policy.rawAllowed,
    codeAdapterAvailable: policy.codeAdapterAvailable,
    contextPackAvailable: revisionIsCurrent(index, "context_pack_revision"),
  };
}

function channelAllowedByCapabilities(
  channel: RetrievalChannel,
  capabilities: QueryPlannerCapabilities,
): boolean {
  switch (channel) {
    case "exact":
    case "lexical":
      return true;
    case "vector":
      return capabilities.vectorAvailable;
    case "graph":
      return capabilities.graphConsistent;
    case "raw":
      return capabilities.rawAllowed;
    case "code":
      return capabilities.codeAdapterAvailable;
    case "context-pack":
      return capabilities.contextPackAvailable;
  }
}

async function activeCommunityIndexAvailable(
  db: Postgres,
  spaceId: string,
  indexRows: readonly IndexRevisionRow[],
): Promise<boolean> {
  const expected = indexRows
    .map((row) => ({
      vaultId: String(row.vault_id ?? ""),
      corpusRevision: String(row.corpus_revision ?? ""),
      graphRevision: String(row.graph_revision ?? ""),
    }))
    .filter(
      (row) =>
        row.vaultId &&
        row.corpusRevision &&
        row.graphRevision &&
        row.corpusRevision === row.graphRevision,
    );
  if (expected.length !== indexRows.length || expected.length === 0) {
    return false;
  }
  try {
    const active = await db.pool.query<{
      vault_id: string;
      graph_revision: string;
    }>(
      `
      select vault_id,graph_revision
        from community_index_revisions
       where space_id=$1 and vault_id=any($2::uuid[])
         and status='ACTIVE' and stale=false
      `,
      [spaceId, expected.map((row) => row.vaultId)],
    );
    const byVault = new Map(
      active.rows.map((row) => [
        String(row.vault_id),
        String(row.graph_revision),
      ]),
    );
    return expected.every(
      (row) => byVault.get(row.vaultId) === row.graphRevision,
    );
  } catch {
    return false;
  }
}

async function activeVectorProviderAvailable(
  db: Postgres,
  spaceId: string,
  vaultIds: readonly string[],
): Promise<boolean> {
  if (process.env.AKP_VECTOR_ENABLED !== "true") return false;
  try {
    const generations = await db.pool.query<ActiveEmbeddingGenerationRow>(
      `
      select distinct on (g.vault_id)
             g.id,g.space_id,g.vault_id,g.corpus_revision,g.provider,g.model,
             g.model_revision,g.dimensions,g.normalization,g.input_strategy,
             g.configuration_version,g.runtime,g.configuration_hash
        from embedding_generations g
        join vault_index_revisions i
          on i.space_id=g.space_id and i.vault_id=g.vault_id
         and i.vector_revision=g.corpus_revision
       where g.space_id=$1 and g.vault_id=any($2::uuid[])
         and g.status='ACTIVE'
       order by g.vault_id,g.activated_at desc nulls last,g.created_at desc
      `,
      [spaceId, vaultIds],
    );
    return generations.rows.some((row) => {
      try {
        createEmbeddingProviderForGeneration(activeDescriptor(row));
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

export function channelsConsistentWithIndex(
  requested: Iterable<RetrievalChannel>,
  index: Record<string, unknown> | undefined,
  vectorAllowed: boolean,
): { channels: RetrievalChannel[]; warnings: string[] } {
  const channels = new Set(requested);
  const warnings: string[] = [];
  const corpus = index?.corpus_revision ? String(index.corpus_revision) : null;
  const derived: Array<[RetrievalChannel, string]> = [
    ["lexical", "lexical_revision"],
    ["graph", "graph_revision"],
    ["context-pack", "context_pack_revision"],
    ["vector", "vector_revision"],
  ];
  for (const [channel, field] of derived) {
    if (!channels.has(channel)) continue;
    const revision = index?.[field] ? String(index[field]) : null;
    if (channel === "vector" && corpus && revision && revision !== corpus) {
      warnings.push("INDEX_REVISION_STALE:vector");
      continue;
    }
    if (!corpus || !revision || revision !== corpus) {
      channels.delete(channel);
      warnings.push(`INDEX_REVISION_MISMATCH:${channel}`);
    }
  }
  if (channels.has("vector") && !vectorAllowed) {
    channels.delete("vector");
    warnings.push("VECTOR_DISABLED");
  }
  return { channels: [...channels], warnings };
}

/**
 * Reconcile planned channels with the channels that actually executed.
 *
 * A federated vector request may have a usable generation in only a subset of
 * its vaults. Vector remains effective when at least one vault completed the
 * query; it is removed only when no vault completed it.
 */
export function effectiveRetrievalChannels(
  channelState: ReturnType<typeof channelsConsistentWithIndex>,
  retrievalWarnings: readonly string[],
  availableChannels: ReadonlySet<RetrievalChannel>,
): { channels: RetrievalChannel[]; warnings: string[] } {
  const channels = new Set(channelState.channels);
  for (const channel of ["vector", "graph"] as const) {
    if (channels.has(channel) && !availableChannels.has(channel)) {
      channels.delete(channel);
    }
  }
  return {
    channels: [...channels],
    warnings: [...new Set([...channelState.warnings, ...retrievalWarnings])],
  };
}

/**
 * Evidence locators are corpus data and can contain local paths.  A
 * path-scoped caller must not receive a locator for a path outside its
 * membership prefix, even when the matched document itself is readable.
 * Synthetic `source:<uuid>` locators identify an already scoped source and
 * are not filesystem paths.
 */
export function evidenceLocatorAllowed(
  locator: unknown,
  pathAuthorizer?: (path: string) => boolean,
): boolean {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) {
    return false;
  }
  const candidate = locator as Record<string, unknown>;
  for (const [key, value] of Object.entries(candidate)) {
    if (UNSAFE_LOCATOR_KEY.test(key)) return false;
    if (typeof value === "string" && ABSOLUTE_LOCATOR_TOKEN.test(value)) {
      return false;
    }
    if (Array.isArray(value)) {
      if (
        value.some(
          (entry) =>
            (typeof entry === "string" && ABSOLUTE_LOCATOR_TOKEN.test(entry)) ||
            (entry !== null &&
              typeof entry === "object" &&
              !evidenceLocatorAllowed(entry, pathAuthorizer)),
        )
      ) {
        return false;
      }
    } else if (value && typeof value === "object") {
      if (!evidenceLocatorAllowed(value, pathAuthorizer)) return false;
    }
  }
  for (const key of ["path", "source_path", "document_path"]) {
    const value = candidate[key];
    if (typeof value !== "string") continue;
    if (value.startsWith("source:")) {
      if (
        !/^source:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value,
        )
      ) {
        return false;
      }
      continue;
    }
    if (pathAuthorizer && !pathAuthorizer(value)) return false;
  }
  return true;
}

/** Keep only portable locator data in a retrieval response. */
export function sanitizeEvidenceLocator(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeEvidenceLocator);
  if (typeof value === "string") {
    return value.replace(
      /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var)\/)[^\s"']+/g,
      "[REDACTED_PATH]",
    );
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !UNSAFE_LOCATOR_KEY.test(key))
      .map(([key, entry]) => [key, sanitizeEvidenceLocator(entry)]),
  );
}

interface AssistedRetrievalQuery {
  query: string;
  variant?: QueryTransformationVariant;
}

async function transformedRetrievalQueries(input: {
  db: Postgres;
  originalQuery: string;
  intent: string;
  strategy: string;
  spaceId: string;
  vaultIds: string[];
  graphScopes: GraphScope[];
  truthSnapshot: TruthSnapshot;
  assistedChannels: string[];
  options: RetrievalExecutionOptions;
}): Promise<AssistedRetrievalQuery[]> {
  const transformer = input.options.queryTransformer;
  if (!transformer || input.assistedChannels.length === 0) {
    return [{ query: input.originalQuery }];
  }

  try {
    const transformed = validateQueryTransformationResult(
      await transformer.transform({
        originalQuery: input.originalQuery,
        intent: input.intent,
        ...(input.options.queryTransformMaxVariants === undefined
          ? {}
          : { maxVariants: input.options.queryTransformMaxVariants }),
      }),
      input.originalQuery,
      input.options.queryTransformMaxVariants,
    );

    const persisted = await input.db.pool.query<{ id: string }>(
      `
      insert into retrieval_query_traces(
        space_id,actor_id,trace_id,original_query,original_query_hash,
        intent,strategy,transformer_id,transform_kind,variants,variant_count,
        assisted_channels,vault_ids,scope,truth_snapshot
      ) values(
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::text[],$13::uuid[],
        $14::jsonb,$15::jsonb
      )
      returning id
      `,
      [
        input.spaceId,
        input.options.queryTransformActorId ?? null,
        input.options.queryTransformTraceId ?? null,
        transformed.originalQuery,
        createHash("sha256").update(transformed.originalQuery).digest("hex"),
        input.intent,
        input.strategy,
        transformed.transformerId,
        transformed.kind,
        JSON.stringify(transformed.variants),
        transformed.variants.length,
        input.assistedChannels,
        input.vaultIds,
        JSON.stringify({
          vaultIds: input.vaultIds,
          graphScopes: input.graphScopes,
        }),
        JSON.stringify(input.truthSnapshot),
      ],
    );
    if (!persisted.rows[0]?.id) {
      input.options.warningSink?.push("QUERY_TRANSFORM_TRACE_NOT_PERSISTED");
      return [{ query: input.originalQuery }];
    }

    return [
      { query: input.originalQuery },
      ...transformed.variants.map((variant) => ({
        query: variant.query,
        variant,
      })),
    ];
  } catch (error) {
    const code =
      error instanceof Error ? error.message : "QUERY_TRANSFORM_FAILED";
    input.options.warningSink?.push(`QUERY_TRANSFORM_SKIPPED:${code}`);
    return [{ query: input.originalQuery }];
  }
}

function lexicalRowKey(row: LexicalSearchRow): string {
  return `${row.id}:${row.unit_id ?? ""}`;
}

function mergeLexicalRows(rows: readonly LexicalSearchRow[]): LexicalSearchRow[] {
  const best = new Map<string, LexicalSearchRow>();
  for (const row of rows) {
    const key = lexicalRowKey(row);
    const current = best.get(key);
    if (
      !current ||
      Number(row.score) > Number(current.score) ||
      (Number(row.score) === Number(current.score) &&
        current.query_variant_kind !== undefined &&
        row.query_variant_kind === undefined)
    ) {
      best.set(key, row);
    }
  }
  return [...best.values()].sort(
    (left, right) =>
      Number(right.score) - Number(left.score) ||
      String(left.id).localeCompare(String(right.id)) ||
      String(left.unit_id ?? "").localeCompare(String(right.unit_id ?? "")),
  );
}

function vectorRowKey(row: VectorSearchRow): string {
  return `${row.generation_id}:${row.unit_id}`;
}

function mergeVectorRows(rows: readonly VectorSearchRow[]): VectorSearchRow[] {
  const best = new Map<string, VectorSearchRow>();
  for (const row of rows) {
    const key = vectorRowKey(row);
    const current = best.get(key);
    if (
      !current ||
      Number(row.score) > Number(current.score) ||
      (Number(row.score) === Number(current.score) &&
        current.query_variant_kind !== undefined &&
        row.query_variant_kind === undefined)
    ) {
      best.set(key, row);
    }
  }
  return [...best.values()].sort(
    (left, right) =>
      Number(right.score) - Number(left.score) ||
      String(left.id).localeCompare(String(right.id)) ||
      String(left.unit_id).localeCompare(String(right.unit_id)),
  );
}

export async function queryKnowledge(
  db: Postgres,
  input: SearchInput,
  options: RetrievalExecutionOptions = {},
): Promise<SearchHit[]> {
  if (!input.spaceId) throw new Error("SPACE_ID_REQUIRED");
  const spaceId = input.spaceId;
  const vaultIds = [
    ...new Set([
      ...(options.vaultIds ?? []),
      ...(input.vaultId ? [input.vaultId] : []),
      ...(input.vaultIds ?? []),
    ]),
  ];
  if (vaultIds.length === 0) {
    throw new Error("VAULT_SCOPE_REQUIRED");
  }
  if (vaultIds.length > 1 && !input.federated) {
    throw new Error("FEDERATED_QUERY_REQUIRES_EXPLICIT_OPT_IN");
  }
  if (
    vaultIds.some(
      (id) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          id,
        ),
    )
  ) {
    throw new Error("INVALID_VAULT_ID");
  }
  const vaultFilter = (alias = "") =>
    vaultIds.length === 0
      ? ""
      : `and ${alias}vault_id=any(array[${vaultIds
          .map((id) => `'${id}'::uuid`)
          .join(",")}])`;
  const truthConsistency: TruthConsistencyMode =
    options.truthConsistency ??
    input.truthConsistency ??
    options.retrievalPolicy?.truthValidation ??
    "STRICT";
  const truthStore = new PostgresTemporalTruthStore(db);
  const truthSnapshot = await truthStore.captureSnapshot(spaceId, vaultIds);
  const finalizeTruthSnapshot = async (): Promise<RetrievalTruthState> => {
    const changedDuringQuery =
      !(await truthStore.snapshotUnchanged(truthSnapshot));
    const state: RetrievalTruthState = {
      consistency: truthConsistency,
      snapshot: truthSnapshot,
      changedDuringQuery,
    };
    options.truthStateSink?.(state);
    if (changedDuringQuery) {
      if (truthConsistency === "STRICT") {
        throw new Error("CONTEXT_REVISION_CHANGED");
      }
      options.warningSink?.push("CONTEXT_REVISION_CHANGED_BEST_EFFORT");
    }
    return state;
  };
  const indexRows = await db.pool.query(
    `select vault_id,corpus_revision,lexical_revision,vector_revision,
            graph_revision,context_pack_revision,status,warnings,
            retrieval_configuration_version
       from vault_index_revisions
      where space_id=$1 and vault_id=any($2::uuid[])
      order by vault_id`,
    [spaceId, vaultIds],
  );
  const index = combineVaultIndexRows(indexRows.rows);
  const inferredCapabilities = plannerCapabilitiesForIndex(index, {
    vectorProviderAvailable:
      process.env.AKP_VECTOR_ENABLED === "true" ||
      Boolean(options.allowVectorForBenchmark),
    communityAvailable: await activeCommunityIndexAvailable(
      db,
      spaceId,
      indexRows.rows,
    ),
    // Direct library callers do not carry an actor. Raw retrieval therefore
    // fails closed unless they explicitly request RAW_ONLY or inject policy.
    rawAllowed: input.mode === "RAW_ONLY",
    // A project-layer SQL filter is not an external code adapter capability.
    codeAdapterAvailable: false,
  });
  const capabilities: QueryPlannerCapabilities = {
    ...inferredCapabilities,
    // Low-level benchmark/evaluation callers can deliberately exercise the
    // last usable vector generation during a rebuild. HTTP production routes
    // pass a strict capability-aware plan and never take this compatibility
    // path.
    vectorAvailable:
      (process.env.AKP_VECTOR_ENABLED === "true" ||
        Boolean(options.allowVectorForBenchmark)) &&
      Boolean(index.vector_revision),
    ...(options.plannerCapabilities ?? {}),
  };
  const plan =
    options.plan ?? planQuery(input.query, input.intent, capabilities);
  const effectiveStrategy = options.retrievalPolicy?.graphMode ?? plan.strategy;
  const explicitChannels = options.retrievalPolicy?.channels ?? {};
  const retrievalPolicy = resolveRetrievalPolicy({
    ...(options.retrievalPolicy ?? {}),
    graphMode: effectiveStrategy,
    truthValidation: truthConsistency,
    channels: {
      ...explicitChannels,
      ...(effectiveStrategy === "ASSOCIATIVE" &&
      explicitChannels.GRAPH_PPR === undefined
        ? { GRAPH_PPR: { enabled: true } }
        : {}),
      ...((effectiveStrategy === "GLOBAL" || effectiveStrategy === "DRIFT") &&
      explicitChannels.COMMUNITY === undefined
        ? { COMMUNITY: { enabled: true } }
        : {}),
    },
  });
  const effectiveCapabilities = options.plan?.capabilities ?? capabilities;
  const graphPolicy = normalizeGraphPolicy(
    options.graphPolicy,
    plan,
    input.limit,
  );
  // A JavaScript path callback cannot safely participate in SQL ranking.  If a
  // caller supplies one, require equivalent SQL scopes so unauthorized seeds
  // or paths cannot consume bounded graph slots before the callback runs.
  const graphScopes = normalizeGraphScopes(
    vaultIds,
    options.pathAuthorizer !== undefined && options.graphScopes === undefined
      ? []
      : options.graphScopes,
  );
  const requestedByPolicy = options.channels ?? plan.channels;
  const requestedChannels = requestedByPolicy.filter(
    (channel) =>
      runtimeChannelEnabled(retrievalPolicy, channel) &&
      channelAllowedByCapabilities(channel, effectiveCapabilities),
  );
  for (const channel of requestedByPolicy) {
    if (!runtimeChannelEnabled(retrievalPolicy, channel)) {
      options.warningSink?.push(`CHANNEL_POLICY_DISABLED:${channel}`);
      continue;
    }
    if (!requestedChannels.includes(channel)) {
      options.warningSink?.push(`CHANNEL_CAPABILITY_UNAVAILABLE:${channel}`);
    }
  }
  const consistency = channelsConsistentWithIndex(
    requestedChannels,
    index,
    process.env.AKP_VECTOR_ENABLED === "true" ||
      Boolean(options.allowVectorForBenchmark),
  );
  for (const warning of consistency.warnings) {
    options.warningSink?.push(warning);
  }
  const channels = new Set(consistency.channels);
  const modeClause =
    input.mode === "RAW_ONLY"
      ? "and (layer = 'resource' or type = 'raw-resource')"
      : input.mode === "COMPILED_ONLY"
        ? "and layer not in ('resource', 'source')"
        : input.mode === "SOURCE_BACKED"
          ? "and not (layer = 'resource' or type = 'raw-resource')"
          : "";
  const lifecycleClause =
    input.mode === "DRAFT_INCLUDED"
      ? "in ('ACTIVE','DISPUTED','DRAFT')"
      : "in ('ACTIVE','DISPUTED')";
  const allowedLifecycles = new Set(
    input.mode === "DRAFT_INCLUDED"
      ? ["ACTIVE", "DISPUTED", "DRAFT"]
      : ["ACTIVE", "DISPUTED"],
  );
  const minimumTrust = TRUST_RANK[input.minimumTrust] ?? 1;
  const trustClause = (alias = "") =>
    `(case ${alias}trust_tier ` +
    "when 'UNVERIFIED' then 0 " +
    "when 'MACHINE_SUPPORTED' then 1 " +
    "when 'HUMAN_REVIEWED' then 2 " +
    "when 'ATTESTED' then 3 else -1 end) " +
    `>= ${minimumTrust}`;

  const assistedChannels = [
    ...(channels.has("lexical") || channels.has("graph") ? ["LEXICAL"] : []),
    ...(channels.has("vector") ? ["VECTOR"] : []),
  ];
  const assistedQueries = await transformedRetrievalQueries({
    db,
    originalQuery: input.query,
    intent: plan.intent,
    strategy: effectiveStrategy,
    spaceId,
    vaultIds,
    graphScopes,
    truthSnapshot,
    assistedChannels,
    options,
  });

  const exact = channels.has("exact")
    ? await observedRetrieval("exact", () =>
        db.pool.query<ExactSearchRow>(
          `
        select d.id,d.current_revision document_revision,
               case
                 when lower(d.external_id)=lower($2) then 'exact:external-id'
                 when exists (
                   select 1 from unnest(d.aliases) alias
                    where lower(alias)=lower($2)
                 ) then 'exact:alias'
                 when lower(d.title)=lower($2) then 'exact:title'
                 else 'exact:path'
               end match_reason
          from knowledge_documents d
         where d.space_id=$1
           ${vaultFilter("d.")}
           and d.lifecycle ${lifecycleClause}
           and ${trustClause("d.")}
           and d.refresh_status not in ('STALE_BLOCKED','INVALID')
           and (
             lower(d.external_id)=lower($2)
             or exists (
               select 1 from unnest(d.aliases) alias
                where lower(alias)=lower($2)
             )
             or lower(d.title)=lower($2)
             or lower(d.path)=lower($2)
           )
           ${modeClause}
         order by
           case
             when lower(d.external_id)=lower($2) then 0
             when exists (
               select 1 from unnest(d.aliases) alias
                where lower(alias)=lower($2)
             ) then 1
             when lower(d.title)=lower($2) then 2
             else 3
           end,
           d.id
         limit $3
        `,
          [spaceId, input.query, Math.max(input.limit * 2, 20)],
        ),
      )
    : { rows: [] as ExactSearchRow[] };
  recordRetrievalCandidates("exact", exact.rows.length);
  if (channels.has("exact")) options.availableChannelSink?.add("exact");

  const lexicalRows: LexicalSearchRow[] = [];
  if (channels.has("lexical") || channels.has("graph")) {
    for (const assisted of assistedQueries) {
      const result = await observedRetrieval("lexical", () =>
        db.pool.query<LexicalSearchRow>(
          `
          with query as (
            select plainto_tsquery('simple', $2) terms,
                   plainto_tsquery(
                     'simple',
                     akp_lexical_symbol_text($2)
                   ) symbol_terms
          ), eligible_documents as (
            select d.id,d.current_revision,d.lexical_external_id_vector,
                   d.lexical_alias_vector,d.lexical_title_vector,
                   d.lexical_path_vector,d.lexical_body_vector,
                   d.lexical_search_vector,d.lexical_symbol_vector,
                   i.lexical_revision index_revision,
                   query.terms,query.symbol_terms
              from knowledge_documents d
              join vault_index_revisions i
                on i.space_id=d.space_id and i.vault_id=d.vault_id
               and i.lexical_revision=i.corpus_revision
              cross join query
             where d.space_id=$1
               ${vaultFilter("d.")}
               and d.lifecycle ${lifecycleClause}
               and ${trustClause("d.")}
               and d.refresh_status not in ('STALE_BLOCKED','INVALID')
               ${modeClause}
               and (
                 d.lexical_search_vector @@ query.terms
                 or d.lexical_symbol_vector @@ query.symbol_terms
                 or exists (
                   select 1
                     from knowledge_units matching_unit
                    where matching_unit.document_id=d.id
                      and matching_unit.space_id=d.space_id
                      and matching_unit.vault_id=d.vault_id
                      and matching_unit.corpus_revision=i.lexical_revision
                      and matching_unit.lifecycle ${lifecycleClause}
                      and ${trustClause("matching_unit.")}
                      and (
                        matching_unit.lexical_search_vector @@ query.terms
                        or matching_unit.lexical_symbol_vector @@ query.symbol_terms
                      )
                 )
               )
          ), scored as (
            select d.id,best_unit.unit_id,best_unit.unit_type,
                   d.current_revision document_revision,
                   32 * ts_rank_cd(d.lexical_external_id_vector,d.terms) +
                   28 * ts_rank_cd(d.lexical_alias_vector,d.terms) +
                   20 * ts_rank_cd(d.lexical_title_vector,d.terms) +
                   24 * ts_rank_cd(d.lexical_path_vector,d.terms) +
                    2 * ts_rank_cd(d.lexical_body_vector,d.terms) +
                   case
                     when not (d.lexical_search_vector @@ d.terms)
                      and d.lexical_symbol_vector @@ d.symbol_terms
                     then 26 * ts_rank_cd(
                       d.lexical_symbol_vector,
                       d.symbol_terms
                     )
                     else 0
                   end +
                   coalesce(best_unit.unit_score,0) score,
                   case
                     when d.lexical_external_id_vector @@ d.terms
                       then 'lexical:external-id-terms'
                     when d.lexical_alias_vector @@ d.terms
                       then 'lexical:alias-terms'
                     when d.lexical_path_vector @@ d.terms
                       then 'lexical:path-terms'
                     when d.lexical_title_vector @@ d.terms
                       then 'lexical:title-terms'
                     when d.lexical_symbol_vector @@ d.symbol_terms
                      and not (d.lexical_search_vector @@ d.terms)
                       then 'lexical:symbol-terms'
                     when best_unit.heading_match
                       then 'lexical:heading-terms'
                     when best_unit.unit_match
                       then 'lexical:unit-terms'
                     when best_unit.symbol_match
                       then 'lexical:symbol-terms'
                     else 'lexical:body-terms'
                   end match_reason
              from eligible_documents d
              left join lateral (
                select u.id unit_id,u.unit_type,
                       12 * ts_rank_cd(u.lexical_heading_vector,d.terms) +
                        8 * ts_rank_cd(u.lexical_unit_vector,d.terms) +
                            ts_rank_cd(u.lexical_body_vector,d.terms) +
                       case
                         when not (u.lexical_search_vector @@ d.terms)
                          and u.lexical_symbol_vector @@ d.symbol_terms
                         then 10 * ts_rank_cd(
                           u.lexical_symbol_vector,
                           d.symbol_terms
                         )
                         else 0
                       end unit_score,
                       u.lexical_heading_vector @@ d.terms heading_match,
                       u.lexical_unit_vector @@ d.terms unit_match,
                       u.lexical_symbol_vector @@ d.symbol_terms symbol_match
                  from knowledge_units u
                 where u.document_id=d.id
                   and u.corpus_revision=d.index_revision
                   and u.lifecycle ${lifecycleClause}
                   and ${trustClause("u.")}
                  order by unit_score desc,u.container_only,u.structural_order,u.id
                 limit 1
              ) best_unit on true
          )
          select id,unit_id,unit_type,document_revision,score,match_reason
            from scored
           order by score desc,id,unit_id nulls last
           limit $3
          `,
          [spaceId, assisted.query, Math.max(input.limit * 3, 30)],
        ),
      );
      lexicalRows.push(
        ...result.rows.map((row) =>
          assisted.variant
            ? {
                ...row,
                match_reason:
                  `lexical:transformed:${assisted.variant.kind}:${row.match_reason}`,
                query_variant_kind: assisted.variant.kind,
                query_variant_ordinal: assisted.variant.ordinal,
              }
            : row,
        ),
      );
    }
  }
  const lexical = {
    rows: mergeLexicalRows(lexicalRows).slice(
      0,
      Math.max(input.limit * 3, 30),
    ),
  };
  recordRetrievalCandidates("lexical", lexical.rows.length);
  if (channels.has("lexical")) {
    options.availableChannelSink?.add("lexical");
  }

  const vector = { rows: [] as VectorSearchRow[] };
  if (
    (process.env.AKP_VECTOR_ENABLED === "true" ||
      options.allowVectorForBenchmark) &&
    channels.has("vector")
  ) {
    const generationStatus = options.allowVectorForBenchmark
      ? "in ('ACTIVE','READY')"
      : "='ACTIVE'";
    const generations = await db.pool.query<ActiveEmbeddingGenerationRow>(
      `
      select distinct on (g.vault_id)
             g.id,g.space_id,g.vault_id,g.corpus_revision,g.provider,g.model,
             g.model_revision,g.dimensions,g.normalization,g.input_strategy,
             g.configuration_version,g.runtime,g.configuration_hash
        from embedding_generations g
        join vault_index_revisions i
          on i.space_id=g.space_id and i.vault_id=g.vault_id
         and i.vector_revision=g.corpus_revision
       where g.space_id=$1 and g.vault_id=any($2::uuid[])
         and g.status ${generationStatus}
       order by g.vault_id,(g.status='ACTIVE') desc,
                g.activated_at desc nulls last,g.created_at desc
      `,
      [spaceId, vaultIds],
    );
    const generationVaults = new Set(
      generations.rows.map((row) => String(row.vault_id)),
    );
    for (const vaultId of vaultIds) {
      if (!generationVaults.has(vaultId)) {
        options.warningSink?.push(`VECTOR_GENERATION_UNAVAILABLE:${vaultId}`);
      }
    }
    const embeddingService =
      options.queryEmbeddingService ?? new QueryEmbeddingService();
    for (const generationRow of generations.rows) {
      const generation = activeDescriptor(generationRow);
      if (
        !Number.isSafeInteger(generation.dimensions) ||
        generation.dimensions < 1 ||
        generation.dimensions > 2000
      ) {
        throw new Error("EMBEDDING_GENERATION_DIMENSIONS_INVALID");
      }
      const dimensions = generation.dimensions;
      for (const assisted of assistedQueries) {
        let queryVector: number[];
        try {
          queryVector = await embeddingService.embedQuery(
            assisted.query,
            generation,
          );
        } catch {
          options.warningSink?.push(
            `VECTOR_PROVIDER_UNAVAILABLE:${generation.vaultId}`,
          );
          continue;
        }
        try {
          const result = await observedRetrieval("vector", () =>
            db.pool.query<VectorSearchRow>(
              `
              select $1::uuid generation_id,u.vault_id,
                     u.document_id id,u.id unit_id,u.unit_type,
                     u.document_revision,
                     1 - (e.embedding::vector(${dimensions}) <=> $3::vector(${dimensions})) score
                from unit_embeddings e
                join knowledge_units u on u.id=e.unit_id
                join knowledge_documents d on d.id=u.document_id
               where e.generation_id=$1 and u.space_id=$2 and u.vault_id=$4
                 and e.embedding_dimensions=${dimensions}
                 and e.content_hash=u.content_hash
                 and u.embedding_eligible
                 and u.lifecycle ${lifecycleClause}
                 and ${trustClause("u.")}
                 and d.lifecycle ${lifecycleClause}
                 and ${trustClause("d.")}
                 and d.refresh_status not in ('STALE_BLOCKED','INVALID')
                 ${modeClause}
               order by e.embedding::vector(${dimensions}) <=> $3::vector(${dimensions}),
                        u.document_id,u.id
               limit $5
              `,
              [
                generation.generationId,
                spaceId,
                toPgVector(queryVector),
                generation.vaultId,
                Math.max(input.limit * 3, 30),
              ],
            ),
          );
          options.availableChannelSink?.add("vector");
          vector.rows.push(
            ...result.rows.map((row) =>
              assisted.variant
                ? {
                    ...row,
                    query_variant_kind: assisted.variant.kind,
                    query_variant_ordinal: assisted.variant.ordinal,
                  }
                : row,
            ),
          );
        } catch {
          options.warningSink?.push(
            `VECTOR_QUERY_UNAVAILABLE:${generation.vaultId}`,
          );
        }
      }
    }
    vector.rows.splice(
      0,
      vector.rows.length,
      ...mergeVectorRows(vector.rows).slice(
        0,
        Math.max(input.limit * 3, 30),
      ),
    );
  }

  if (vector.rows.length > 0) {
    const truthRevisionByVault = new Map(
      truthSnapshot.vaults.map((entry) => [entry.vaultId, entry]),
    );
    const truthValidRows: VectorSearchRow[] = [];
    for (const vaultId of vaultIds) {
      const scopedRows = vector.rows.filter((row) => row.vault_id === vaultId);
      if (scopedRows.length === 0) continue;
      const snapshotEntry = truthRevisionByVault.get(vaultId);
      const validations = await truthStore.validateDerivedItems({
        spaceId,
        vaultId,
        derivedStoreKind: "VECTOR",
        derivedItemRefs: scopedRows.map(vectorTruthRef),
        ...(snapshotEntry?.revisionHash
          ? { truthRevisionHash: snapshotEntry.revisionHash }
          : {}),
      });
      const validationByRef = new Map(
        validations.map((validation) => [
          validation.derivedItemRef,
          validation,
        ]),
      );
      for (const row of scopedRows) {
        const validation = validationByRef.get(vectorTruthRef(row));
        if (validation?.valid === false) {
          options.warningSink?.push(
            `TRUTH_SUPPORT_REJECTED:VECTOR:${row.unit_id}`,
          );
          telemetry.counter("truth_candidate_rejected", 1, {
            channel: "vector",
            state: validation.state,
          });
          continue;
        }
        if (validation?.state === "DISPUTED") {
          options.warningSink?.push(
            `TRUTH_SUPPORT_DISPUTED:VECTOR:${row.unit_id}`,
          );
        }
        truthValidRows.push(row);
      }
    }
    vector.rows.splice(0, vector.rows.length, ...truthValidRows);
  }
  recordRetrievalCandidates("vector", vector.rows.length);

  const seedIds = [
    ...new Set(
      [...exact.rows, ...lexical.rows, ...vector.rows].map((row) =>
        String(row.id),
      ),
    ),
  ];
  const communityCandidates: CommunityCandidateRow[] = [];
  if (
    (retrievalPolicy.graphMode === "GLOBAL" ||
      retrievalPolicy.graphMode === "DRIFT") &&
    retrievalPolicy.channels.COMMUNITY.enabled &&
    effectiveCapabilities.communityAvailable
  ) {
    const driftSeeds = seedIds.filter((id) => UUID_PATTERN.test(id));
    try {
      const routed = await observedRetrieval("community", () =>
        db.pool.query<CommunityCandidateRow>(
          `
          with query as (
            select plainto_tsquery('simple',$2) terms
          ),
          active_community as (
            select r.id revision_id,r.vault_id,r.community_revision,
                   c.community_key,c.member_count,c.summary
              from community_index_revisions r
              join vault_index_revisions vi
                on vi.space_id=r.space_id and vi.vault_id=r.vault_id
               and vi.graph_revision=vi.corpus_revision
               and r.graph_revision=vi.graph_revision
              join community_index_communities c on c.revision_id=r.id
             where r.space_id=$1
               and r.vault_id=any($3::uuid[])
               and r.status='ACTIVE' and r.stale=false
               and c.summary_lifecycle='DERIVED_INDEX'
               and c.citable=false
          ),
          drift_community as (
            select distinct m.revision_id,m.community_key
              from community_index_memberships m
             where cardinality($4::uuid[]) > 0
               and m.document_id=any($4::uuid[])
          ),
          oriented as (
            select ac.*,
                   ts_rank_cd(
                     to_tsvector('simple',coalesce(ac.summary,'')),
                     query.terms
                   ) text_score,
                   case when dc.community_key is not null then 1 else 0 end
                     seed_match
              from active_community ac
              cross join query
              left join drift_community dc
                on dc.revision_id=ac.revision_id
               and dc.community_key=ac.community_key
             where $5::text='GLOBAL'
                or dc.community_key is not null
          )
          select d.id,d.current_revision document_revision,
                 o.community_key,o.community_revision,
                 (
                   100 * o.seed_match +
                   10 * o.text_score +
                   ln(greatest(o.member_count,1) + 1)
                 )::double precision orientation_score
            from oriented o
            join community_index_memberships m
              on m.revision_id=o.revision_id
             and m.community_key=o.community_key
            join knowledge_documents d on d.id=m.document_id
           where d.space_id=$1
             ${vaultFilter("d.")}
             and d.lifecycle ${lifecycleClause}
             and ${trustClause("d.")}
             and d.refresh_status not in ('STALE_BLOCKED','INVALID')
             ${modeClause}
             and not (
               $5::text='DRIFT'
               and cardinality($4::uuid[]) > 0
               and d.id=any($4::uuid[])
             )
           order by orientation_score desc,o.community_key,d.id
           limit $6
          `,
          [
            spaceId,
            input.query,
            vaultIds,
            driftSeeds,
            retrievalPolicy.graphMode,
            Math.max(input.limit * 4, 40),
          ],
        ),
      );
      communityCandidates.push(...routed.rows);
    } catch (error) {
      const code =
        error instanceof Error ? error.message : "COMMUNITY_ROUTING_FAILED";
      options.warningSink?.push(`COMMUNITY_UNAVAILABLE:${code}`);
    }
  }
  recordRetrievalCandidates("community", communityCandidates.length);

  const contextPack = channels.has("context-pack")
    ? await db.pool.query<DocumentChannelRow>(
        `
          with query as (select plainto_tsquery('simple',$2) terms)
          select d.id,d.current_revision document_revision
            from knowledge_documents d
            cross join query
           where d.space_id=$1
             ${vaultFilter("d.")}
             and d.lifecycle ${lifecycleClause}
             and ${trustClause("d.")}
             and d.refresh_status not in ('STALE_BLOCKED','INVALID')
             and (d.layer='context-pack' or d.type='context-pack')
             and d.lexical_search_vector @@ query.terms
           order by ts_rank_cd(d.lexical_search_vector,query.terms) desc,
                    d.path,d.id
           limit $3
          `,
        [spaceId, input.query, Math.max(input.limit, 10)],
      )
    : { rows: [] as DocumentChannelRow[] };
  if (channels.has("context-pack")) {
    options.availableChannelSink?.add("context-pack");
  }

  const rawFallback = channels.has("raw")
    ? await db.pool.query<DocumentChannelRow>(
        `
          with query as (select plainto_tsquery('simple',$2) terms)
          select d.id,d.current_revision document_revision
            from knowledge_documents d
            cross join query
           where d.space_id=$1
             ${vaultFilter("d.")}
             and d.lifecycle ${lifecycleClause}
             and ${trustClause("d.")}
             and d.refresh_status not in ('STALE_BLOCKED','INVALID')
             and (d.layer in ('source','resource') or d.type='raw-resource')
             and d.lexical_search_vector @@ query.terms
           order by d.trust_tier desc,
                    ts_rank_cd(d.lexical_search_vector,query.terms) desc,
                    d.path,d.id
           limit $3
          `,
        [spaceId, input.query, Math.max(input.limit, 10)],
      )
    : { rows: [] as DocumentChannelRow[] };
  if (channels.has("raw")) options.availableChannelSink?.add("raw");

  const codeFallback: { rows: CodeChannelRow[] } = channels.has("code")
    ? options.codeCandidates !== undefined
      ? {
          rows: options.codeCandidates.map((candidate) => ({
            id: candidate.id,
            document_revision: candidate.documentRevision,
            match_reason: candidate.reason,
            code_citations: candidate.citations,
          })),
        }
      : await db.pool.query<CodeChannelRow>(
          `
          with query as (select plainto_tsquery('simple',$2) terms)
          select d.id,d.current_revision document_revision
            from knowledge_documents d
            cross join query
           where d.space_id=$1
             ${vaultFilter("d.")}
             and d.lifecycle ${lifecycleClause}
             and ${trustClause("d.")}
             and d.refresh_status not in ('STALE_BLOCKED','INVALID')
             and d.layer='project'
             and d.lexical_search_vector @@ query.terms
           order by d.updated_at desc,
                    ts_rank_cd(d.lexical_search_vector,query.terms) desc,
                    d.id
           limit $3
          `,
          [spaceId, input.query, Math.max(input.limit, 10)],
        )
    : { rows: [] };
  if (channels.has("code")) options.availableChannelSink?.add("code");
  const codeCitationsByCandidate = new Map(
    codeFallback.rows.map((row) => [String(row.id), row.code_citations ?? []]),
  );

  const candidateSeedIds = seedIds.filter((id) => UUID_PATTERN.test(id));
  const graphRows =
    candidateSeedIds.length === 0 ||
    !channels.has("graph") ||
    graphPolicy.maxHops === 0 ||
    graphScopes.length === 0
      ? []
      : (
          await observedRetrieval("graph", () =>
            db.pool.query<GraphTraversalRow>(
              `
            with recursive
            graph_scopes as (
              select scope.vault_id,scope.path_prefix
                from jsonb_to_recordset($8::jsonb)
                  as scope(vault_id uuid,path_prefix text)
            ),
            scoped_documents as (
              select d.id,d.space_id,d.vault_id,d.external_id,d.path,
                     d.lifecycle,d.refresh_status
                from knowledge_documents d
                join graph_scopes scope on scope.vault_id=d.vault_id
               where d.id=any($2::uuid[])
                 and d.space_id=$1
                 and d.lifecycle ${lifecycleClause}
                 and ${trustClause("d.")}
                 and d.refresh_status not in ('STALE_BLOCKED','INVALID')
                 and (
                   scope.path_prefix is null
                   or d.path=scope.path_prefix
                   or starts_with(d.path,scope.path_prefix || '/')
                 )
               order by array_position($2::uuid[],d.id)
               limit $10::integer
            ),
            oriented_edges as (
              select distinct r.id,r.relation_type,
                     r.from_document_id current_document_id,
                     r.to_document_id next_document_id,
                     'outgoing' direction,
                     r.weight::double precision weight,
                     edge_from.vault_id
                from knowledge_relations r
                join knowledge_documents edge_from
                  on edge_from.id=r.from_document_id
                 and edge_from.space_id=$1
                join knowledge_documents edge_to
                  on edge_to.id=r.to_document_id
                 and edge_to.space_id=$1
                 and edge_to.vault_id=edge_from.vault_id
                join graph_scopes scope on scope.vault_id=edge_from.vault_id
               where r.space_id=$1
                 and r.relation_type=any($4::text[])
                 and r.weight is not null
                 and r.weight >= 0
                 and r.weight <= 1000000
                 and edge_from.lifecycle ${lifecycleClause}
                 and edge_to.lifecycle ${lifecycleClause}
                 and ${trustClause("edge_from.")}
                 and ${trustClause("edge_to.")}
                 and edge_from.refresh_status not in ('STALE_BLOCKED','INVALID')
                 and edge_to.refresh_status not in ('STALE_BLOCKED','INVALID')
                 and $7::text in ('outgoing','both')
                 and (
                   scope.path_prefix is null
                   or (
                     (
                       edge_from.path=scope.path_prefix
                       or starts_with(edge_from.path,scope.path_prefix || '/')
                     )
                     and (
                       edge_to.path=scope.path_prefix
                       or starts_with(edge_to.path,scope.path_prefix || '/')
                     )
                   )
                 )
              union all
              select distinct r.id,r.relation_type,
                     r.to_document_id current_document_id,
                     r.from_document_id next_document_id,
                     'incoming' direction,
                     r.weight::double precision weight,
                     edge_to.vault_id
                from knowledge_relations r
                join knowledge_documents edge_from
                  on edge_from.id=r.from_document_id
                 and edge_from.space_id=$1
                join knowledge_documents edge_to
                  on edge_to.id=r.to_document_id
                 and edge_to.space_id=$1
                 and edge_to.vault_id=edge_from.vault_id
                join graph_scopes scope on scope.vault_id=edge_to.vault_id
               where r.space_id=$1
                 and r.relation_type=any($4::text[])
                 and r.weight is not null
                 and r.weight >= 0
                 and r.weight <= 1000000
                 and edge_from.lifecycle ${lifecycleClause}
                 and edge_to.lifecycle ${lifecycleClause}
                 and ${trustClause("edge_from.")}
                 and ${trustClause("edge_to.")}
                 and edge_from.refresh_status not in ('STALE_BLOCKED','INVALID')
                 and edge_to.refresh_status not in ('STALE_BLOCKED','INVALID')
                 and $7::text in ('incoming','both')
                 and (
                   scope.path_prefix is null
                   or (
                     (
                       edge_from.path=scope.path_prefix
                       or starts_with(edge_from.path,scope.path_prefix || '/')
                     )
                     and (
                       edge_to.path=scope.path_prefix
                       or starts_with(edge_to.path,scope.path_prefix || '/')
                     )
                   )
                 )
            ),
            graph_paths(
              seed_document_id,seed_vault_id,current_document_id,hops,
              graph_score,visited_document_ids,path_document_ids,
              path_relation_types,path_directions
            ) as (
              select d.id,d.vault_id,d.id,0,1::double precision,
                     array[d.id]::uuid[],array[d.id]::uuid[],
                     array[]::text[],array[]::text[]
                from scoped_documents d
              union all
              select gp.seed_document_id,gp.seed_vault_id,next_doc.id,
                     gp.hops+1,
                     gp.graph_score
                       * coalesce(
                           ($5::jsonb ->> edge.relation_type)::double precision,
                           1::double precision
                         )
                       * edge.weight
                        * $6::double precision,
                     array_append(gp.visited_document_ids,next_doc.id),
                     array_append(gp.path_document_ids,next_doc.id),
                     array_append(gp.path_relation_types,edge.relation_type),
                     array_append(gp.path_directions,edge.direction)
                from graph_paths gp
                join lateral (
                  select candidate_edge.*
                   from oriented_edges candidate_edge
                   where candidate_edge.current_document_id=gp.current_document_id
                     and candidate_edge.vault_id=gp.seed_vault_id
                   order by candidate_edge.weight
                              * coalesce(
                                  ($5::jsonb ->> candidate_edge.relation_type)::double precision,
                                  1::double precision
                                ) desc,
                            candidate_edge.relation_type,candidate_edge.id
                   limit $11::integer
                ) edge on true
                join knowledge_documents next_doc
                  on next_doc.id=edge.next_document_id
                 and next_doc.space_id=$1
                 and next_doc.vault_id=gp.seed_vault_id
                 and next_doc.lifecycle ${lifecycleClause}
                 and ${trustClause("next_doc.")}
                 and next_doc.refresh_status not in ('STALE_BLOCKED','INVALID')
               where gp.hops < $3::integer
                 and not (next_doc.id=any(gp.visited_document_ids))
            ),
            unique_paths as (
              select distinct on (
                       gp.seed_document_id,gp.current_document_id,
                       gp.path_document_ids,gp.path_relation_types,
                       gp.path_directions
                     ) gp.*
                from graph_paths gp
               where gp.hops>0
               order by gp.seed_document_id,gp.current_document_id,
                        gp.path_document_ids,gp.path_relation_types,
                        gp.path_directions,gp.graph_score desc
            ),
            ranked_paths as (
              select path.*,
                     row_number() over (
                       partition by path.current_document_id
                       order by path.graph_score desc,path.hops,
                                path.seed_document_id,path.path_document_ids,
                                path.path_relation_types,path.path_directions
                     ) as path_rank
                from unique_paths path
            ),
            candidate_scores as (
              select current_document_id target_document_id,
                     sum(graph_score) graph_score
                from ranked_paths
               where path_rank <= $9::integer
               group by current_document_id
            ),
            ranked_candidates as (
              select target_document_id,
                     row_number() over (
                       order by graph_score desc,target_document_id
                     ) as candidate_rank
                from candidate_scores
            )
            select rp.seed_document_id,rp.seed_vault_id,
                   rp.current_document_id target_document_id,
                   rp.hops,rp.graph_score,rp.path_document_ids,
                   rp.path_relation_types,rp.path_directions
              from ranked_paths rp
              join ranked_candidates rc
                on rc.target_document_id=rp.current_document_id
             where rp.path_rank <= $9::integer
               and rc.candidate_rank <= $10::integer
             order by rc.candidate_rank,rp.path_rank
            `,
              [
                spaceId,
                candidateSeedIds,
                graphPolicy.maxHops,
                graphPolicy.allowedRelationTypes,
                JSON.stringify(graphPolicy.relationWeights),
                graphPolicy.decay,
                graphPolicy.directionPolicy,
                JSON.stringify(
                  graphScopes.map((scope) => ({
                    vault_id: scope.vaultId,
                    path_prefix: scope.pathPrefix,
                  })),
                ),
                graphPolicy.maxPathsPerCandidate,
                graphPolicy.maxCandidates,
                GRAPH_HARD_MAX_FANOUT,
              ],
            ),
          )
        ).rows;

  const graphNodeIds = [
    ...new Set(
      graphRows.flatMap((row) =>
        Array.isArray(row.path_document_ids)
          ? row.path_document_ids.map((id) => String(id))
          : [],
      ),
    ),
  ].filter((id) => UUID_PATTERN.test(id));
  const graphNodeDetails =
    graphNodeIds.length === 0
      ? { rows: [] as GraphDocumentRow[] }
      : await db.pool.query<GraphDocumentRow>(
          `
          select id,space_id,vault_id,external_id,path,current_revision,
                 lifecycle,refresh_status,trust_tier
            from knowledge_documents
           where id=any($1::uuid[])
             and space_id=$2
             and vault_id=any($3::uuid[])
          `,
          [graphNodeIds, spaceId, vaultIds],
        );
  const graphNodeById = new Map(
    graphNodeDetails.rows.map((row) => [String(row.id), row]),
  );
  const graphPathsByCandidate = new Map<string, GraphPathProvenance[]>();
  for (const row of graphRows) {
    const nodeIds = Array.isArray(row.path_document_ids)
      ? row.path_document_ids.map((id) => String(id))
      : [];
    const relations = Array.isArray(row.path_relation_types)
      ? row.path_relation_types.map((relation) => String(relation))
      : [];
    const directions = Array.isArray(row.path_directions)
      ? row.path_directions.map((direction) => String(direction))
      : [];
    if (
      !UUID_PATTERN.test(String(row.seed_document_id)) ||
      !UUID_PATTERN.test(String(row.seed_vault_id)) ||
      !UUID_PATTERN.test(String(row.target_document_id)) ||
      nodeIds.length < 2 ||
      nodeIds.length !== Number(row.hops) + 1 ||
      relations.length !== Number(row.hops) ||
      directions.length !== Number(row.hops) ||
      new Set(nodeIds).size !== nodeIds.length ||
      nodeIds[0] !== String(row.seed_document_id) ||
      nodeIds.at(-1) !== String(row.target_document_id)
    ) {
      continue;
    }
    const scope = graphScopes.find(
      (candidate) => candidate.vaultId === String(row.seed_vault_id),
    );
    if (!scope) continue;
    const nodes = nodeIds.map((id) => graphNodeById.get(id));
    if (
      nodes.some(
        (node) =>
          !node ||
          String(node.space_id) !== spaceId ||
          String(node.vault_id) !== String(row.seed_vault_id) ||
          !allowedLifecycles.has(String(node.lifecycle)) ||
          ["STALE_BLOCKED", "INVALID"].includes(String(node.refresh_status)) ||
          (TRUST_RANK[String(node.trust_tier)] ?? -1) < minimumTrust ||
          !pathMatchesVaultPrefix(String(node.path), scope.pathPrefix) ||
          (options.pathAuthorizer !== undefined &&
            !options.pathAuthorizer(String(node.path), String(node.vault_id))),
      )
    ) {
      continue;
    }
    if (
      relations.some(
        (relation) =>
          !ALL_GRAPH_RELATION_TYPES.includes(relation as GraphRelationType) ||
          !graphPolicy.allowedRelationTypes.includes(
            relation as GraphRelationType,
          ),
      ) ||
      directions.some(
        (direction) => direction !== "outgoing" && direction !== "incoming",
      ) ||
      (graphPolicy.directionPolicy === "outgoing" &&
        directions.some((direction) => direction !== "outgoing")) ||
      (graphPolicy.directionPolicy === "incoming" &&
        directions.some((direction) => direction !== "incoming"))
    ) {
      continue;
    }
    const graphScore = Number(row.graph_score);
    if (!Number.isFinite(graphScore) || graphScore < 0) continue;
    const path: GraphPathNode[] = nodes.map((node, index) => {
      const document = String(node?.external_id ?? "").trim();
      const graphNode: GraphPathNode = {
        documentId: String(node?.id),
        document: document || String(node?.id),
      };
      if (index < relations.length) {
        graphNode.relation = relations[index] as GraphRelationType;
        graphNode.direction = directions[index] as "outgoing" | "incoming";
      }
      return graphNode;
    });
    const provenance: GraphPathProvenance = {
      channel: "graph",
      seedDocumentId: String(row.seed_document_id),
      targetDocumentId: String(row.target_document_id),
      path,
      hops: Number(row.hops),
      graphScore,
    };
    const candidatePaths =
      graphPathsByCandidate.get(provenance.targetDocumentId) ?? [];
    candidatePaths.push(provenance);
    graphPathsByCandidate.set(provenance.targetDocumentId, candidatePaths);
  }
  const graphCandidates: GraphCandidateRow[] = [...graphPathsByCandidate]
    .map(([id, paths]) => {
      const provenance = paths
        .sort(
          (left, right) =>
            right.graphScore - left.graphScore ||
            left.hops - right.hops ||
            left.seedDocumentId.localeCompare(right.seedDocumentId) ||
            JSON.stringify(left.path).localeCompare(JSON.stringify(right.path)),
        )
        .slice(0, graphPolicy.maxPathsPerCandidate);
      return {
        id,
        weight: provenance.reduce((sum, path) => sum + path.graphScore, 0),
        candidateRevision: String(
          graphNodeById.get(id)?.current_revision ?? "",
        ),
        provenance,
      };
    })
    .filter(
      (candidate) =>
        candidate.provenance.length > 0 &&
        candidate.candidateRevision.length > 0 &&
        Number.isFinite(candidate.weight) &&
        candidate.weight > 0,
    )
    .sort(
      (left, right) =>
        right.weight - left.weight || left.id.localeCompare(right.id),
    )
    .slice(0, graphPolicy.maxCandidates);
  const graphProvenanceByCandidate = new Map(
    graphCandidates.map((candidate) => [candidate.id, candidate.provenance]),
  );
  const graph = { rows: graphCandidates };
  recordRetrievalCandidates("graph", graph.rows.length);
  if (
    channels.has("graph") &&
    candidateSeedIds.length > 0 &&
    graphPolicy.maxHops > 0 &&
    graphScopes.length > 0
  ) {
    options.availableChannelSink?.add("graph");
  }

  const pprCandidates: RetrievalCandidate[] = [];
  if (
    retrievalPolicy.graphMode === "ASSOCIATIVE" &&
    retrievalPolicy.channels.GRAPH_PPR.enabled &&
    graphProvenanceByCandidate.size > 0
  ) {
    const graphRevision = String(index.graph_revision ?? "").trim();
    if (!graphRevision) {
      options.warningSink?.push("PPR_UNAVAILABLE:GRAPH_REVISION_MISSING");
    } else {
      try {
        const pprNodeById = new Map<
          string,
          { id: string; scopeId: string; graphDomain: string }
        >();
        const pprEdges: Array<{
          fromNodeId: string;
          toNodeId: string;
          scopeId: string;
          relation: string;
          weight: number;
        }> = [];
        for (const paths of graphProvenanceByCandidate.values()) {
          for (const provenance of paths) {
            for (let index = 0; index < provenance.path.length; index += 1) {
              const current = provenance.path[index];
              if (!current) continue;
              const currentDocument = graphNodeById.get(current.documentId);
              if (!currentDocument) continue;
              const scopeId = String(currentDocument.vault_id);
              pprNodeById.set(current.documentId, {
                id: current.documentId,
                scopeId,
                graphDomain: "EPISTEMIC",
              });
              const next = provenance.path[index + 1];
              if (!next || !current.relation) continue;
              const nextDocument = graphNodeById.get(next.documentId);
              if (!nextDocument || String(nextDocument.vault_id) !== scopeId) {
                continue;
              }
              const configuredWeight =
                graphPolicy.relationWeights[current.relation] ?? 1;
              if (
                typeof configuredWeight !== "number" ||
                !Number.isFinite(configuredWeight) ||
                configuredWeight <= 0
              ) {
                continue;
              }
              pprEdges.push({
                fromNodeId: current.documentId,
                toNodeId: next.documentId,
                scopeId,
                relation: current.relation,
                weight: configuredWeight,
              });
            }
          }
        }

        const pprSeedWeights = new Map<string, number>();
        const addPprSeeds = (
          rows: readonly { id: unknown }[],
          channelWeight: number | undefined,
        ): void => {
          if (
            typeof channelWeight !== "number" ||
            !Number.isFinite(channelWeight) ||
            channelWeight <= 0
          ) {
            return;
          }
          rows.forEach((row, rankIndex) => {
            const nodeId = String(row.id);
            if (!pprNodeById.has(nodeId)) return;
            const weight = channelWeight / (60 + rankIndex + 1);
            pprSeedWeights.set(
              nodeId,
              (pprSeedWeights.get(nodeId) ?? 0) + weight,
            );
          });
        };
        addPprSeeds(exact.rows, retrievalPolicy.channels.EXACT.weight);
        addPprSeeds(lexical.rows, retrievalPolicy.channels.LEXICAL.weight);
        addPprSeeds(vector.rows, retrievalPolicy.channels.VECTOR.weight);

        if (pprSeedWeights.size > 0) {
          const pprPolicy = resolvePersonalizedPageRankPolicy({
            ...options.pprPolicy,
            allowedGraphDomains: options.pprPolicy?.allowedGraphDomains ?? [
              "EPISTEMIC",
            ],
            allowedRelations:
              options.pprPolicy?.allowedRelations ??
              graphPolicy.allowedRelationTypes,
          });
          const pprResult = personalizedPageRank({
            nodes: [...pprNodeById.values()],
            edges: pprEdges,
            seeds: [...pprSeedWeights].map(([nodeId, weight]) => ({
              nodeId,
              weight,
            })),
            policy: pprPolicy,
          });
          if (!pprResult.converged) {
            options.warningSink?.push("PPR_MAX_ITERATIONS_REACHED");
          }
          const seedIds = new Set(pprSeedWeights.keys());
          const supported = pprResult.candidates.filter(
            (candidate) =>
              !seedIds.has(candidate.nodeId) &&
              graphProvenanceByCandidate.has(candidate.nodeId),
          );
          pprCandidates.push(
            ...supported.map((candidate, rankIndex) => ({
              candidateId: candidate.nodeId,
              channel: "GRAPH_PPR" as const,
              rank: rankIndex + 1,
              rawScore: candidate.score,
              scopeId: spaceId,
              documentId: candidate.nodeId,
              revision: graphRevision,
              selectionReason: "graph-ppr:associative",
            })),
          );
        }
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "PPR_EXECUTION_FAILED";
        options.warningSink?.push(`PPR_UNAVAILABLE:${code}`);
      }
    }
  }

  const retrievalCandidates: RetrievalCandidate[] = [
    ...exact.rows.map((row, index) => ({
      candidateId: String(row.id),
      channel: "EXACT" as const,
      rank: index + 1,
      scopeId: spaceId,
      documentId: String(row.id),
      revision: String(row.document_revision),
      selectionReason: row.match_reason ? String(row.match_reason) : "exact",
    })),
    ...(channels.has("lexical")
      ? lexical.rows.map((row, index) => ({
          candidateId: String(row.id),
          channel: "LEXICAL" as const,
          rank: index + 1,
          rawScore: Number(row.score),
          scopeId: spaceId,
          documentId: String(row.id),
          ...(row.unit_id ? { unitId: String(row.unit_id) } : {}),
          revision: String(row.document_revision),
          selectionReason: row.match_reason
            ? String(row.match_reason)
            : "lexical",
        }))
      : []),
    ...vector.rows.map((row, index) => ({
      candidateId: String(row.id),
      channel: "VECTOR" as const,
      rank: index + 1,
      rawScore: Number(row.score),
      scopeId: spaceId,
      documentId: String(row.id),
      ...(row.unit_id ? { unitId: String(row.unit_id) } : {}),
      revision: String(row.document_revision),
      selectionReason: row.query_variant_kind
        ? `vector:transformed:${row.query_variant_kind}`
        : "vector",
    })),
    ...communityCandidates.map((row, index) => ({
      candidateId: String(row.id),
      channel: "COMMUNITY" as const,
      rank: index + 1,
      rawScore: Number(row.orientation_score),
      scopeId: spaceId,
      documentId: String(row.id),
      revision: String(row.document_revision),
      supportSetId: `${row.community_revision}:${row.community_key}`,
      selectionReason:
        retrievalPolicy.graphMode === "DRIFT"
          ? "community:drift-routing"
          : "community:global-routing",
    })),
    ...contextPack.rows.map((row, index) => ({
      candidateId: String(row.id),
      channel: "CONTEXT_PACK" as const,
      rank: index + 1,
      scopeId: spaceId,
      documentId: String(row.id),
      revision: String(row.document_revision),
      selectionReason: "context-pack:lexical-match",
    })),
    ...rawFallback.rows.map((row, index) => ({
      candidateId: String(row.id),
      channel: "RAW" as const,
      rank: index + 1,
      scopeId: spaceId,
      documentId: String(row.id),
      revision: String(row.document_revision),
      selectionReason: "raw:source-match",
    })),
    ...codeFallback.rows.map((row, index) => ({
      candidateId: String(row.id),
      channel: "CODE" as const,
      rank: index + 1,
      scopeId: spaceId,
      documentId: String(row.id),
      revision: String(row.document_revision),
      selectionReason: row.match_reason ?? "code:project-match",
    })),
    ...graph.rows.map((row, index) => ({
      candidateId: String(row.id),
      channel: "GRAPH_TYPED" as const,
      rank: index + 1,
      rawScore: Number(row.weight),
      scopeId: spaceId,
      documentId: String(row.id),
      revision: row.candidateRevision,
      selectionReason: "graph:bounded-path",
    })),
    ...pprCandidates,
  ];
  const rankedChannels = retrievalCandidatesToRankedChannels(
    retrievalCandidates,
    retrievalPolicy,
  );
  const fused = (
    await withSpan("retrieve.fuse", {}, async () =>
      reciprocalRankFusion(rankedChannels),
    )
  ).slice(0, input.limit * 2);
  if (fused.length === 0) {
    await finalizeTruthSnapshot();
    return [];
  }

  const details = await db.pool.query(
    `
    select d.id, d.space_id, d.vault_id, d.external_id, d.current_revision, d.path, d.title, d.type, d.layer,
           d.trust_tier, d.lifecycle, d.body_cache,
           d.refresh_status,
           coalesce(
             jsonb_agg(distinct jsonb_build_object(
               'id',cited.id,'spaceId',cited.space_id,'vaultId',cited.vault_id,
               'path',cited.path,'revision',cited.current_revision
             ))
               filter (where cited.id is not null),
             '[]'::jsonb
           ) citations,
           coalesce(jsonb_agg(distinct e.locator) filter (where e.id is not null),'[]'::jsonb)
             evidence_locators
      from knowledge_documents d
      left join knowledge_relations r
        on r.from_document_id = d.id
       and r.space_id = d.space_id
       and r.relation_type in ('supports', 'derives_from', 'related_to')
      left join knowledge_documents cited
        on cited.id = r.to_document_id
       and (cited.layer in ('source', 'resource', 'evidence') or cited.type like '%evidence%')
       and cited.space_id = d.space_id
       and cited.vault_id is not distinct from d.vault_id
       and cited.lifecycle in ('ACTIVE','DISPUTED')
       and cited.refresh_status not in ('STALE_BLOCKED','INVALID')
      left join document_evidence de on de.document_id=d.id
      left join evidence e on e.id=de.evidence_id
       and e.space_id = d.space_id
       and e.vault_id is not distinct from d.vault_id
     where d.id = any($1::uuid[])
       and d.space_id = $2
       ${vaultFilter("d.")}
       and ${trustClause("d.")}
     group by d.id
    `,
    [fused.map((item) => item.id), spaceId],
  );
  const byId = new Map(details.rows.map((row) => [String(row.id), row]));
  const bestUnitByDocument = new Map<
    string,
    { unitId: string; unitType: string }
  >();
  for (const row of [...lexical.rows, ...vector.rows]) {
    const documentId = String(row.id);
    if (!bestUnitByDocument.has(documentId) && row.unit_id) {
      bestUnitByDocument.set(documentId, {
        unitId: String(row.unit_id),
        unitType: String(row.unit_type),
      });
    }
  }
  const selectedUnits =
    bestUnitByDocument.size === 0
      ? { rows: [] }
      : await db.pool.query(
          `
          select u.id, u.document_id, u.unit_type, u.heading_path, u.body,
                 u.parent_unit_id,
                 p.unit_type parent_unit_type, p.body parent_body
            from knowledge_units u
            left join knowledge_units p
              on p.id=u.parent_unit_id
             and p.document_id=u.document_id
             and p.space_id=u.space_id
             and p.vault_id=u.vault_id
           where u.id=any($1::uuid[])
             and u.space_id=$2
             and u.vault_id=any($3::uuid[])
          `,
          [
            [...bestUnitByDocument.values()].map((unit) => unit.unitId),
            spaceId,
            vaultIds,
          ],
        );
  const structuralContextByUnit = new Map(
    selectedUnits.rows.map((row) => [
      String(row.id),
      {
        body: String(row.body),
        headingPath: Array.isArray(row.heading_path)
          ? row.heading_path.map(String)
          : [],
        ...(row.parent_unit_id
          ? { parentUnitId: String(row.parent_unit_id) }
          : {}),
        ...(row.parent_unit_type
          ? { parentUnitType: String(row.parent_unit_type) }
          : {}),
        context: rehydrateStructuralContext({
          body: String(row.body),
          unitType: String(row.unit_type),
          parentBody: row.parent_body ? String(row.parent_body) : null,
          parentUnitType: row.parent_unit_type
            ? String(row.parent_unit_type)
            : null,
        }),
      },
    ]),
  );
  const results = fused
    .map((item): SearchHit | null => {
      const row = byId.get(item.id);
      if (
        !row ||
        (TRUST_RANK[String(row.trust_tier)] ?? 0) < minimumTrust ||
        (options.pathAuthorizer &&
          !options.pathAuthorizer(String(row.path), String(row.vault_id)))
      )
        return null;
      const documentCitations = ["source", "resource"].includes(
        String(row.layer),
      )
        ? [`${row.path}@${row.current_revision}`]
        : ((row.citations ?? []) as Array<Record<string, unknown>>)
            .filter(
              (citation) =>
                String(citation.spaceId ?? citation.space_id ?? "") ===
                  String(row.space_id) &&
                String(citation.vaultId ?? citation.vault_id ?? "") ===
                  String(row.vault_id) &&
                (!options.pathAuthorizer ||
                  options.pathAuthorizer(
                    String(citation.path ?? ""),
                    String(
                      citation.vaultId ?? citation.vault_id ?? row.vault_id,
                    ),
                  )),
            )
            .map(
              (citation) =>
                `${String(citation.path)}@${String(citation.revision ?? row.current_revision)}`,
            );
      const rowPathAuthorizer = options.pathAuthorizer
        ? (value: string) =>
            options.pathAuthorizer!(value, String(row.vault_id))
        : undefined;
      const citations = [
        ...new Set([
          ...documentCitations,
          ...((row.evidence_locators ?? []) as Array<Record<string, unknown>>)
            .filter((locator) =>
              evidenceLocatorAllowed(locator, rowPathAuthorizer),
            )
            .map(
              (locator) =>
                `evidence:${JSON.stringify(sanitizeEvidenceLocator(locator))}`,
            ),
          ...(codeCitationsByCandidate.get(item.id) ?? []),
        ]),
      ];
      const matchedUnit = bestUnitByDocument.get(item.id);
      const structuralContext = matchedUnit
        ? structuralContextByUnit.get(matchedUnit.unitId)
        : undefined;
      return {
        documentId: String(row.id),
        vaultId: String(row.vault_id),
        ...matchedUnit,
        ...(structuralContext?.parentUnitId
          ? { parentUnitId: structuralContext.parentUnitId }
          : {}),
        ...(structuralContext?.parentUnitType
          ? { parentUnitType: structuralContext.parentUnitType }
          : {}),
        ...(structuralContext?.headingPath
          ? { headingPath: structuralContext.headingPath }
          : {}),
        ...(structuralContext?.context
          ? { parentContext: structuralContext.context }
          : {}),
        document: {
          externalId: row.external_id ? String(row.external_id) : null,
          path: String(row.path),
          title: String(row.title),
        },
        revision: String(row.current_revision),
        title: String(row.title),
        type: String(row.type),
        trust: String(row.trust_tier) as SearchHit["trust"],
        lifecycle: String(row.lifecycle) as SearchHit["lifecycle"],
        refreshStatus: String(row.refresh_status),
        score: item.score,
        reasons: item.reasons,
        fusionContributions: item.contributions,
        ...(graphProvenanceByCandidate.has(item.id)
          ? { graphProvenance: graphProvenanceByCandidate.get(item.id) }
          : {}),
        excerpt: (structuralContext?.body ?? String(row.body_cache)).slice(
          0,
          1200,
        ),
        citations,
        warnings: [
          "UNTRUSTED_RETRIEVED_CONTENT",
          ...(String(row.refresh_status ?? "CURRENT") === "STALE_PENDING_REVIEW"
            ? ["STALE_PENDING_REVIEW"]
            : []),
        ],
      };
    })
    .filter((hit): hit is SearchHit => hit !== null);
  const reranker = resolveSearchHitReranker(
    retrievalPolicy.reranker ??
      (options.deterministicRerank
        ? DETERMINISTIC_LEXICAL_RERANKER
        : undefined),
  );
  const finalResults = (
    reranker ? rerankSearchHits(input.query, results, reranker) : results
  ).slice(0, input.limit);
  await finalizeTruthSnapshot();
  return finalResults;
}

export function registerSearchRoutes(
  app: FastifyInstance,
  db: Postgres,
  dependencies: SearchRouteDependencies = {},
): void {
  app.post(
    "/v1/search",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("knowledge:read"),
      ],
    },
    async (request, reply) => {
      const parsed = SearchRequest.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_SEARCH_REQUEST",
          issues: parsed.error.issues,
        });
      }
      const actor = actorOf(request);
      const requestedSpace = parsed.data.spaceId;
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (!hasSpaceAccess(actor, requestedSpace, "knowledge:read")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const principalVaultId =
        actor.principalKind === "AGENT_PROCESS" ? actor.principalVaultId : null;
      const explicitlyRequestedVaults = [
        ...(parsed.data.vaultId ? [parsed.data.vaultId] : []),
        ...parsed.data.vaultIds,
      ];
      if (
        principalVaultId &&
        (parsed.data.federated ||
          explicitlyRequestedVaults.some(
            (vaultId) => vaultId !== principalVaultId,
          ))
      ) {
        return reply.code(403).send({ code: "PRINCIPAL_VAULT_SCOPE_DENIED" });
      }
      let vaultIds: string[];
      let accessByVault: AuthorizedVaultScope["accessByVault"] = {};
      try {
        const scope = await new PostgresAuthorizationPort(db).resolveVaultScope(
          {
            userId: actor.id,
            spaceId: requestedSpace,
            permission: "knowledge:read",
            ...(principalVaultId
              ? { vaultId: principalVaultId }
              : parsed.data.vaultId
                ? { vaultId: parsed.data.vaultId }
                : {}),
            vaultIds: principalVaultId
              ? [principalVaultId]
              : parsed.data.vaultIds,
            federated: principalVaultId ? false : parsed.data.federated,
          },
        );
        vaultIds = scope.vaultIds;
        accessByVault = scope.accessByVault;
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "INVALID_VAULT_SCOPE";
        return reply
          .code(
            code === "VAULT_SCOPE_NOT_FOUND"
              ? 404
              : code === "VAULT_ACCESS_DENIED"
                ? 403
                : 400,
          )
          .send({ code });
      }
      const scopedRequest: SearchInput = {
        ...parsed.data,
        vaultIds,
        ...(vaultIds.length === 1 ? { vaultId: vaultIds[0] } : {}),
      };
      const actorPathPrefixes = pathPrefixesForPermission(
        actor,
        requestedSpace,
        "knowledge:read",
      );
      const graphScopes = Object.entries(accessByVault).flatMap(
        ([vaultId, access]) =>
          actorPathPrefixes.flatMap((actorPathPrefix) => {
            const pathPrefix = intersectVaultPathPrefixes(
              actorPathPrefix,
              access.pathPrefix,
            );
            return pathPrefix === undefined ? [] : [{ vaultId, pathPrefix }];
          }),
      );
      const pathAuthorizer = (documentPath: string, vaultId?: string) => {
        const access = accessByVault[String(vaultId ?? "")];
        if (!access) return false;
        return (
          pathMatchesVaultPrefix(documentPath, access.pathPrefix) &&
          hasPathAccess(actor, requestedSpace, "knowledge:read", documentPath)
        );
      };
      let projectCode;
      try {
        projectCode = await resolveProjectCodeRetrieval(db, {
          spaceId: requestedSpace,
          vaultIds,
          ...(parsed.data.projectId
            ? { projectId: parsed.data.projectId }
            : {}),
          query: parsed.data.query,
          graphScopes,
          pathAuthorizer,
        });
      } catch (error) {
        const code =
          error instanceof Error
            ? error.message
            : "PROJECT_CODE_NOT_FOUND_OR_UNAUTHORIZED";
        return reply.code(404).send({ code });
      }
      const indexRows = await db.pool.query(
        `select vault_id,corpus_revision,lexical_revision,vector_revision,
                graph_revision,context_pack_revision,status,warnings,
                retrieval_configuration_version
           from vault_index_revisions
          where space_id=$1 and vault_id=any($2::uuid[])
          order by vault_id`,
        [requestedSpace, vaultIds],
      );
      const index = combineVaultIndexRows(indexRows.rows);
      const capabilities = plannerCapabilitiesForIndex(index, {
        vectorProviderAvailable: await activeVectorProviderAvailable(
          db,
          requestedSpace,
          vaultIds,
        ),
        communityAvailable: await activeCommunityIndexAvailable(
          db,
          requestedSpace,
          indexRows.rows,
        ),
        rawAllowed:
          parsed.data.mode !== "COMPILED_ONLY" &&
          hasSpaceAccess(actor, requestedSpace, "source:read"),
        // No project code adapter is registered in the current runtime.
        codeAdapterAvailable: projectCode?.available ?? false,
      });
      const plan = planQuery(
        parsed.data.query,
        parsed.data.intent,
        capabilities,
      );
      const retrievalWarnings: string[] = [
        ...plan.omittedChannels.map(
          (channel) => `PLAN_CHANNEL_OMITTED:${channel}`,
        ),
        ...(projectCode?.warnings ?? []),
      ];
      const availableChannels = new Set<RetrievalChannel>();
      let truthState: RetrievalTruthState | undefined;
      let hits: SearchHit[];
      try {
        hits = await queryKnowledge(db, scopedRequest, {
          plan,
          vaultIds,
          graphScopes,
          ...(projectCode ? { codeCandidates: projectCode.candidates } : {}),
          warningSink: retrievalWarnings,
          availableChannelSink: availableChannels,
          pathAuthorizer,
          truthConsistency: parsed.data.truthConsistency ?? "STRICT",
          truthStateSink: (state) => {
            truthState = state;
          },
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "CONTEXT_REVISION_CHANGED"
        ) {
          return reply.code(409).send({ code: "CONTEXT_REVISION_CHANGED" });
        }
        throw error;
      }
      const channelState = channelsConsistentWithIndex(
        plan.channels,
        index,
        capabilities.vectorAvailable,
      );
      const effectiveChannelState = effectiveRetrievalChannels(
        channelState,
        retrievalWarnings,
        availableChannels,
      );
      telemetry.counter("retrieval_requests", 1, { intent: plan.intent });
      telemetry.gauge(
        "index_revision_mismatch",
        String(index.status ?? "DEGRADED") === "CONSISTENT" ? 0 : 1,
        { projection: "aggregate" },
      );
      return {
        mode: parsed.data.mode,
        scope: {
          spaceId: requestedSpace,
          vaultIds,
          federated: parsed.data.federated,
        },
        intent: plan.intent,
        plan,
        degraded:
          String(index.status ?? "DEGRADED") !== "CONSISTENT" ||
          effectiveChannelState.warnings.length > 0,
        channels: effectiveChannelState.channels,
        warnings: effectiveChannelState.warnings,
        indexRevisions: index,
        truth: truthState ?? null,
        hits,
        noAnswer:
          hits.length === 0
            ? {
                status: "INSUFFICIENT_KNOWLEDGE",
                reason: "NO_SUPPORTED_MATCH",
                searchedChannels: effectiveChannelState.channels,
                gaps: ["No supported source-backed match was retrieved."],
                conflicts: [],
                recommendedActions: [
                  "Broaden the query or lower the minimum trust explicitly.",
                ],
                guidance:
                  "Broaden the query or lower the minimum trust explicitly.",
              }
            : null,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/v1/generated-context-packets/:id",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      if (!UUID_PATTERN.test(request.params.id)) {
        return reply
          .code(404)
          .send({ code: "GENERATED_CONTEXT_PACKET_NOT_FOUND" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const result = await db.pool.query<StoredContextPacketRow>(
        `
        select id,space_id,corpus_revision,packet_hash,request,packet
          from context_packets
         where id=$1 and (expires_at is null or expires_at > now())
         limit 1
        `,
        [request.params.id],
      );
      const row = result.rows[0];
      if (!row) {
        return reply
          .code(404)
          .send({ code: "GENERATED_CONTEXT_PACKET_NOT_FOUND" });
      }
      const parsedPacket = ContextPacketSchema.safeParse(row.packet);
      if (!parsedPacket.success) {
        return reply
          .code(404)
          .send({ code: "GENERATED_CONTEXT_PACKET_NOT_FOUND" });
      }
      const readable = await readableContextSnapshot(
        db,
        actor,
        row,
        parsedPacket.data.sections,
      );
      if (!readable) {
        return reply
          .code(404)
          .send({ code: "GENERATED_CONTEXT_PACKET_NOT_FOUND" });
      }
      return readable.packet;
    },
  );

  app.get<{ Params: { id: string; handle: string } }>(
    "/v1/generated-context-packets/:id/continuations/:handle",
    { preHandler: requirePermission("knowledge:read") },
    async (request, reply) => {
      if (
        !UUID_PATTERN.test(request.params.id) ||
        !/^[a-f0-9]{64}$/.test(request.params.handle)
      ) {
        return reply.code(404).send({ code: "CONTEXT_CONTINUATION_NOT_FOUND" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const result = await db.pool.query<StoredContextContinuationRow>(
        `
        select p.id,p.space_id,p.corpus_revision,p.packet_hash,p.request,p.packet,
               c.handle,c.reason,c.remaining_tokens,c.sections
          from context_packets p
          join context_packet_continuations c on c.packet_id=p.id
         where p.id=$1 and c.handle=$2
           and (p.expires_at is null or p.expires_at > now())
         limit 1
        `,
        [request.params.id, request.params.handle],
      );
      const row = result.rows[0];
      const sectionsResult = ContextPacketSchema.shape.sections.safeParse(
        row?.sections,
      );
      if (!row || !sectionsResult.success || sectionsResult.data.length === 0) {
        return reply.code(404).send({ code: "CONTEXT_CONTINUATION_NOT_FOUND" });
      }
      const readable = await readableContextSnapshot(
        db,
        actor,
        row,
        sectionsResult.data,
      );
      if (!readable) {
        return reply.code(404).send({ code: "CONTEXT_CONTINUATION_NOT_FOUND" });
      }
      const response = ContextContinuationResponse.safeParse({
        packetId: readable.packet.packetId,
        packetHash: readable.packet.packetHash,
        corpusRevision: readable.packet.corpusRevision,
        scope: readable.packet.scope,
        continuation: {
          handle: row.handle,
          reason: row.reason,
          remainingTokens: Number(row.remaining_tokens),
        },
        sections: sectionsResult.data,
      });
      if (!response.success) {
        return reply.code(404).send({ code: "CONTEXT_CONTINUATION_NOT_FOUND" });
      }
      return response.data;
    },
  );

  app.post(
    "/v1/context",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("knowledge:read"),
      ],
    },
    async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const parsed = ContextRequest.safeParse(body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_CONTEXT_REQUEST",
          issues: parsed.error.issues,
        });
      }
      const packetMode = parsed.data.packetMode;
      const requestedSpace = parsed.data.spaceId;
      if (!hasSpaceAccess(actorOf(request), requestedSpace, "knowledge:read")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const principalVaultId =
        actor.principalKind === "AGENT_PROCESS" ? actor.principalVaultId : null;
      const explicitlyRequestedVaults = [
        ...(parsed.data.vaultId ? [parsed.data.vaultId] : []),
        ...parsed.data.vaultIds,
      ];
      if (
        principalVaultId &&
        (parsed.data.federated ||
          explicitlyRequestedVaults.some(
            (vaultId) => vaultId !== principalVaultId,
          ))
      ) {
        return reply.code(403).send({ code: "PRINCIPAL_VAULT_SCOPE_DENIED" });
      }
      let vaultIds: string[];
      let accessByVault: AuthorizedVaultScope["accessByVault"] = {};
      try {
        const scope = await new PostgresAuthorizationPort(db).resolveVaultScope(
          {
            userId: actor.id,
            spaceId: requestedSpace,
            permission: "knowledge:read",
            ...(principalVaultId
              ? { vaultId: principalVaultId }
              : parsed.data.vaultId
                ? { vaultId: parsed.data.vaultId }
                : {}),
            vaultIds: principalVaultId
              ? [principalVaultId]
              : parsed.data.vaultIds,
            federated: principalVaultId ? false : parsed.data.federated,
          },
        );
        vaultIds = scope.vaultIds;
        accessByVault = scope.accessByVault;
      } catch (error) {
        const code =
          error instanceof Error ? error.message : "INVALID_VAULT_SCOPE";
        return reply
          .code(
            code === "VAULT_SCOPE_NOT_FOUND"
              ? 404
              : code === "VAULT_ACCESS_DENIED"
                ? 403
                : 400,
          )
          .send({ code });
      }
      const {
        packetMode: _packetMode,
        contextLevel: requestedContextLevel,
        maxTokens: requestedMaxTokens,
        ...contextSearchRequest
      } = parsed.data;
      const scopedRequest: SearchInput = {
        ...contextSearchRequest,
        vaultIds,
        ...(vaultIds.length === 1 ? { vaultId: vaultIds[0] } : {}),
      };
      const actorPathPrefixes = pathPrefixesForPermission(
        actor,
        requestedSpace,
        "knowledge:read",
      );
      const graphScopes = Object.entries(accessByVault).flatMap(
        ([vaultId, access]) =>
          actorPathPrefixes.flatMap((actorPathPrefix) => {
            const pathPrefix = intersectVaultPathPrefixes(
              actorPathPrefix,
              access.pathPrefix,
            );
            return pathPrefix === undefined ? [] : [{ vaultId, pathPrefix }];
          }),
      );
      const pathAuthorizer = (documentPath: string, vaultId?: string) => {
        const access = accessByVault[String(vaultId ?? "")];
        if (!access) return false;
        return (
          pathMatchesVaultPrefix(documentPath, access.pathPrefix) &&
          hasPathAccess(actor, requestedSpace, "knowledge:read", documentPath)
        );
      };
      let projectCode;
      try {
        projectCode = await resolveProjectCodeRetrieval(db, {
          spaceId: requestedSpace,
          vaultIds,
          ...(parsed.data.projectId
            ? { projectId: parsed.data.projectId }
            : {}),
          query: parsed.data.query,
          graphScopes,
          pathAuthorizer,
        });
      } catch (error) {
        const code =
          error instanceof Error
            ? error.message
            : "PROJECT_CODE_NOT_FOUND_OR_UNAUTHORIZED";
        return reply.code(404).send({ code });
      }
      const indexRows = await db.pool.query(
        `
        select vault_id,corpus_revision,lexical_revision,vector_revision,
               graph_revision,context_pack_revision,status,warnings,
               retrieval_configuration_version
          from vault_index_revisions
         where space_id=$1 and vault_id=any($2::uuid[])
         order by vault_id
        `,
        [requestedSpace, vaultIds],
      );
      const indexRow = combineVaultIndexRows(indexRows.rows);
      const capabilities = plannerCapabilitiesForIndex(indexRow, {
        vectorProviderAvailable: await activeVectorProviderAvailable(
          db,
          requestedSpace,
          vaultIds,
        ),
        communityAvailable: await activeCommunityIndexAvailable(
          db,
          requestedSpace,
          indexRows.rows,
        ),
        rawAllowed:
          parsed.data.mode !== "COMPILED_ONLY" &&
          hasSpaceAccess(actor, requestedSpace, "source:read"),
        codeAdapterAvailable: projectCode?.available ?? false,
      });
      const plan = planQuery(
        parsed.data.query,
        parsed.data.intent,
        capabilities,
      );
      const intent = plan.intent;
      const maxTokens = contextBudgetForIntent(intent, requestedMaxTokens);
      const retrievalWarnings: string[] = [
        ...plan.omittedChannels.map(
          (channel) => `PLAN_CHANNEL_OMITTED:${channel}`,
        ),
        ...(projectCode?.warnings ?? []),
      ];
      const availableChannels = new Set<RetrievalChannel>();
      let truthState: RetrievalTruthState | undefined;
      let hits: SearchHit[];
      try {
        hits = await queryKnowledge(db, scopedRequest, {
          plan,
          vaultIds,
          graphScopes,
          ...(projectCode ? { codeCandidates: projectCode.candidates } : {}),
          warningSink: retrievalWarnings,
          availableChannelSink: availableChannels,
          pathAuthorizer,
          truthConsistency: parsed.data.truthConsistency ?? "STRICT",
          truthStateSink: (state) => {
            truthState = state;
          },
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "CONTEXT_REVISION_CHANGED"
        ) {
          return reply.code(409).send({ code: "CONTEXT_REVISION_CHANGED" });
        }
        throw error;
      }
      type MaterialConflictRow = {
        id: string;
        topic: string;
        status: string;
        resolution: string | null;
        members: string[];
      };
      const conflicts =
        hits.length === 0
          ? { rows: [] as MaterialConflictRow[] }
          : await db.pool.query<MaterialConflictRow>(
              `
              select c.id,c.topic,c.status,c.resolution,
                     array_agg(distinct all_members.document_id)::uuid[] members
                from contradiction_clusters c
                join contradiction_members matched
                  on matched.cluster_id=c.id
                join contradiction_members all_members
                  on all_members.cluster_id=c.id
               where matched.document_id=any($1::uuid[])
                 and c.space_id=$2
                 and c.vault_id=any($3::uuid[])
                 and c.status <> 'RESOLVED'
               group by c.id,c.topic,c.status,c.resolution
               order by c.id
              `,
              [hits.map((hit) => hit.documentId), requestedSpace, vaultIds],
            );
      const hitIds = new Set(hits.map((hit) => hit.documentId));
      const missingConflictMemberIds = [
        ...new Set(
          conflicts.rows.flatMap((conflict) =>
            (conflict.members ?? []).filter(
              (documentId) => !hitIds.has(documentId),
            ),
          ),
        ),
      ];
      const counterpartRows =
        missingConflictMemberIds.length === 0
          ? { rows: [] as Array<Record<string, unknown>> }
          : await db.pool.query(
              `
              select d.id,d.space_id,d.vault_id,d.external_id,d.current_revision,
                     d.path,d.title,d.type,d.layer,d.trust_tier,d.lifecycle,
                     d.body_cache,d.refresh_status,
                     coalesce(
                       jsonb_agg(distinct jsonb_build_object(
                         'id',cited.id,'spaceId',cited.space_id,
                         'vaultId',cited.vault_id,'path',cited.path,
                         'revision',cited.current_revision
                       )) filter (where cited.id is not null),
                       '[]'::jsonb
                     ) citations,
                     coalesce(
                       jsonb_agg(distinct e.locator)
                         filter (where e.id is not null),
                       '[]'::jsonb
                     ) evidence_locators
                from knowledge_documents d
                left join knowledge_relations r
                  on r.from_document_id=d.id
                 and r.space_id=d.space_id
                 and r.relation_type in ('supports','derives_from','related_to')
                left join knowledge_documents cited
                  on cited.id=r.to_document_id
                 and cited.space_id=d.space_id
                 and cited.vault_id is not distinct from d.vault_id
                 and cited.lifecycle in ('ACTIVE','DISPUTED')
                 and cited.refresh_status not in ('STALE_BLOCKED','INVALID')
                left join document_evidence de on de.document_id=d.id
                left join evidence e
                  on e.id=de.evidence_id
                 and e.space_id=d.space_id
                 and e.vault_id is not distinct from d.vault_id
               where d.id=any($1::uuid[])
                 and d.space_id=$2
                 and d.vault_id=any($3::uuid[])
                 and d.refresh_status not in ('STALE_BLOCKED','INVALID')
               group by d.id
              `,
              [missingConflictMemberIds, requestedSpace, vaultIds],
            );
      const allowedContextLifecycles = new Set(
        scopedRequest.mode === "DRAFT_INCLUDED"
          ? ["ACTIVE", "DISPUTED", "DRAFT"]
          : ["ACTIVE", "DISPUTED"],
      );
      const contextMinimumTrust = TRUST_RANK[scopedRequest.minimumTrust] ?? 1;
      const conflictCounterparts: SearchHit[] = counterpartRows.rows
        .filter((row) => {
          const current = row as unknown as CurrentContextDocumentRow;
          return (
            allowedContextLifecycles.has(String(row.lifecycle)) &&
            (TRUST_RANK[String(row.trust_tier)] ?? -1) >= contextMinimumTrust &&
            modeAllowsCurrentDocument(scopedRequest.mode, current) &&
            pathAuthorizer(String(row.path), String(row.vault_id))
          );
        })
        .map((row) => {
          const documentCitations = ["source", "resource"].includes(
            String(row.layer),
          )
            ? [`${String(row.path)}@${String(row.current_revision)}`]
            : ((row.citations ?? []) as Array<Record<string, unknown>>)
                .filter(
                  (citation) =>
                    String(citation.spaceId ?? citation.space_id ?? "") ===
                      String(row.space_id) &&
                    String(citation.vaultId ?? citation.vault_id ?? "") ===
                      String(row.vault_id) &&
                    pathAuthorizer(
                      String(citation.path ?? ""),
                      String(
                        citation.vaultId ?? citation.vault_id ?? row.vault_id,
                      ),
                    ),
                )
                .map(
                  (citation) =>
                    `${String(citation.path)}@${String(
                      citation.revision ?? row.current_revision,
                    )}`,
                );
          const rowPathAuthorizer = (value: string) =>
            pathAuthorizer(value, String(row.vault_id));
          const citations = [
            ...new Set([
              ...documentCitations,
              ...(
                (row.evidence_locators ?? []) as Array<Record<string, unknown>>
              )
                .filter((locator) =>
                  evidenceLocatorAllowed(locator, rowPathAuthorizer),
                )
                .map(
                  (locator) =>
                    `evidence:${JSON.stringify(
                      sanitizeEvidenceLocator(locator),
                    )}`,
                ),
            ]),
          ];
          return {
            documentId: String(row.id),
            vaultId: String(row.vault_id),
            document: {
              externalId: row.external_id ? String(row.external_id) : null,
              path: String(row.path),
              title: String(row.title),
            },
            revision: String(row.current_revision),
            title: String(row.title),
            type: String(row.type),
            trust: String(row.trust_tier) as SearchHit["trust"],
            lifecycle: String(row.lifecycle) as SearchHit["lifecycle"],
            refreshStatus: String(row.refresh_status),
            score: 0,
            reasons: ["context:material-conflict-counterpart"],
            excerpt: String(row.body_cache).slice(0, 1200),
            citations,
            warnings: [
              "UNTRUSTED_RETRIEVED_CONTENT",
              "MATERIAL_CONFLICT_COUNTERPART",
              ...(String(row.refresh_status) === "STALE_PENDING_REVIEW"
                ? ["STALE_PENDING_REVIEW"]
                : []),
            ],
          } satisfies SearchHit;
        });
      const contextHits = [...hits, ...conflictCounterparts];
      const contextHitIds = new Set(contextHits.map((hit) => hit.documentId));
      const materialConflicts = conflicts.rows.map((conflict) => ({
        id: String(conflict.id),
        documentIds: (conflict.members ?? []).filter((documentId) =>
          contextHitIds.has(documentId),
        ),
      }));
      const conflictCoverageGaps = conflicts.rows
        .filter((conflict) =>
          (conflict.members ?? []).some(
            (documentId) => !contextHitIds.has(documentId),
          ),
        )
        .map(
          (conflict) =>
            `Material conflict ${conflict.topic} has counterpart material unavailable under the active authorization/truth policy.`,
        );

      const details =
        contextHits.length === 0
          ? { rows: [] }
          : await db.pool.query(
              `select id, layer, type, body_cache from knowledge_documents where id = any($1::uuid[]) and space_id=$2 and vault_id=any($3::uuid[])`,
              [
                contextHits.map((hit) => hit.documentId),
                requestedSpace,
                vaultIds,
              ],
            );
      const detailById = new Map(
        details.rows.map((row) => [String(row.id), row]),
      );
      const channelState = channelsConsistentWithIndex(
        plan.channels,
        indexRow,
        capabilities.vectorAvailable,
      );
      const effectiveChannelState = effectiveRetrievalChannels(
        channelState,
        retrievalWarnings,
        availableChannels,
      );
      let packet;
      let responsePacket;
      const continuationPayloads = new Map<
        string,
        ContextContinuationPayload
      >();
      try {
        const packetInput = {
          request: scopedRequest,
          intent,
          corpusRevision: String(indexRow.corpus_revision ?? "unknown"),
          maxTokens,
          requestedContextLevel,
          searchedChannels: effectiveChannelState.channels,
          ...(dependencies.contextTokenizer
            ? { tokenizer: dependencies.contextTokenizer }
            : {}),
          indexRevisions: {
            corpus: String(indexRow.corpus_revision ?? "unknown"),
            lexical: indexRow.lexical_revision
              ? String(indexRow.lexical_revision)
              : null,
            vector: indexRow.vector_revision
              ? String(indexRow.vector_revision)
              : null,
            graph: indexRow.graph_revision
              ? String(indexRow.graph_revision)
              : null,
            contextPack: indexRow.context_pack_revision
              ? String(indexRow.context_pack_revision)
              : null,
            codeGraph: projectCode?.revision ?? null,
          },
          retrievalConfiguration: {
            version: String(
              indexRow.retrieval_configuration_version ?? "rrf-v1",
            ),
            indexStatus: String(indexRow.status ?? "DEGRADED"),
            channels: effectiveChannelState.channels,
            contextLevel: requestedContextLevel,
            vectorEnabled: capabilities.vectorAvailable,
            codeGraph: projectCode
              ? {
                  projectId: projectCode.projectId,
                  available: projectCode.available,
                  revision: projectCode.revision,
                  sourceRevision: projectCode.sourceRevision,
                }
              : null,
            warnings: effectiveChannelState.warnings,
            truth: truthState
              ? {
                  consistency: truthState.consistency,
                  capturedAt: truthState.snapshot.capturedAt,
                  changedDuringQuery: truthState.changedDuringQuery,
                  revisions: truthState.snapshot.vaults,
                }
              : null,
          },
          candidates: contextHits.map((hit) => {
            const detail = detailById.get(hit.documentId);
            const kind = kindOf(
              String(detail?.layer ?? ""),
              String(detail?.type ?? hit.type),
            );
            return {
              hit,
              content: hit.parentContext ?? hit.excerpt,
              ...(requestedContextLevel === "L3" && detail?.body_cache
                ? { fullContent: String(detail.body_cache) }
                : {}),
              kind,
              ...(kind === "rule" ? { mandatory: true } : {}),
            };
          }),
          gaps: [
            ...(hits.length === 0
              ? ["No source-backed material matched the request."]
              : []),
            ...conflictCoverageGaps,
          ],
          conflicts: conflicts.rows.map(
            (row) => `${row.topic} (${row.status})`,
          ),
          materialConflicts,
          continuationSink: (payload: ContextContinuationPayload) => {
            const existing = continuationPayloads.get(
              payload.continuation.handle,
            );
            if (
              existing &&
              JSON.stringify(existing.sections) !==
                JSON.stringify(payload.sections)
            ) {
              throw new Error("CONTEXT_CONTINUATION_HANDLE_COLLISION");
            }
            continuationPayloads.set(payload.continuation.handle, payload);
          },
        } satisfies Parameters<typeof buildContextPacket>[0];
        const built = await withSpan(
          "context.build",
          { "akp.context.mode": packetMode },
          async () => {
            if (packetMode === "COMPACT_AGENT_PACKET") {
              const pair = buildContextPacketPair(packetInput);
              return { packet: pair.full, responsePacket: pair.compact };
            }
            const full = buildContextPacket(packetInput);
            return { packet: full, responsePacket: full };
          },
        );
        packet = built.packet;
        responsePacket = built.responsePacket;
        telemetry.histogram("context_packet_tokens", packet.budget.usedTokens, {
          mode: packetMode,
        });
        telemetry.histogram("context_packet_sections", packet.sections.length, {
          mode: packetMode,
        });
      } catch (error) {
        if (error instanceof ContextPacketBudgetError) {
          return reply.code(422).send({
            code: error.code,
            maxTokens: error.maxTokens,
            requiredTokens: error.requiredTokens,
          });
        }
        throw error;
      }
      const publicHandles = new Set(
        responsePacket.continuations.map((continuation) => continuation.handle),
      );
      if (
        publicHandles.size !== continuationPayloads.size ||
        [...publicHandles].some((handle) => !continuationPayloads.has(handle))
      ) {
        throw new Error("CONTEXT_CONTINUATION_PAYLOAD_MISSING");
      }

      const client = await db.pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `
          insert into context_packets(id, space_id, vault_id, actor_id, corpus_revision,
                                      query_hash, packet_hash, request, packet, scope)
          values ($1,$2,$3,$4,$5,encode(digest($6,'sha256'),'hex'),$7,$8::jsonb,$9::jsonb,$10::jsonb)
          `,
          [
            packet.packetId,
            requestedSpace,
            vaultIds.length === 1 ? vaultIds[0] : null,
            actor.id,
            packet.corpusRevision,
            parsed.data.query,
            packet.packetHash,
            JSON.stringify(scopedRequest),
            JSON.stringify(packet),
            JSON.stringify({
              spaceId: requestedSpace,
              vaultIds,
              federated: parsed.data.federated,
            }),
          ],
        );
        for (const payload of continuationPayloads.values()) {
          const validated = ContextContinuationResponse.safeParse({
            packetId: packet.packetId,
            packetHash: packet.packetHash,
            corpusRevision: packet.corpusRevision,
            scope: packet.scope,
            continuation: payload.continuation,
            sections: payload.sections,
          });
          if (!validated.success || payload.packetId !== packet.packetId) {
            throw new Error("INVALID_CONTEXT_CONTINUATION_PAYLOAD");
          }
          await client.query(
            `
            insert into context_packet_continuations(
              packet_id,handle,reason,remaining_tokens,sections
            ) values($1,$2,$3,$4,$5::jsonb)
            `,
            [
              packet.packetId,
              payload.continuation.handle,
              payload.continuation.reason,
              payload.continuation.remainingTokens,
              JSON.stringify(payload.sections),
            ],
          );
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
      return responsePacket;
    },
  );
}
