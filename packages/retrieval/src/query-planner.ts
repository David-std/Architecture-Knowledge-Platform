export type QueryIntent =
  | "EXACT_LOOKUP"
  | "CONCEPTUAL"
  | "COMPARISON"
  | "WORKFLOW_EXECUTION"
  | "SOURCE_VERIFICATION"
  | "PROJECT_CODE"
  | "GLOBAL_SYNTHESIS"
  | "IMPACT_ANALYSIS"
  | "NO_RETRIEVAL_REQUIRED";

export type RetrievalChannel =
  "context-pack" | "exact" | "lexical" | "vector" | "graph" | "raw" | "code";

/**
 * Runtime capabilities used to turn an intent into an executable plan.
 *
 * Exact and lexical retrieval are deliberately not represented here: they
 * are the first-class, local fallback for every intent that needs retrieval.
 * The remaining channels are optional providers/indexes and must be enabled
 * explicitly by the caller when their contract is available for the request.
 */
export interface QueryPlannerCapabilities {
  vectorAvailable: boolean;
  graphConsistent: boolean;
  rawAllowed: boolean;
  codeAdapterAvailable: boolean;
  contextPackAvailable: boolean;
}

export interface QueryPlannerOptions extends Partial<QueryPlannerCapabilities> {
  /** Explicit intent; when supported it takes precedence over query text. */
  requestedIntent?: string;
  /** Partial capabilities are merged with fail-closed defaults. */
  capabilities?: Partial<QueryPlannerCapabilities>;
}

export interface QueryPlan {
  intent: QueryIntent;
  channels: RetrievalChannel[];
  maxGraphHops: number;
  requireEvidence: boolean;
  diversityLimitPerDocument: number;
  /** Effective capabilities used to produce this plan. */
  capabilities: QueryPlannerCapabilities;
  /** Optional channels from the intent policy removed by capability gating. */
  omittedChannels: RetrievalChannel[];
}

// Stable identifiers are intentionally recognized by shape rather than by a
// vault's current prefixes.  A planner must continue to work for a software
// vault, a handbook and a neutral domain fixture without importing any of
// their naming conventions.
const exactPattern =
  /(?:\b[A-Z][A-Z0-9]{1,15}(?:[-_][A-Z0-9]+)+\b|[/\\][\w.-]+\.(?:md|ts|tsx|java|cs|py)|\b[A-Z][A-Za-z0-9]+(?:Service|Controller|Repository)\b)/;

const QUERY_INTENTS: ReadonlySet<QueryIntent> = new Set([
  "EXACT_LOOKUP",
  "CONCEPTUAL",
  "COMPARISON",
  "WORKFLOW_EXECUTION",
  "SOURCE_VERIFICATION",
  "PROJECT_CODE",
  "GLOBAL_SYNTHESIS",
  "IMPACT_ANALYSIS",
  "NO_RETRIEVAL_REQUIRED",
]);

/**
 * Unknown optional capabilities fail closed. Adapters that own an optional
 * provider or derived index must report it explicitly; absence is not evidence
 * that a channel is safe or executable.
 */
export const DEFAULT_QUERY_PLANNER_CAPABILITIES: QueryPlannerCapabilities = {
  vectorAvailable: false,
  graphConsistent: false,
  rawAllowed: false,
  codeAdapterAvailable: false,
  contextPackAvailable: false,
};

function normalizeCapabilities(
  input: Partial<QueryPlannerCapabilities> | undefined,
): QueryPlannerCapabilities {
  const capability = (value: unknown, fallback: boolean): boolean =>
    value === undefined ? fallback : value === true;
  return {
    vectorAvailable: capability(
      input?.vectorAvailable,
      DEFAULT_QUERY_PLANNER_CAPABILITIES.vectorAvailable,
    ),
    graphConsistent: capability(
      input?.graphConsistent,
      DEFAULT_QUERY_PLANNER_CAPABILITIES.graphConsistent,
    ),
    rawAllowed: capability(
      input?.rawAllowed,
      DEFAULT_QUERY_PLANNER_CAPABILITIES.rawAllowed,
    ),
    codeAdapterAvailable: capability(
      input?.codeAdapterAvailable,
      DEFAULT_QUERY_PLANNER_CAPABILITIES.codeAdapterAvailable,
    ),
    contextPackAvailable: capability(
      input?.contextPackAvailable,
      DEFAULT_QUERY_PLANNER_CAPABILITIES.contextPackAvailable,
    ),
  };
}

function intentChannels(intent: QueryIntent): RetrievalChannel[] {
  const channelsByIntent: Record<QueryIntent, RetrievalChannel[]> = {
    EXACT_LOOKUP: ["exact", "lexical"],
    CONCEPTUAL: ["exact", "lexical"],
    COMPARISON: ["exact", "lexical"],
    WORKFLOW_EXECUTION: ["context-pack", "exact", "lexical"],
    SOURCE_VERIFICATION: ["exact", "lexical", "graph", "raw"],
    PROJECT_CODE: ["context-pack", "exact", "lexical", "graph", "code"],
    GLOBAL_SYNTHESIS: ["lexical", "vector", "graph"],
    IMPACT_ANALYSIS: ["exact", "graph"],
    NO_RETRIEVAL_REQUIRED: [],
  };
  return [...channelsByIntent[intent]];
}

function channelIsAvailable(
  channel: RetrievalChannel,
  capabilities: QueryPlannerCapabilities,
): boolean {
  switch (channel) {
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
    case "exact":
    case "lexical":
      return true;
  }
}

/**
 * Build a deterministic retrieval plan.
 *
 * The second argument accepts either the legacy intent string or an options
 * object.  The optional third argument is a convenient compatibility form for
 * callers that already pass an intent string.  In both forms a valid explicit
 * intent wins over text heuristics; capability filtering only removes optional
 * channels and never changes that intent.
 */
export function planQuery(
  query: string,
  requestedIntentOrOptions?: string | QueryPlannerOptions,
  legacyCapabilities?: Partial<QueryPlannerCapabilities>,
): QueryPlan {
  const requestedIntent =
    typeof requestedIntentOrOptions === "string"
      ? requestedIntentOrOptions
      : requestedIntentOrOptions?.requestedIntent;
  const directCapabilities: Partial<QueryPlannerCapabilities> = {};
  if (
    typeof requestedIntentOrOptions === "object" &&
    requestedIntentOrOptions !== null
  ) {
    if (requestedIntentOrOptions.vectorAvailable !== undefined) {
      directCapabilities.vectorAvailable =
        requestedIntentOrOptions.vectorAvailable;
    }
    if (requestedIntentOrOptions.graphConsistent !== undefined) {
      directCapabilities.graphConsistent =
        requestedIntentOrOptions.graphConsistent;
    }
    if (requestedIntentOrOptions.rawAllowed !== undefined) {
      directCapabilities.rawAllowed = requestedIntentOrOptions.rawAllowed;
    }
    if (requestedIntentOrOptions.codeAdapterAvailable !== undefined) {
      directCapabilities.codeAdapterAvailable =
        requestedIntentOrOptions.codeAdapterAvailable;
    }
    if (requestedIntentOrOptions.contextPackAvailable !== undefined) {
      directCapabilities.contextPackAvailable =
        requestedIntentOrOptions.contextPackAvailable;
    }
  }
  const capabilities = normalizeCapabilities({
    ...legacyCapabilities,
    ...directCapabilities,
    ...(typeof requestedIntentOrOptions === "object"
      ? (requestedIntentOrOptions.capabilities ?? {})
      : {}),
  });
  const normalized = query.toLowerCase();
  const explicitIntent = requestedIntent?.trim().toUpperCase();
  let intent: QueryIntent;
  if (explicitIntent && QUERY_INTENTS.has(explicitIntent as QueryIntent)) {
    intent = explicitIntent as QueryIntent;
  } else if (/\b(impact|impacto|afecta|dependenc)/.test(normalized))
    intent = "IMPACT_ANALYSIS";
  else if (
    /\b(source|fuente|evidencia|verify|verifica|citation|cita)\b/.test(
      normalized,
    )
  )
    intent = "SOURCE_VERIFICATION";
  else if (
    /\b(repository|repositorio|code|codigo|clase|symbol|commit)\b/.test(
      normalized,
    )
  )
    intent = "PROJECT_CODE";
  else if (
    /\b(compare|comparison|comparar|versus| vs |diferencia)\b/.test(normalized)
  )
    intent = "COMPARISON";
  else if (/\b(workflow|flujo|pasos|proceso|ejecuta)\b/.test(normalized))
    intent = "WORKFLOW_EXECUTION";
  else if (/\b(global|sintesis|panorama|todo el corpus)\b/.test(normalized))
    intent = "GLOBAL_SYNTHESIS";
  else if (exactPattern.test(query)) intent = "EXACT_LOOKUP";
  else intent = "CONCEPTUAL";

  const requestedChannels = intentChannels(intent);
  const channels = requestedChannels.filter((channel) =>
    channelIsAvailable(channel, capabilities),
  );
  const omittedChannels = requestedChannels.filter(
    (channel) => !channelIsAvailable(channel, capabilities),
  );
  const maxGraphHops = channels.includes("graph")
    ? intent === "IMPACT_ANALYSIS"
      ? 3
      : 1
    : 0;
  return {
    intent,
    channels,
    maxGraphHops,
    requireEvidence: intent === "SOURCE_VERIFICATION",
    diversityLimitPerDocument: intent === "GLOBAL_SYNTHESIS" ? 1 : 3,
    capabilities,
    omittedChannels,
  };
}
