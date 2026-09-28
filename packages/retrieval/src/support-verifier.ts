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

export type PassageAnswerRequirement =
  | "PROCEDURE"
  | "PREVENTION"
  | "CONDITION"
  | "RATIONALE"
  | "RULE"
  | "DEFINITION"
  | "COMPARISON"
  | "YES_NO"
  | "QUANTITY"
  | "DATE_YEAR";

export type PassageAnswerCue = PassageAnswerRequirement;

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
  RULE: ["rule", "policy", "regla", "politica"],
  DEFINITION: ["what is", "que es", "define*", "significa*"],
  COMPARISON: [
    "compare*",
    "versus",
    "difference",
    "diferencia",
    "compar*",
    "frente a",
  ],
  YES_NO: [],
  QUANTITY: [],
  DATE_YEAR: [],
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
    "poor fit",
    "not recommended",
    "suitable only",
    "appropriate only",
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
  YES_NO: [
    "is",
    "are",
    "does",
    "do",
    "can",
    "must",
    "requires",
    "require*",
    "define*",
    "determin*",
    "es",
    "son",
    "puede",
    "debe",
    "exig*",
    "requier*",
    "defin*",
    "determin*",
    "no",
    "not",
    "never",
    "nunca",
  ],
  QUANTITY: [],
  DATE_YEAR: [],
};

function identifierLikeQuery(query: string): boolean {
  const trimmed = query.trim();
  if (
    !trimmed ||
    /\s/u.test(trimmed) ||
    !/^[\p{L}\p{N}_.:/-]+$/u.test(trimmed)
  ) {
    return false;
  }
  return (
    /\d/u.test(trimmed) ||
    /[_:/.]/u.test(trimmed) ||
    (trimmed.includes("-") && trimmed === trimmed.toLocaleUpperCase("en-US"))
  );
}

const QUESTION_SHAPE_TOKENS = new Set([
  "all",
  "are",
  "can",
  "como",
  "cuanto",
  "cuantos",
  "cuanta",
  "cuantas",
  "cual",
  "cuales",
  "cuando",
  "define",
  "defines",
  "do",
  "does",
  "entire",
  "es",
  "exige",
  "how",
  "is",
  "many",
  "much",
  "must",
  "por",
  "que",
  "require",
  "requires",
  "should",
  "son",
  "toda",
  "todas",
  "todo",
  "todos",
  "what",
  "when",
  "which",
  "why",
]);

function canonicalSemanticToken(token: string): string {
  if (/^(architect|arquitect)/u.test(token)) return "architecture";
  if (/^(defin|determin)/u.test(token)) return "define";
  if (/^(requir|exig|requier)/u.test(token)) return "require";
  if (/^(view|vista)/u.test(token)) return "view";
  if (/^(dependenc|dependency|dependencies|dependient)/u.test(token))
    return "dependency";
  if (/^(polic|politic)/u.test(token)) return "policy";
  if (/^(student|alumn|estudiant)/u.test(token)) return "student";
  if (/^(withdraw|baja|retiro|retir)/u.test(token)) return "withdrawal";
  if (/^(cancel|cancelar|cancelacion)/u.test(token)) return "cancel";
  if (/^(enroll|registration|matricula|inscripcion)/u.test(token))
    return "enrollment";
  if (/^(universit|universidad)/u.test(token)) return "university";
  if (/^(before|antes)/u.test(token)) return "before";
  if (/^(deadline|limite|vencim)/u.test(token)) return "deadline";
  if (/^(charge|payment|pago|cobro)/u.test(token)) return "payment";
  if (/^(recurr|repeat|repet|again|otra)/u.test(token)) return "repeat";
  if (/^(redeliver|replay|retry|reintent|reenv)/u.test(token)) return "retry";
  if (/^(idempot|deduplic|suppress|stop|prevent|evit|deten)/u.test(token))
    return "prevent-repeat";
  if (/^(cost|costo|precio|importe|price)/u.test(token)) return "cost";
  if (/^(month|monthly|mensual|mes)/u.test(token)) return "month";
  if (/^(year|ano)/u.test(token)) return "year";
  if (/^(reason|razon|motivo|because|porque|debido)/u.test(token))
    return "rationale";
  if (/^(point|apunt)/u.test(token)) return "points";
  if (/^(call|llam)/u.test(token)) return "call";
  return token;
}

function semanticTokens(value: string): string[] {
  return [
    ...new Set(
      normalizedAnswerabilityTokens(value).map((token) =>
        canonicalSemanticToken(token),
      ),
    ),
  ];
}

function queryAnswerCues(query: string): PassageAnswerCue[] {
  if (identifierLikeQuery(query)) return [];
  const normalized = normalizedMatchText(query);
  const tokens = normalizedAnswerabilityTokens(query);
  const cues = new Set<PassageAnswerCue>();

  const quantity =
    /\b(how many|how much|cuant[oa]s?|cantidad|amount|importe|cost|costo|price|precio)\b/u.test(
      normalized.trim(),
    );
  const dateYear =
    /\b(which year|what year|in what year|que ano|en que ano|which date|what date|que fecha|en que fecha)\b/u.test(
      normalized.trim(),
    );
  const yesNo =
    /^(?:\s*[¿?]?\s*)?(?:do|does|did|is|are|can|could|should|must|will|would|es|son|puede|pueden|debe|deben|define|definen|determina|determinan|exige|exigen|requiere|requieren)\b/u.test(
      normalized.trim(),
    );

  if (quantity) cues.add("QUANTITY");
  if (dateYear) cues.add("DATE_YEAR");
  if (yesNo) cues.add("YES_NO");

  for (const cue of Object.keys(QUERY_CUE_PATTERNS) as PassageAnswerCue[]) {
    if (cue === "YES_NO" || cue === "QUANTITY" || cue === "DATE_YEAR") continue;
    if (cue === "PROCEDURE" && quantity) continue;
    // "Does X define Y?" asks for a yes/no assertion about a relation; it is
    // not a request for a dictionary-style definition of Y.
    if (cue === "DEFINITION" && yesNo) continue;
    if (
      QUERY_CUE_PATTERNS[cue].some((pattern) =>
        patternMatches(normalized, tokens, pattern),
      )
    ) {
      cues.add(cue);
    }
  }

  // "How can X be prevented/stopped?" asks for the prevention mechanism.
  // PROCEDURE is a generic interrogative cue here, not a second independent
  // predicate that the passage must prove.
  if (cues.has("PREVENTION")) cues.delete("PROCEDURE");

  return [...cues];
}

function passageWindows(passage: string): string[] {
  // Evidence for an answer predicate must be local. Do not combine adjacent
  // sentences merely because they share a parentContext: an unrelated
  // "because", number or rule in the next sentence must not prove the query.
  const sentences = passage
    .split(/(?<=[.!?;])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  return [
    ...new Set(
      (sentences.length > 0 ? sentences : [passage])
        .map((sentence) => sentence.slice(0, 900).trim())
        .filter(Boolean),
    ),
  ];
}

function queryPredicateAnchors(
  query: string,
  requirements: readonly PassageAnswerCue[],
): string[] {
  const requirementWords = new Set<string>();
  for (const requirement of requirements) {
    for (const pattern of QUERY_CUE_PATTERNS[requirement] ?? []) {
      for (const token of normalizedAnswerabilityTokens(
        pattern.replace("*", ""),
      )) {
        requirementWords.add(canonicalSemanticToken(token));
      }
    }
  }
  return [
    ...new Set(
      semanticTokens(query).filter(
        (token) =>
          token.length >= 2 &&
          !ANSWERABILITY_STOPWORDS.has(token) &&
          !QUESTION_SHAPE_TOKENS.has(token) &&
          !requirementWords.has(token),
      ),
    ),
  ];
}

function quantitativeEvidenceMatches(window: string, query: string): boolean {
  const hasNumber = /(?:^|\s)(?:[$€£S\/]\s*)?\d+(?:[.,]\d+)?(?:\s*%|\b)/u.test(
    window,
  );
  if (!hasNumber) return false;
  const normalizedQuery = normalizedMatchText(query);
  const normalizedWindow = normalizedMatchText(window);
  const asksMonthly = /\b(month|monthly|per month|mensual|por mes|mes)\b/u.test(
    normalizedQuery,
  );
  if (
    asksMonthly &&
    !/\b(month|monthly|per month|mensual|por mes|mes)\b/u.test(normalizedWindow)
  ) {
    return false;
  }
  return true;
}

function dateYearEvidenceMatches(window: string, query: string): boolean {
  const normalizedQuery = normalizedMatchText(query);
  const asksYear = /\b(year|ano)\b/u.test(normalizedQuery);
  if (asksYear) return /\b(?:19|20)\d{2}\b/u.test(window);
  return (
    /\b(?:19|20)\d{2}\b/u.test(window) ||
    /\b\d{1,2}[\/-]\d{1,2}[\/-](?:\d{2}|\d{4})\b/u.test(window)
  );
}

function answerRequirementsMatch(
  window: string,
  query: string,
  required: readonly PassageAnswerCue[],
): { matched: PassageAnswerCue[]; allMatched: boolean } {
  const genericRequired = required.filter(
    (cue) => cue !== "YES_NO" && cue !== "QUANTITY" && cue !== "DATE_YEAR",
  );
  const genericMatched = passageAnswerCues(window, genericRequired);
  const matched = new Set<PassageAnswerCue>(genericMatched);

  if (required.includes("DEFINITION") && !matched.has("DEFINITION")) {
    const normalizedWindow = normalizedMatchText(window);
    const windowTokens = new Set(semanticTokens(window));
    const definitionAnchors = queryPredicateAnchors(query, ["DEFINITION"]);
    const overlap = definitionAnchors.filter((token) => windowTokens.has(token));
    const copularRelation =
      /\b(is|are|means|defined|refers|consists|es|son|significa|define|consiste)\b/u.test(
        normalizedWindow.trim(),
      );
    if (copularRelation && overlap.length >= Math.min(2, definitionAnchors.length)) {
      matched.add("DEFINITION");
    }
  }

  if (
    required.includes("QUANTITY") &&
    quantitativeEvidenceMatches(window, query)
  ) {
    matched.add("QUANTITY");
  }
  if (
    required.includes("DATE_YEAR") &&
    dateYearEvidenceMatches(window, query)
  ) {
    matched.add("DATE_YEAR");
  }
  if (required.includes("YES_NO")) {
    const semanticWindow = new Set(semanticTokens(window));
    const semanticQuery = semanticTokens(query);
    const relationTokens = semanticQuery.filter((token) =>
      ["define", "require", "dependency", "points"].includes(token),
    );
    const relationMatched =
      relationTokens.length === 0 ||
      relationTokens.some((token) => semanticWindow.has(token));
    if (relationMatched) matched.add("YES_NO");
  }

  return {
    matched: [...matched],
    allMatched: required.every((cue) => matched.has(cue)),
  };
}

function boundedPredicateSupport(
  passage: string,
  query: string,
  required: readonly PassageAnswerCue[],
): {
  supported: boolean;
  matchedAnswerCues: PassageAnswerCue[];
  anchorCoverage: number;
  semanticAnchorOverlap: string[];
} {
  const anchors = queryPredicateAnchors(query, required);
  const requiredAnchorOverlap = Math.min(2, Math.max(1, anchors.length));
  let best = {
    supported: false,
    matchedAnswerCues: [] as PassageAnswerCue[],
    anchorCoverage: 0,
    semanticAnchorOverlap: [] as string[],
  };

  for (const window of passageWindows(passage)) {
    const windowTokens = new Set(semanticTokens(window));
    const overlap = anchors.filter((token) => windowTokens.has(token));
    const anchorCoverage =
      anchors.length === 0 ? 1 : overlap.length / anchors.length;
    const answer = answerRequirementsMatch(window, query, required);
    const enoughAnchors =
      anchors.length === 0 ||
      (overlap.length >= requiredAnchorOverlap && anchorCoverage >= 0.4);
    const supported = answer.allMatched && enoughAnchors;
    if (
      supported ||
      anchorCoverage > best.anchorCoverage ||
      answer.matched.length > best.matchedAnswerCues.length
    ) {
      best = {
        supported,
        matchedAnswerCues: answer.matched,
        anchorCoverage,
        semanticAnchorOverlap: overlap,
      };
    }
    if (supported) break;
  }
  return best;
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

/**
 * Re-checks a bounded compact projection without treating a repeated query
 * string as its own answer. Identifier/look-up queries are supported when the
 * exact query remains present. Queries that ask for a procedure, rationale,
 * prevention rule, condition, definition or comparison must also retain the
 * corresponding answer cue outside the echoed query text.
 */
export function deterministicProjectionRetainsSupport(
  passage: string,
  query: string,
): boolean {
  const needle = query.trim();
  if (!needle || !passage.trim()) return false;

  const match = passage
    .toLocaleLowerCase("en-US")
    .indexOf(needle.toLocaleLowerCase("en-US"));
  if (match < 0) return false;

  const requiredAnswerCues = queryAnswerCues(query);
  if (requiredAnswerCues.length === 0 && identifierLikeQuery(query))
    return true;

  const passageWithoutQueryEcho =
    passage.slice(0, match) + " " + passage.slice(match + needle.length);
  return boundedPredicateSupport(
    passageWithoutQueryEcho,
    query,
    requiredAnswerCues,
  ).supported;
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
  const boundedSupport = boundedPredicateSupport(
    passage,
    query,
    requiredAnswerCues,
  );
  const matchedAnswerCues = boundedSupport.matchedAnswerCues;
  const answerCueCoverage =
    requiredAnswerCues.length === 0
      ? 1
      : matchedAnswerCues.length / requiredAnswerCues.length;
  const vectorRank = minVectorRank(hit);
  const requiredOverlap = Math.min(
    policy.minimumSalientOverlap,
    Math.max(1, salientQueryTokens.length),
  );
  const semanticTextSupport =
    requiredAnswerCues.length === 0 &&
    boundedSupport.supported &&
    boundedSupport.semanticAnchorOverlap.length >=
      Math.min(2, Math.max(1, queryPredicateAnchors(query, []).length));
  const strongTextSupport =
    passage.length > 0 &&
    boundedSupport.supported &&
    ((salientQueryTokens.length > 0 &&
      salientOverlapTokens.length >= requiredOverlap &&
      salientCoverage >= policy.minimumSalientCoverage) ||
      semanticTextSupport);
  const cueSemanticSupport =
    passage.length > 0 &&
    requiredAnswerCues.length > 0 &&
    boundedSupport.supported &&
    boundedSupport.semanticAnchorOverlap.length > 0;

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
