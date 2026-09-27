import type { SearchHit } from "@akp/contracts";

const ANSWERABILITY_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "because",
  "can",
  "como",
  "con",
  "cual",
  "cuales",
  "cuando",
  "de",
  "del",
  "debe",
  "durante",
  "el",
  "en",
  "es",
  "esta",
  "este",
  "for",
  "from",
  "how",
  "is",
  "la",
  "las",
  "los",
  "para",
  "por",
  "puede",
  "que",
  "should",
  "the",
  "un",
  "una",
  "what",
  "when",
  "where",
  "which",
  "why",
]);

export type PassageAnswerCue =
  | "PROCEDURE"
  | "PREVENTION"
  | "CONDITION"
  | "RATIONALE"
  | "RULE"
  | "DEFINITION"
  | "COMPARISON";

export type PassageSupportReason =
  | "PASSAGE_TEXT_SUPPORT"
  | "PASSAGE_CUE_SUPPORT"
  | "NO_CONCRETE_PASSAGE"
  | "ANSWER_CUE_MISMATCH"
  | "PASSAGE_SUPPORT_NOT_DEMONSTRATED";

export interface DeterministicPassageSupportPolicy {
  minimumSalientCoverage: number;
  minimumSalientOverlap: number;
  semanticCueMaxVectorRank: number;
}

export const DEFAULT_DETERMINISTIC_PASSAGE_SUPPORT_POLICY: DeterministicPassageSupportPolicy =
  {
    minimumSalientCoverage: 0.4,
    minimumSalientOverlap: 2,
    semanticCueMaxVectorRank: 5,
  };

export interface DeterministicPassageSupportSignal {
  supported: boolean;
  reason: PassageSupportReason;
  passageSource: "STRUCTURAL_CONTEXT" | "EXCERPT";
  passageCharacters: number;
  excerptCharacters: number;
  supportSurfaceExtendsExcerpt: boolean;
  queryTokens: string[];
  overlapTokens: string[];
  queryCoverage: number;
  salientQueryTokens: string[];
  salientOverlapTokens: string[];
  salientCoverage: number;
  requiredAnswerCues: PassageAnswerCue[];
  matchedAnswerCues: PassageAnswerCue[];
  answerCueCoverage: number;
  vectorRank: number | null;
}

function validFraction(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`${field} must be a finite number between 0 and 1`);
  }
  return value;
}

function validPositiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 100
  ) {
    throw new Error(`${field} must be an integer between 1 and 100`);
  }
  return value;
}

export function resolveDeterministicPassageSupportPolicy(
  input: Partial<DeterministicPassageSupportPolicy> = {},
): DeterministicPassageSupportPolicy {
  return {
    minimumSalientCoverage: validFraction(
      input.minimumSalientCoverage ??
        DEFAULT_DETERMINISTIC_PASSAGE_SUPPORT_POLICY.minimumSalientCoverage,
      "minimumSalientCoverage",
    ),
    minimumSalientOverlap: validPositiveInteger(
      input.minimumSalientOverlap ??
        DEFAULT_DETERMINISTIC_PASSAGE_SUPPORT_POLICY.minimumSalientOverlap,
      "minimumSalientOverlap",
    ),
    semanticCueMaxVectorRank: validPositiveInteger(
      input.semanticCueMaxVectorRank ??
        DEFAULT_DETERMINISTIC_PASSAGE_SUPPORT_POLICY.semanticCueMaxVectorRank,
      "semanticCueMaxVectorRank",
    ),
  };
}

export function normalizedAnswerabilityTokens(value: string): string[] {
  return [
    ...new Set(
      (
        value
          .normalize("NFKD")
          .replace(/\p{M}/gu, "")
          .toLocaleLowerCase("en-US")
          .match(/[\p{L}\p{N}]+/gu) ?? []
      ).filter((token) => token.length >= 2),
    ),
  ];
}

function normalizedMatchText(value: string): string {
  return ` ${normalizedAnswerabilityTokens(value).join(" ")} `;
}

function patternMatches(
  normalizedText: string,
  tokens: readonly string[],
  pattern: string,
): boolean {
  const prefix = pattern.endsWith("*");
  const normalizedPattern = normalizedAnswerabilityTokens(
    prefix ? pattern.slice(0, -1) : pattern,
  ).join(" ");
  if (!normalizedPattern) return false;
  if (prefix && !normalizedPattern.includes(" ")) {
    return tokens.some((token) => token.startsWith(normalizedPattern));
  }
  return normalizedText.includes(` ${normalizedPattern} `);
}

const QUERY_CUE_PATTERNS: Record<PassageAnswerCue, readonly string[]> = {
  PROCEDURE: ["how", "como", "de que manera", "mediante que", "procedimiento"],
  PREVENTION: [
    "avoid*",
    "prevent*",
    "duplicate*",
    "repeat*",
    "stop*",
    "not use",
    "evit*",
    "preven*",
    "duplic*",
    "repet*",
    "deten*",
    "no usar",
  ],
  CONDITION: ["when", "cuando", "under what", "en que caso", "en que casos"],
  RATIONALE: ["why", "por que", "razon", "motivo"],
  RULE: ["rule", "policy", "bounded", "limit*", "regla", "politica", "limita*"],
  DEFINITION: ["what is", "que es", "define*", "significa*"],
  COMPARISON: [
    "compare*",
    "versus",
    "difference",
    "diferencia",
    "compar*",
    "frente a",
  ],
};

const PASSAGE_CUE_PATTERNS: Record<PassageAnswerCue, readonly string[]> = {
  PROCEDURE: [
    "must",
    "require*",
    "through",
    "via",
    "submit*",
    "file*",
    "apply*",
    "check*",
    "consult*",
    "persist*",
    "record*",
    "step",
    "then",
    "mediante",
    "debe",
    "requiere",
    "enviar*",
    "consult*",
    "guardar*",
    "registr*",
  ],
  PREVENTION: [
    "avoid*",
    "prevent*",
    "duplicate*",
    "repeat*",
    "twice",
    "idempot*",
    "deduplic*",
    "side effect*",
    "poor fit",
    "not recommended",
    "outweigh*",
    "evit*",
    "preven*",
    "duplic*",
    "repet*",
    "dos veces",
    "sin efectos",
  ],
  CONDITION: [
    "when",
    "if",
    "unless",
    "where",
    "under",
    "only when",
    "scenario*",
    "condition*",
    "threshold*",
    "cuando",
    "si",
    "salvo",
    "donde",
    "bajo",
    "caso",
    "umbral",
  ],
  RATIONALE: [
    "because",
    "due",
    "reason",
    "therefore",
    "tradeoff",
    "overhead",
    "complexity",
    "cost*",
    "porque",
    "debido",
    "razon",
    "motivo",
    "sobrecarga",
    "complejidad",
    "costo*",
  ],
  RULE: [
    "bounded",
    "limit*",
    "maximum",
    "minimum",
    "must",
    "policy",
    "rule",
    "acotad*",
    "limite",
    "maximo",
    "minimo",
    "debe",
    "politica",
    "regla",
  ],
  DEFINITION: [
    "means",
    "defined",
    "refers to",
    "consists of",
    "significa",
    "se define",
    "consiste en",
  ],
  COMPARISON: [
    "versus",
    "compared",
    "unlike",
    "tradeoff",
    "better",
    "worse",
    "prefer*",
    "rather than",
    "frente a",
    "comparad*",
    "diferencia",
    "mejor",
    "peor",
  ],
};

function queryAnswerCues(query: string): PassageAnswerCue[] {
  const normalized = normalizedMatchText(query);
  const tokens = normalizedAnswerabilityTokens(query);
  return (Object.keys(QUERY_CUE_PATTERNS) as PassageAnswerCue[]).filter((cue) =>
    QUERY_CUE_PATTERNS[cue].some((pattern) =>
      patternMatches(normalized, tokens, pattern),
    ),
  );
}

function passageAnswerCues(
  passage: string,
  required: readonly PassageAnswerCue[],
): PassageAnswerCue[] {
  const normalized = normalizedMatchText(passage);
  const tokens = normalizedAnswerabilityTokens(passage);
  return required.filter((cue) =>
    PASSAGE_CUE_PATTERNS[cue].some((pattern) =>
      patternMatches(normalized, tokens, pattern),
    ),
  );
}

function minVectorRank(hit: SearchHit): number | null {
  const ranks = (hit.fusionContributions ?? []).flatMap((contribution) =>
    contribution.channel === "vector" &&
    Number.isInteger(contribution.rank) &&
    contribution.rank > 0
      ? [contribution.rank]
      : [],
  );
  return ranks.length ? Math.min(...ranks) : null;
}

export function verifyDeterministicPassageSupport(
  hit: SearchHit,
  query: string,
  policyInput: Partial<DeterministicPassageSupportPolicy> = {},
): DeterministicPassageSupportSignal {
  const policy = resolveDeterministicPassageSupportPolicy(policyInput);
  const structural = hit.parentContext?.trim();
  const excerpt = hit.excerpt.trim();
  const passage = structural || excerpt;
  const passageSource = structural ? "STRUCTURAL_CONTEXT" : "EXCERPT";
  const queryTokens = normalizedAnswerabilityTokens(query);
  const salientQueryTokens = queryTokens.filter(
    (token) => token.length >= 3 && !ANSWERABILITY_STOPWORDS.has(token),
  );
  const passageTokens = new Set(normalizedAnswerabilityTokens(passage));
  const overlapTokens = queryTokens.filter((token) => passageTokens.has(token));
  const salientOverlapTokens = salientQueryTokens.filter((token) =>
    passageTokens.has(token),
  );
  const queryCoverage =
    queryTokens.length === 0 ? 0 : overlapTokens.length / queryTokens.length;
  const salientCoverage =
    salientQueryTokens.length === 0
      ? 0
      : salientOverlapTokens.length / salientQueryTokens.length;
  const requiredAnswerCues = queryAnswerCues(query);
  const matchedAnswerCues = passageAnswerCues(passage, requiredAnswerCues);
  const answerCueCoverage =
    requiredAnswerCues.length === 0
      ? 1
      : matchedAnswerCues.length / requiredAnswerCues.length;
  const vectorRank = minVectorRank(hit);
  const requiredOverlap = Math.min(
    policy.minimumSalientOverlap,
    Math.max(1, salientQueryTokens.length),
  );
  const strongTextSupport =
    passage.length > 0 &&
    salientQueryTokens.length > 0 &&
    salientOverlapTokens.length >= requiredOverlap &&
    salientCoverage >= policy.minimumSalientCoverage;
  const cueSemanticSupport =
    passage.length > 0 &&
    requiredAnswerCues.length > 0 &&
    answerCueCoverage === 1 &&
    vectorRank !== null &&
    vectorRank <= policy.semanticCueMaxVectorRank;

  let reason: PassageSupportReason;
  if (!passage) {
    reason = "NO_CONCRETE_PASSAGE";
  } else if (strongTextSupport) {
    reason = "PASSAGE_TEXT_SUPPORT";
  } else if (cueSemanticSupport) {
    reason = "PASSAGE_CUE_SUPPORT";
  } else if (
    requiredAnswerCues.length > 0 &&
    matchedAnswerCues.length < requiredAnswerCues.length
  ) {
    reason = "ANSWER_CUE_MISMATCH";
  } else {
    reason = "PASSAGE_SUPPORT_NOT_DEMONSTRATED";
  }

  return {
    supported:
      reason === "PASSAGE_TEXT_SUPPORT" || reason === "PASSAGE_CUE_SUPPORT",
    reason,
    passageSource,
    passageCharacters: passage.length,
    excerptCharacters: excerpt.length,
    supportSurfaceExtendsExcerpt:
      structural !== undefined && structural.length > excerpt.length,
    queryTokens,
    overlapTokens,
    queryCoverage,
    salientQueryTokens,
    salientOverlapTokens,
    salientCoverage,
    requiredAnswerCues,
    matchedAnswerCues,
    answerCueCoverage,
    vectorRank,
  };
}
