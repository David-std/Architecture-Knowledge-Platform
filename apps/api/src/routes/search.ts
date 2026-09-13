import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  intersectVaultPathPrefixes,
  normalizeVaultPathPrefix,
  pathMatchesVaultPrefix,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import {
  GraphRelationType,
  ContextRequest,
  SearchRequest,
  type GraphPathNode,
  type GraphPathProvenance,
  type SearchHit,
  type SearchRequest as SearchInput,
} from "@akp/contracts";
import {
  buildContextPacket,
  buildContextPacketPair,
  ContextPacketBudgetError,
  contextBudgetForIntent,
  createEmbeddingProviderForGeneration,
  planQuery,
  QueryEmbeddingService,
  rehydrateStructuralContext,
  reciprocalRankFusion,
  toPgVector,
  type ActiveEmbeddingGenerationDescriptor,
  type QueryPlan,
  type QueryPlannerCapabilities,
  type RankedChannel,
  type Tokenizer,
} from "@akp/retrieval";
import {
  actorOf,
  hasPathAccess,
  hasSpaceAccess,
  requirePermission,
} from "../auth.js";

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
}

interface DocumentChannelRow {
  id: string;
  document_revision: string;
}

const ALL_GRAPH_RELATION_TYPES: readonly GraphRelationType[] =
  GraphRelationType.options;

const GRAPH_HARD_MAX_HOPS = 3;
const GRAPH_HARD_MAX_PATHS = 10;
const GRAPH_HARD_MAX_CANDIDATES = 100;
const GRAPH_HARD_MAX_FANOUT = 10;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const RRF_CHANNEL_WEIGHTS = {
  exact: 3,
  lexical: 1.5,
  vector: 1,
  "context-pack": 2.5,
  raw: 1.2,
  code: 1.2,
  graph: 1.4,
} as const;

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

export interface RetrievalExecutionOptions {
  channels?: Array<
    "context-pack" | "exact" | "lexical" | "vector" | "graph" | "raw" | "code"
  >;
  plan?: QueryPlan;
  /** Runtime capability snapshot. Production callers must provide all fields. */
  plannerCapabilities?: Partial<QueryPlannerCapabilities>;
  graphPolicy?: Partial<GraphTraversalPolicy>;
  graphScopes?: Array<{ vaultId: string; pathPrefix: string | null }>;
  allowVectorForBenchmark?: boolean;
  deterministicRerank?: boolean;
  /** Test/provider injection seam; production resolves the active descriptor. */
  queryEmbeddingService?: QueryEmbeddingService;
  /** Safe capability warnings accumulated without changing the legacy hit return type. */
  warningSink?: string[];
  /** Channels that reached their provider/index successfully for this request. */
  availableChannelSink?: Set<RetrievalChannel>;
  vaultIds?: string[];
  /** Applied after policy/trust filtering so a scoped caller never receives a
   * path it is not allowed to read. */
  pathAuthorizer?: (path: string, vaultId?: string) => boolean;
}

export interface SearchRouteDependencies {
  /** Active model/agent tokenizer when the runtime provides one. */
  contextTokenizer?: Tokenizer;
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
  id: string;
  unit_id: string;
  unit_type: string;
  document_revision: string;
  score: number;
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
    rawAllowed: boolean;
    codeAdapterAvailable: boolean;
  },
): QueryPlannerCapabilities {
  return {
    vectorAvailable:
      policy.vectorProviderAvailable &&
      revisionIsCurrent(index, "vector_revision"),
    graphConsistent: revisionIsCurrent(index, "graph_revision"),
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

function deterministicLexicalRerank(
  query: string,
  hits: SearchHit[],
): SearchHit[] {
  const terms = new Set(
    query
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
      .split(/[^\p{Letter}\p{Number}]+/u)
      .filter((term) => term.length >= 3),
  );
  return hits
    .map((hit) => {
      const haystack = `${hit.title} ${hit.excerpt}`
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase();
      const overlap = [...terms].filter((term) =>
        haystack.includes(term),
      ).length;
      return {
        ...hit,
        score: hit.score + overlap * 0.001,
        reasons: [...hit.reasons, "deterministic-lexical-rerank"],
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.documentId.localeCompare(right.documentId),
    );
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
function sanitizeEvidenceLocator(value: unknown): unknown {
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
  const requestedChannels = requestedByPolicy.filter((channel) =>
    channelAllowedByCapabilities(channel, effectiveCapabilities),
  );
  for (const channel of requestedByPolicy) {
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

  const exact = channels.has("exact")
    ? await db.pool.query<ExactSearchRow>(
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
           and d.lifecycle in ('ACTIVE','DISPUTED')
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
      )
    : { rows: [] as ExactSearchRow[] };
  if (channels.has("exact")) options.availableChannelSink?.add("exact");

  const lexical =
    channels.has("lexical") || channels.has("graph")
      ? await db.pool.query<LexicalSearchRow>(
          `
          with query as (
            select plainto_tsquery('simple', $2) terms
          ), eligible_documents as (
            select d.id,d.current_revision,d.lexical_external_id_vector,
                   d.lexical_alias_vector,d.lexical_title_vector,
                   d.lexical_path_vector,d.lexical_body_vector,
                   i.lexical_revision index_revision,query.terms
              from knowledge_documents d
              join vault_index_revisions i
                on i.space_id=d.space_id and i.vault_id=d.vault_id
               and i.lexical_revision=i.corpus_revision
              cross join query
             where d.space_id=$1
               ${vaultFilter("d.")}
               and d.lifecycle in ('ACTIVE','DISPUTED')
               and d.refresh_status not in ('STALE_BLOCKED','INVALID')
               ${modeClause}
               and (
                 d.lexical_search_vector @@ query.terms
                 or exists (
                   select 1
                     from knowledge_units matching_unit
                    where matching_unit.document_id=d.id
                      and matching_unit.space_id=d.space_id
                      and matching_unit.vault_id=d.vault_id
                      and matching_unit.corpus_revision=i.lexical_revision
                      and matching_unit.lifecycle in ('ACTIVE','DISPUTED')
                      and matching_unit.embedding_eligible
                      and matching_unit.lexical_search_vector @@ query.terms
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
                     when best_unit.heading_match
                       then 'lexical:heading-terms'
                     when best_unit.unit_match
                       then 'lexical:unit-terms'
                     else 'lexical:body-terms'
                   end match_reason
              from eligible_documents d
              left join lateral (
                select u.id unit_id,u.unit_type,
                       12 * ts_rank_cd(u.lexical_heading_vector,d.terms) +
                        8 * ts_rank_cd(u.lexical_unit_vector,d.terms) +
                            ts_rank_cd(u.lexical_body_vector,d.terms) unit_score,
                       u.lexical_heading_vector @@ d.terms heading_match,
                       u.lexical_unit_vector @@ d.terms unit_match
                  from knowledge_units u
                 where u.document_id=d.id
                   and u.corpus_revision=d.index_revision
                   and u.lifecycle in ('ACTIVE','DISPUTED')
                   and u.embedding_eligible
                 order by unit_score desc,u.structural_order,u.id
                 limit 1
              ) best_unit on true
          )
          select id,unit_id,unit_type,document_revision,score,match_reason
            from scored
           order by score desc,id,unit_id nulls last
           limit $3
          `,
          [spaceId, input.query, Math.max(input.limit * 3, 30)],
        )
      : { rows: [] as LexicalSearchRow[] };
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
      let queryVector: number[];
      try {
        queryVector = await embeddingService.embedQuery(
          input.query,
          generation,
        );
      } catch {
        options.warningSink?.push(
          `VECTOR_PROVIDER_UNAVAILABLE:${generation.vaultId}`,
        );
        continue;
      }
      const dimensions = generation.dimensions;
      try {
        const result = await db.pool.query<VectorSearchRow>(
          `
          select u.document_id id,u.id unit_id,u.unit_type,
                 u.document_revision,
                 1 - (e.embedding::vector(${dimensions}) <=> $3::vector(${dimensions})) score
            from unit_embeddings e
            join knowledge_units u on u.id=e.unit_id
            join knowledge_documents d on d.id=u.document_id
           where e.generation_id=$1 and u.space_id=$2 and u.vault_id=$4
             and e.embedding_dimensions=${dimensions}
             and e.content_hash=u.content_hash
             and u.embedding_eligible
             and u.lifecycle in ('ACTIVE','DISPUTED')
             and d.lifecycle in ('ACTIVE','DISPUTED')
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
        );
        options.availableChannelSink?.add("vector");
        vector.rows.push(...result.rows);
      } catch {
        options.warningSink?.push(
          `VECTOR_QUERY_UNAVAILABLE:${generation.vaultId}`,
        );
      }
    }
    vector.rows.sort(
      (left, right) =>
        Number(right.score) - Number(left.score) ||
        String(left.id).localeCompare(String(right.id)) ||
        String(left.unit_id).localeCompare(String(right.unit_id)),
    );
    vector.rows.splice(Math.max(input.limit * 3, 30));
  }

  const seedIds = [
    ...new Set(
      [...exact.rows, ...lexical.rows, ...vector.rows].map((row) =>
        String(row.id),
      ),
    ),
  ];
  const contextPack = channels.has("context-pack")
    ? await db.pool.query<DocumentChannelRow>(
        `
          with query as (select plainto_tsquery('simple',$2) terms)
          select d.id,d.current_revision document_revision
            from knowledge_documents d
            cross join query
           where d.space_id=$1
             ${vaultFilter("d.")}
             and d.lifecycle in ('ACTIVE','DISPUTED')
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
             and d.lifecycle in ('ACTIVE','DISPUTED')
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

  const codeFallback = channels.has("code")
    ? await db.pool.query<DocumentChannelRow>(
        `
          with query as (select plainto_tsquery('simple',$2) terms)
          select d.id,d.current_revision document_revision
            from knowledge_documents d
            cross join query
           where d.space_id=$1
             ${vaultFilter("d.")}
             and d.lifecycle in ('ACTIVE','DISPUTED')
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
    : { rows: [] as DocumentChannelRow[] };
  if (channels.has("code")) options.availableChannelSink?.add("code");

  const candidateSeedIds = seedIds.filter((id) => UUID_PATTERN.test(id));
  const graphRows =
    candidateSeedIds.length === 0 ||
    !channels.has("graph") ||
    graphPolicy.maxHops === 0 ||
    graphScopes.length === 0
      ? []
      : (
          await db.pool.query<GraphTraversalRow>(
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
                 and d.lifecycle in ('ACTIVE','DISPUTED')
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
                 and edge_from.lifecycle in ('ACTIVE','DISPUTED')
                 and edge_to.lifecycle in ('ACTIVE','DISPUTED')
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
                 and edge_from.lifecycle in ('ACTIVE','DISPUTED')
                 and edge_to.lifecycle in ('ACTIVE','DISPUTED')
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
                       * power($6::double precision,gp.hops+1),
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
                 and next_doc.lifecycle in ('ACTIVE','DISPUTED')
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
                 lifecycle,refresh_status
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
          !["ACTIVE", "DISPUTED"].includes(String(node.lifecycle)) ||
          ["STALE_BLOCKED", "INVALID"].includes(String(node.refresh_status)) ||
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
  if (
    channels.has("graph") &&
    candidateSeedIds.length > 0 &&
    graphPolicy.maxHops > 0 &&
    graphScopes.length > 0
  ) {
    options.availableChannelSink?.add("graph");
  }

  const rankedChannels: RankedChannel[] = [
    {
      channel: "exact",
      channelWeight: RRF_CHANNEL_WEIGHTS.exact,
      items: exact.rows.map((row, index) => ({
        id: String(row.id),
        rank: index + 1,
        reason: row.match_reason ? String(row.match_reason) : "exact",
        candidateRevision: String(row.document_revision),
      })),
    },
    ...(channels.has("lexical")
      ? [
          {
            channel: "lexical",
            channelWeight: RRF_CHANNEL_WEIGHTS.lexical,
            items: lexical.rows.map((row, index) => ({
              id: String(row.id),
              rank: index + 1,
              reason: row.match_reason ? String(row.match_reason) : "lexical",
              candidateRevision: String(row.document_revision),
            })),
          },
        ]
      : []),
    {
      channel: "vector",
      channelWeight: RRF_CHANNEL_WEIGHTS.vector,
      items: vector.rows.map((row, index) => ({
        id: String(row.id),
        rank: index + 1,
        reason: "vector",
        candidateRevision: String(row.document_revision),
      })),
    },
    {
      channel: "context-pack",
      channelWeight: RRF_CHANNEL_WEIGHTS["context-pack"],
      items: contextPack.rows.map((row, index) => ({
        id: String(row.id),
        rank: index + 1,
        reason: "context-pack:lexical-match",
        candidateRevision: String(row.document_revision),
      })),
    },
    {
      channel: "raw",
      channelWeight: RRF_CHANNEL_WEIGHTS.raw,
      items: rawFallback.rows.map((row, index) => ({
        id: String(row.id),
        rank: index + 1,
        reason: "raw:source-match",
        candidateRevision: String(row.document_revision),
      })),
    },
    {
      channel: "code",
      channelWeight: RRF_CHANNEL_WEIGHTS.code,
      items: codeFallback.rows.map((row, index) => ({
        id: String(row.id),
        rank: index + 1,
        reason: "code:project-match",
        candidateRevision: String(row.document_revision),
      })),
    },
    {
      channel: "graph",
      channelWeight: RRF_CHANNEL_WEIGHTS.graph,
      items: graph.rows.map((row, index) => ({
        id: String(row.id),
        rank: index + 1,
        reason: "graph:bounded-path",
        candidateRevision: row.candidateRevision,
      })),
    },
  ];
  const fused = reciprocalRankFusion(rankedChannels).slice(0, input.limit * 2);
  if (fused.length === 0) return [];

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
  const minimumTrust = TRUST_RANK[input.minimumTrust] ?? 1;

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
        ...documentCitations,
        ...((row.evidence_locators ?? []) as Array<Record<string, unknown>>)
          .filter((locator) =>
            evidenceLocatorAllowed(locator, rowPathAuthorizer),
          )
          .map(
            (locator) =>
              `evidence:${JSON.stringify(sanitizeEvidenceLocator(locator))}`,
          ),
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
  return (
    options.deterministicRerank
      ? deterministicLexicalRerank(input.query, results)
      : results
  ).slice(0, input.limit);
}

export function registerSearchRoutes(
  app: FastifyInstance,
  db: Postgres,
  dependencies: SearchRouteDependencies = {},
): void {
  app.post(
    "/v1/search",
    { preHandler: requirePermission("knowledge:read") },
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
      let vaultIds: string[];
      let accessByVault: Awaited<
        ReturnType<typeof resolveAuthorizedVaultScope>
      >["accessByVault"] = {};
      try {
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId: requestedSpace,
          permission: "knowledge:read",
          ...(parsed.data.vaultId ? { vaultId: parsed.data.vaultId } : {}),
          vaultIds: parsed.data.vaultIds,
          federated: parsed.data.federated,
        });
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
        rawAllowed:
          parsed.data.mode !== "COMPILED_ONLY" &&
          hasSpaceAccess(actor, requestedSpace, "source:read"),
        // No project code adapter is registered in the current runtime.
        codeAdapterAvailable: false,
      });
      const plan = planQuery(
        parsed.data.query,
        parsed.data.intent,
        capabilities,
      );
      const retrievalWarnings: string[] = plan.omittedChannels.map(
        (channel) => `PLAN_CHANNEL_OMITTED:${channel}`,
      );
      const availableChannels = new Set<RetrievalChannel>();
      const hits = await queryKnowledge(db, scopedRequest, {
        plan,
        vaultIds,
        graphScopes: Object.entries(accessByVault).map(([vaultId, access]) => ({
          vaultId,
          pathPrefix: access.pathPrefix,
        })),
        warningSink: retrievalWarnings,
        availableChannelSink: availableChannels,
        pathAuthorizer: (documentPath, vaultId) => {
          const access = accessByVault[String(vaultId ?? "")];
          if (!access) return false;
          return (
            pathMatchesVaultPrefix(documentPath, access.pathPrefix) &&
            hasPathAccess(actor, requestedSpace, "knowledge:read", documentPath)
          );
        },
      });
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

  app.post(
    "/v1/context",
    { preHandler: requirePermission("knowledge:read") },
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
      let vaultIds: string[];
      let accessByVault: Awaited<
        ReturnType<typeof resolveAuthorizedVaultScope>
      >["accessByVault"] = {};
      try {
        const scope = await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId: requestedSpace,
          permission: "knowledge:read",
          ...(parsed.data.vaultId ? { vaultId: parsed.data.vaultId } : {}),
          vaultIds: parsed.data.vaultIds,
          federated: parsed.data.federated,
        });
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
        maxTokens: requestedMaxTokens,
        ...contextSearchRequest
      } = parsed.data;
      const scopedRequest: SearchInput = {
        ...contextSearchRequest,
        vaultIds,
        ...(vaultIds.length === 1 ? { vaultId: vaultIds[0] } : {}),
      };
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
        rawAllowed:
          parsed.data.mode !== "COMPILED_ONLY" &&
          hasSpaceAccess(actor, requestedSpace, "source:read"),
        codeAdapterAvailable: false,
      });
      const plan = planQuery(
        parsed.data.query,
        parsed.data.intent,
        capabilities,
      );
      const intent = plan.intent;
      const maxTokens = contextBudgetForIntent(intent, requestedMaxTokens);
      const retrievalWarnings: string[] = plan.omittedChannels.map(
        (channel) => `PLAN_CHANNEL_OMITTED:${channel}`,
      );
      const availableChannels = new Set<RetrievalChannel>();
      const hits = await queryKnowledge(db, scopedRequest, {
        plan,
        vaultIds,
        graphScopes: Object.entries(accessByVault).map(([vaultId, access]) => ({
          vaultId,
          pathPrefix: access.pathPrefix,
        })),
        warningSink: retrievalWarnings,
        availableChannelSink: availableChannels,
        pathAuthorizer: (documentPath, vaultId) => {
          const access = accessByVault[String(vaultId ?? "")];
          if (!access) return false;
          return (
            pathMatchesVaultPrefix(documentPath, access.pathPrefix) &&
            hasPathAccess(actor, requestedSpace, "knowledge:read", documentPath)
          );
        },
      });
      const details =
        hits.length === 0
          ? { rows: [] }
          : await db.pool.query(
              `select id, layer, type from knowledge_documents where id = any($1::uuid[]) and space_id=$2 and vault_id=any($3::uuid[])`,
              [hits.map((hit) => hit.documentId), requestedSpace, vaultIds],
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
      const conflicts =
        hits.length === 0
          ? { rows: [] }
          : await db.pool.query(
              `
              select distinct c.id,c.topic,c.status,c.resolution
               from contradiction_clusters c
               join contradiction_members m on m.cluster_id=c.id
               where m.document_id=any($1::uuid[])
                 and c.space_id=$2
                 and c.vault_id=any($3::uuid[])
                 and c.status <> 'RESOLVED'
              `,
              [hits.map((hit) => hit.documentId), requestedSpace, vaultIds],
            );
      let packet;
      let responsePacket;
      try {
        const packetInput = {
          request: scopedRequest,
          intent,
          corpusRevision: String(indexRow.corpus_revision ?? "unknown"),
          maxTokens,
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
          },
          retrievalConfiguration: {
            version: String(
              indexRow.retrieval_configuration_version ?? "rrf-v1",
            ),
            channels: effectiveChannelState.channels,
            vectorEnabled: capabilities.vectorAvailable,
            warnings: effectiveChannelState.warnings,
          },
          candidates: hits.map((hit) => {
            const detail = detailById.get(hit.documentId);
            return {
              hit,
              content: hit.parentContext ?? hit.excerpt,
              kind: kindOf(
                String(detail?.layer ?? ""),
                String(detail?.type ?? hit.type),
              ),
            };
          }),
          gaps:
            hits.length === 0
              ? ["No source-backed material matched the request."]
              : [],
          conflicts: conflicts.rows.map(
            (row) => `${row.topic} (${row.status})`,
          ),
        } satisfies Parameters<typeof buildContextPacket>[0];
        if (packetMode === "COMPACT_AGENT_PACKET") {
          const pair = buildContextPacketPair(packetInput);
          packet = pair.full;
          responsePacket = pair.compact;
        } else {
          packet = buildContextPacket(packetInput);
          responsePacket = packet;
        }
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
      await db.pool.query(
        `
        insert into context_packets(id, space_id, vault_id, actor_id, corpus_revision,
                                    query_hash, packet_hash, request, packet, scope)
        values ($1,$2,$3,$4,$5,encode(digest($6,'sha256'),'hex'),$7,$8::jsonb,$9::jsonb,$10::jsonb)
        `,
        [
          packet.packetId,
          requestedSpace,
          vaultIds.length === 1 ? vaultIds[0] : null,
          actorOf(request)?.id ?? null,
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
      return responsePacket;
    },
  );
}
