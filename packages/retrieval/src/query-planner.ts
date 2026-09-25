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

export type RetrievalStrategy = "LOCAL" | "GLOBAL" | "DRIFT" | "ASSOCIATIVE";

export interface QueryShape {
  exactIdentifier: boolean;
  naturalLanguageConceptual: boolean;
  versionSensitiveCurrent: boolean;
  asOfTemporal: boolean;
  codeSymbolOrPath: boolean;
  multiHop: boolean;
  corpusGlobalSynthesis: boolean;
  ticketWorkProcess: boolean;
  comparison: boolean;
  sourceVerification: boolean;
  permissionSensitiveFederated: boolean;
}

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
  communityAvailable: boolean;
  rawAllowed: boolean;
  codeAdapterAvailable: boolean;
  contextPackAvailable: boolean;
}

export interface QueryPlannerOptions extends Partial<QueryPlannerCapabilities> {
  /** Explicit intent; when supported it takes precedence over query text. */
  requestedIntent?: string;
  /** Partial capabilities are merged with fail-closed defaults. */
  capabilities?: Partial<QueryPlannerCapabilities>;
  /**
   * Runtime-known shape signals may add safety/context information that cannot
   * be inferred from query text alone. False never suppresses an inferred signal.
   */
  queryShape?: Partial<QueryShape>;
}

export interface QueryPlan {
  intent: QueryIntent;
  shape: QueryShape;
  strategy: RetrievalStrategy;
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

const codeShapePattern =
  /(?:[/\\][\w.-]+\.(?:md|ts|tsx|js|jsx|java|cs|py|go|rs)|\b[A-Z][A-Za-z0-9]+(?:Service|Controller|Repository|Client|Handler)\b|\b[A-Za-z_][A-Za-z0-9_]*(?:::[A-Za-z_][A-Za-z0-9_]*|\.[A-Za-z_][A-Za-z0-9_]*)+\b)/;

const QUERY_SHAPE_KEYS: readonly (keyof QueryShape)[] = [
  "exactIdentifier",
  "naturalLanguageConceptual",
  "versionSensitiveCurrent",
  "asOfTemporal",
  "codeSymbolOrPath",
  "multiHop",
  "corpusGlobalSynthesis",
  "ticketWorkProcess",
  "comparison",
  "sourceVerification",
  "permissionSensitiveFederated",
];

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
  communityAvailable: false,
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
    communityAvailable: capability(
      input?.communityAvailable,
      DEFAULT_QUERY_PLANNER_CAPABILITIES.communityAvailable,
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

function intentChannels(
  intent: QueryIntent,
  capabilities: QueryPlannerCapabilities,
): RetrievalChannel[] {
  const channelsByIntent: Record<QueryIntent, RetrievalChannel[]> = {
    EXACT_LOOKUP: ["exact", "lexical"],
    CONCEPTUAL: capabilities.vectorAvailable
      ? ["exact", "lexical", "vector"]
      : ["exact", "lexical"],
    COMPARISON: capabilities.vectorAvailable
      ? ["exact", "lexical", "vector"]
      : ["exact", "lexical"],
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
 * Classify orthogonal query-shape signals before retrieval policy is applied.
 *
 * Shape is intentionally multi-label: a source-verification request can also
 * be temporal, code-oriented, multi-hop and permission-sensitive. These
 * signals never grant a capability.
 */
export function classifyQueryShape(
  query: string,
  intent?: QueryIntent,
): QueryShape {
  const normalized = query.trim().toLowerCase();
  return {
    exactIdentifier: exactPattern.test(query),
    naturalLanguageConceptual:
      intent === "CONCEPTUAL" ||
      /\b(explain|what|why|how|concept|define|describe|explica|que|qué|por que|por qué|como|cómo|concepto)\b/u.test(
        normalized,
      ),
    versionSensitiveCurrent:
      /\b(current|currently|latest|active|effective|today|now|vigente|actual|actualmente|ultimo|último|ultima|última|activo|activa|efectivo|efectiva|hoy|ahora)\b/u.test(
        normalized,
      ),
    asOfTemporal:
      /\b(as[_ -]?of|historical|history|historico|histórico|historica|histórica|en fecha|at version|at revision)\b/u.test(
        normalized,
      ),
    codeSymbolOrPath:
      intent === "PROJECT_CODE" ||
      codeShapePattern.test(query) ||
      /\b(code|codigo|código|symbol|simbolo|símbolo|class|clase|function|funcion|función|method|metodo|método|file|archivo|path|ruta|repository|repositorio)\b/u.test(
        normalized,
      ),
    multiHop:
      intent === "IMPACT_ANALYSIS" ||
      /\b(multi[- ]?hop|trace|traverse|dependency path|dependency chain|impact|impacto|afecta|dependenc|cadena|recorrido)\b/u.test(
        normalized,
      ),
    corpusGlobalSynthesis:
      intent === "GLOBAL_SYNTHESIS" ||
      /\b(global|synthesis|sintesis|síntesis|panorama|whole corpus|todo el corpus|corpus-wide)\b/u.test(
        normalized,
      ),
    ticketWorkProcess:
      intent === "WORKFLOW_EXECUTION" ||
      /\b(ticket|issue|jira|linear|work item|workitem|workflow|process|task|handoff|claim|incident|incidente|tarea|flujo|proceso)\b/u.test(
        normalized,
      ),
    comparison:
      intent === "COMPARISON" ||
      /\b(compare|comparison|comparar|versus|diferencia|difference)\b/u.test(
        normalized,
      ) ||
      normalized.includes(" vs "),
    sourceVerification:
      intent === "SOURCE_VERIFICATION" ||
      /\b(source|fuente|evidence|evidencia|verify|verification|verifica|citation|cita)\b/u.test(
        normalized,
      ),
    permissionSensitiveFederated:
      /\b(permission|permissions|authorized|authorization|acl|rbac|scope|vault|tenant|federated|federation|peer|cross-space|cross-tenant|permiso|permisos|autorizacion|autorización|alcance|boveda|bóveda|inquilino|federado|federada)\b/u.test(
        normalized,
      ),
  };
}

function addRuntimeShapeSignals(
  inferred: QueryShape,
  supplied: Partial<QueryShape> | undefined,
): QueryShape {
  const merged = { ...inferred };
  for (const key of QUERY_SHAPE_KEYS) {
    if (supplied?.[key] === true) merged[key] = true;
  }
  return merged;
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
    if (requestedIntentOrOptions.communityAvailable !== undefined) {
      directCapabilities.communityAvailable =
        requestedIntentOrOptions.communityAvailable;
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

  const inferredShape = classifyQueryShape(query, intent);
  const suppliedShape =
    typeof requestedIntentOrOptions === "object" &&
    requestedIntentOrOptions !== null
      ? requestedIntentOrOptions.queryShape
      : undefined;
  const shape = addRuntimeShapeSignals(inferredShape, suppliedShape);
  const requestedChannels = intentChannels(intent, capabilities);
  const channels = requestedChannels.filter((channel) =>
    channelIsAvailable(channel, capabilities),
  );
  const omittedChannels = requestedChannels.filter(
    (channel) => !channelIsAvailable(channel, capabilities),
  );
  const maxGraphHops = channels.includes("graph")
    ? shape.multiHop
      ? 3
      : 1
    : 0;
  const strategy: RetrievalStrategy =
    intent === "IMPACT_ANALYSIS" && capabilities.graphConsistent
      ? "ASSOCIATIVE"
      : intent === "GLOBAL_SYNTHESIS" && capabilities.communityAvailable
        ? "GLOBAL"
        : (intent === "CONCEPTUAL" || intent === "COMPARISON") &&
            capabilities.communityAvailable
          ? "DRIFT"
          : "LOCAL";
  return {
    intent,
    shape,
    strategy,
    channels,
    maxGraphHops,
    requireEvidence: intent === "SOURCE_VERIFICATION",
    diversityLimitPerDocument: shape.corpusGlobalSynthesis ? 1 : 3,
    capabilities,
    omittedChannels,
  };
}
