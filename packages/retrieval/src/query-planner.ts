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

export interface QueryPlan {
  intent: QueryIntent;
  channels: RetrievalChannel[];
  maxGraphHops: number;
  requireEvidence: boolean;
  diversityLimitPerDocument: number;
}

const exactPattern =
  /(?:\b(?:ADR|SRC|CLM|RULE|WF|CTX)-[A-Z0-9-]+\b|[/\\][\w.-]+\.(?:md|ts|java|cs)|\b[A-Z][A-Za-z0-9]+(?:Service|Controller|Repository)\b)/;

export function planQuery(query: string, requestedIntent?: string): QueryPlan {
  const normalized = `${requestedIntent ?? ""} ${query}`.toLowerCase();
  let intent: QueryIntent;
  if (/\b(impact|impacto|afecta|dependenc)/.test(normalized))
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
  return {
    intent,
    channels: channelsByIntent[intent],
    maxGraphHops: intent === "IMPACT_ANALYSIS" ? 3 : 1,
    requireEvidence: intent === "SOURCE_VERIFICATION",
    diversityLimitPerDocument: intent === "GLOBAL_SYNTHESIS" ? 1 : 3,
  };
}
