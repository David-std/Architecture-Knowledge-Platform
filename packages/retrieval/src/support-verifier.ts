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
  | "CLAIM_RELATION_SUPPORT"
  | "CONCEPT_DEFINITION_SUPPORT"
  | "NO_CONCRETE_PASSAGE"
  | "ANSWER_CUE_MISMATCH"
  | "PASSAGE_SUPPORT_NOT_DEMONSTRATED";

export interface DeterministicPassageSupportPolicy {
  minimumSalientCoverage: number;
  minimumSalientOverlap: number;
}

export const DEFAULT_DETERMINISTIC_PASSAGE_SUPPORT_POLICY: DeterministicPassageSupportPolicy =
  {
    minimumSalientCoverage: 0.4,
    minimumSalientOverlap: 2,
  };

export interface ClaimRelationDiagnostics {
  eligibleClaim: boolean;
  relationExtracted: boolean;
  predicateMatched: boolean;
  subjectAnchorCount: number;
  subjectOverlap: number;
  subjectMatched: boolean;
  objectAnchorCount: number;
  objectOverlap: number;
  queryGlobalScope: boolean;
  excerptGlobalScope: boolean;
  objectOrScopeMatched: boolean;
  anchorCount: number;
  anchorOverlap: number;
  supported: boolean;
}

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
  claimRelationDiagnostics: ClaimRelationDiagnostics | null;
  boundedAnchorCoverage: number;
  boundedRelationRoleMatched: boolean;
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
  const patternTokens = normalizedAnswerabilityTokens(
    prefix ? pattern.slice(0, -1) : pattern,
  );
  if (patternTokens.length === 0) return false;

  if (!prefix) {
    return normalizedText.includes(` ${patternTokens.join(" ")} `);
  }
  if (patternTokens.length === 1) {
    return tokens.some((token) => token.startsWith(patternTokens[0]!));
  }

  const fixedTokens = patternTokens.slice(0, -1);
  const finalPrefix = patternTokens.at(-1)!;
  for (
    let index = 0;
    index <= tokens.length - patternTokens.length;
    index += 1
  ) {
    const fixedMatch = fixedTokens.every(
      (token, offset) => tokens[index + offset] === token,
    );
    if (
      fixedMatch &&
      tokens[index + fixedTokens.length]?.startsWith(finalPrefix)
    ) {
      return true;
    }
  }
  return false;
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
  RULE: ["rule", "regla"],
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
    "should not",
    "do not use",
    "reject*",
    "discard*",
    "unsuitable",
    "outweigh*",
    "evit*",
    "preven*",
    "duplic*",
    "repet*",
    "dos veces",
    "sin efectos",
    "rechaz*",
    "descart*",
    "no conviene",
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
    "without",
    "in absence",
    "absent",
    "cuando",
    "si",
    "salvo",
    "donde",
    "bajo",
    "caso",
    "umbral",
    "sin",
    "sin que",
    "a falta de",
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
    "so",
    "so that",
    "in order to",
    "to keep",
    "to preserve",
    "thereby",
    "this keep*",
    "this preserv*",
    "this prevent*",
    "this avoid*",
    "this allow*",
    "this ensur*",
    "doing so",
    "as a result",
    "leak*",
    "porque",
    "debido",
    "razon",
    "motivo",
    "sobrecarga",
    "complejidad",
    "costo*",
    "para",
    "para que",
    "con el fin de",
    "de modo que",
    "esto mantien*",
    "esto preserv*",
    "esto evit*",
    "esto permit*",
    "esto asegur*",
    "al hacerlo",
    "asi",
    "de esta forma",
    "de este modo",
    "filtr*",
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
  "enough",
  "every",
  "overall",
  "alone",
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
  if (/^(pattern|patron)/u.test(token)) return "pattern";
  if (/^(system|sistema)/u.test(token)) return "system";
  if (/^(defin|determin)/u.test(token)) return "define";
  if (/^(requir|exig|requier)/u.test(token)) return "require";
  if (/^(view|vista|diagram|diagrama)/u.test(token)) return "view";
  if (/^(mandatory|obligat|obligatori)/u.test(token)) return "require";
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
  if (
    /^(cost|costo|coste|precio|importe|price|overhead|sobrecarga)/u.test(token)
  )
    return "cost";
  if (/^(operat|operacion)/u.test(token)) return "operational";
  if (/^(domain|dominio)/u.test(token)) return "domain";
  if (/^(external|exterior|extern)/u.test(token)) return "external";
  if (/^(detail|detalle)/u.test(token)) return "detail";
  if (/^(toward|towards|hacia)/u.test(token)) return "toward";
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

const YES_NO_RELATION_PREDICATES = new Set(["define", "require", "points"]);

const RELATION_GRAMMAR_TOKENS = new Set([
  "using",
  "use",
  "uses",
  "used",
  "via",
  "through",
  "or",
  "either",
  "both",
  "usando",
  "usar",
  "mediante",
  "o",
]);

const RELATION_GENERIC_SUBJECT_HEADS = new Set([
  "model",
  "modelo",
  "pattern",
  "system",
  "framework",
  "approach",
  "enfoque",
]);

interface QueryRelationRoles {
  predicates: string[];
  subjectAnchors: string[];
  objectAnchors: string[];
}

function orderedSemanticTokens(value: string): string[] {
  return normalizedAnswerabilityTokens(value).map((token) =>
    canonicalSemanticToken(token),
  );
}

function relationAnchorEligible(token: string): boolean {
  return (
    token.length >= 2 &&
    !ANSWERABILITY_STOPWORDS.has(token) &&
    !QUESTION_SHAPE_TOKENS.has(token) &&
    !YES_NO_RELATION_PREDICATES.has(token) &&
    !RELATION_GRAMMAR_TOKENS.has(token)
  );
}

function queryYesNoRelationRoles(query: string): QueryRelationRoles | null {
  const ordered = orderedSemanticTokens(query);
  const predicateIndex = ordered.findIndex((token) =>
    YES_NO_RELATION_PREDICATES.has(token),
  );
  if (predicateIndex < 0) return null;

  const predicate = ordered[predicateIndex]!;
  const subjectAnchors = [
    ...new Set(ordered.slice(0, predicateIndex).filter(relationAnchorEligible)),
  ];
  const objectAnchors = [
    ...new Set(
      ordered.slice(predicateIndex + 1).filter(relationAnchorEligible),
    ),
  ];

  if (subjectAnchors.length === 0 || objectAnchors.length === 0) return null;
  return {
    predicates: [predicate],
    subjectAnchors,
    objectAnchors,
  };
}

function relationRolesMatch(
  evidence: string,
  relation: QueryRelationRoles,
  scopeTitle?: string,
): boolean {
  const tokens = orderedSemanticTokens(evidence);
  const titleTokens = new Set(scopeTitle ? semanticTokens(scopeTitle) : []);
  for (let index = 0; index < tokens.length; index += 1) {
    if (!relation.predicates.includes(tokens[index]!)) continue;
    const before = new Set(tokens.slice(0, index));
    const after = new Set(tokens.slice(index + 1));
    const subjectMatched = relation.subjectAnchors.some(
      (token) => before.has(token) || titleTokens.has(token),
    );
    const negationNearPredicate = tokens
      .slice(Math.max(0, index - 6), index)
      .some((token) => ["no", "not", "never", "nunca"].includes(token));
    const objectMatched = relation.objectAnchors.some(
      (token) =>
        after.has(token) || (before.has(token) && negationNearPredicate),
    );
    if (subjectMatched && objectMatched) return true;
  }
  return false;
}

function orderedSubsequencePresent(
  haystack: readonly string[],
  needle: readonly string[],
): boolean {
  if (needle.length === 0) return false;
  let cursor = 0;
  for (const token of haystack) {
    if (token !== needle[cursor]) continue;
    cursor += 1;
    if (cursor === needle.length) return true;
  }
  return false;
}

function genericYesNoRelationRolesMatch(
  evidence: string,
  query: string,
): boolean {
  const queryTokens = orderedSemanticTokens(query).filter(
    (token) =>
      !ANSWERABILITY_STOPWORDS.has(token) && !QUESTION_SHAPE_TOKENS.has(token),
  );
  if (queryTokens.length < 3) return false;
  return orderedSubsequencePresent(
    orderedSemanticTokens(evidence),
    queryTokens,
  );
}

function isSupportEligibleProposition(hit: SearchHit): boolean {
  return (
    hit.lifecycle === "ACTIVE" &&
    (hit.trust === "MACHINE_SUPPORTED" ||
      hit.trust === "HUMAN_REVIEWED" ||
      hit.trust === "ATTESTED") &&
    ["claim", "rule", "decision-rule"].includes(
      hit.type.trim().toLocaleLowerCase("en-US"),
    )
  );
}

function definitionIdentityMatches(
  hit: SearchHit,
  excerpt: string,
  query: string,
): boolean {
  const anchors = queryPredicateAnchors(query, ["DEFINITION"]);
  if (anchors.length === 0) return false;

  const headingPath = hit.headingPath ?? [];
  const canonicalLabels = [
    hit.title?.trim() || hit.document.title,
    headingPath[0] ?? "",
    ...(hit.document.aliases ?? []),
  ].filter((value) => value.trim().length > 0);
  const scopeTokens = new Set(canonicalLabels.flatMap(semanticTokens));
  const scopeOverlap = anchors.filter((token) => scopeTokens.has(token));
  const requiredScopeOverlap = Math.min(2, anchors.length);
  if (
    scopeOverlap.length < requiredScopeOverlap ||
    scopeOverlap.length / anchors.length < 0.6
  ) {
    return false;
  }

  const excerptTokens = new Set(semanticTokens(excerpt));
  return canonicalLabels.some((label) => {
    const identityTokens = semanticTokens(label).filter(
      (token) =>
        token.length >= 3 &&
        !ANSWERABILITY_STOPWORDS.has(token) &&
        !QUESTION_SHAPE_TOKENS.has(token),
    );
    if (identityTokens.length === 0) return false;
    const matched = identityTokens.filter((token) => excerptTokens.has(token));
    return (
      matched.length >= Math.min(2, identityTokens.length) &&
      matched.length / identityTokens.length >= 0.6
    );
  });
}

function isIntroductoryConceptDefinition(
  hit: SearchHit,
  excerpt: string,
  query: string,
  required: readonly PassageAnswerCue[],
): boolean {
  if (
    required.length !== 1 ||
    required[0] !== "DEFINITION" ||
    hit.lifecycle !== "ACTIVE" ||
    !["MACHINE_SUPPORTED", "HUMAN_REVIEWED", "ATTESTED"].includes(hit.trust) ||
    hit.type.trim().toLocaleLowerCase("en-US") !== "concept" ||
    hit.unitType !== "PARAGRAPH" ||
    !Number.isSafeInteger(hit.structuralOrder) ||
    (hit.structuralOrder ?? Number.MAX_SAFE_INTEGER) > 2 ||
    (hit.structuralOrder ?? -1) < 1 ||
    !excerpt.trim()
  ) {
    return false;
  }

  const headingPath = hit.headingPath ?? [];
  if (headingPath.length !== 1) return false;

  const excerptTokenCount = normalizedAnswerabilityTokens(excerpt).length;
  return (
    definitionIdentityMatches(hit, excerpt, query) && excerptTokenCount >= 4
  );
}

function globalRelationScopePresent(value: string): boolean {
  const normalized = normalizedMatchText(value).trim();
  return /\b(?:overall|global|globally|entire|system wide|across the system|across system|globalmente|en todo el sistema|de todo el sistema)\b/u.test(
    normalized,
  );
}

function atomicClaimRelationDiagnostics(
  hit: SearchHit,
  excerpt: string,
  query: string,
): ClaimRelationDiagnostics {
  const eligibleClaim = isSupportEligibleProposition(hit);
  const relation = queryYesNoRelationRoles(query);
  const queryAnchors = queryPredicateAnchors(query, ["YES_NO"]);
  const excerptTokens = new Set(semanticTokens(excerpt));
  const claimSubjectAnchors = relation
    ? (() => {
        const specific = relation.subjectAnchors.filter(
          (token) => !RELATION_GENERIC_SUBJECT_HEADS.has(token),
        );
        return specific.length > 0 ? specific : relation.subjectAnchors;
      })()
    : [];
  const predicateMatched =
    relation?.predicates.some((token) => excerptTokens.has(token)) ?? false;
  const subjectOverlap = claimSubjectAnchors.filter((token) =>
    excerptTokens.has(token),
  ).length;
  const objectOverlap =
    relation?.objectAnchors.filter((token) => excerptTokens.has(token))
      .length ?? 0;
  const anchorOverlap = queryAnchors.filter((token) =>
    excerptTokens.has(token),
  ).length;
  const queryGlobalScope = globalRelationScopePresent(query);
  const excerptGlobalScope = globalRelationScopePresent(excerpt);
  const minimumSubjectOverlap =
    claimSubjectAnchors.length > 0
      ? Math.min(2, claimSubjectAnchors.length)
      : 0;
  const subjectMatched =
    relation !== null && subjectOverlap >= minimumSubjectOverlap;
  const objectOrScopeMatched =
    relation !== null &&
    (objectOverlap > 0 || (queryGlobalScope && excerptGlobalScope));
  const supported =
    eligibleClaim &&
    Boolean(excerpt.trim()) &&
    relation !== null &&
    predicateMatched &&
    subjectMatched &&
    objectOrScopeMatched;

  return {
    eligibleClaim,
    relationExtracted: relation !== null,
    predicateMatched,
    subjectAnchorCount: claimSubjectAnchors.length,
    subjectOverlap,
    subjectMatched,
    objectAnchorCount: relation?.objectAnchors.length ?? 0,
    objectOverlap,
    queryGlobalScope,
    excerptGlobalScope,
    objectOrScopeMatched,
    anchorCount: queryAnchors.length,
    anchorOverlap,
    supported,
  };
}

function queryExplicitlyRequestsQuantity(query: string): boolean {
  const normalized = normalizedMatchText(query).trim();
  return (
    /\b(?:how many|how much|cuant[oa]s?)\b/u.test(normalized) ||
    /\bwhat\s+(?:does|do|did)\b.{0,80}\bcost\b/u.test(normalized) ||
    /\b(?:what|which)\s+(?:is|are|was|were)\s+(?:the|its|their)?\s*(?:(?:monthly|annual|yearly|daily|weekly|operating|operational|infrastructure|estimated|expected|total)\s+){0,4}(?:cost|price|amount)\b/u.test(
      normalized,
    ) ||
    /\bcuanto\s+cuesta\b/u.test(normalized) ||
    /\b(?:cual|cuanto|cuanta)\s+(?:es|son|fue|eran)?\s*(?:el|la|los|las)?\s*(?:(?:mensual|anual|diario|semanal|operativo|operacional|infraestructura|estimado|esperado|total)\s+){0,4}(?:costo|coste|precio|importe|monto)\b/u.test(
      normalized,
    )
  );
}

function queryExplicitlyRequestsRule(query: string): boolean {
  const normalized = normalizedMatchText(query).trim();
  return (
    /\b(?:what|which)\s+(?:rule|policy)\b/u.test(normalized) ||
    /\b(?:under|according to)\s+(?:what|which)\s+(?:rule|policy)\b/u.test(
      normalized,
    ) ||
    /\b(?:que|cual)\s+(?:regla|politica)\b/u.test(normalized)
  );
}

function queryAnswerCues(query: string): PassageAnswerCue[] {
  if (identifierLikeQuery(query)) return [];
  const normalized = normalizedMatchText(query);
  const tokens = normalizedAnswerabilityTokens(query);
  const cues = new Set<PassageAnswerCue>();

  const quantity = queryExplicitlyRequestsQuantity(query);
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
  if (queryExplicitlyRequestsRule(query)) cues.add("RULE");

  for (const cue of Object.keys(QUERY_CUE_PATTERNS) as PassageAnswerCue[]) {
    if (
      cue === "YES_NO" ||
      cue === "QUANTITY" ||
      cue === "DATE_YEAR" ||
      cue === "RULE"
    )
      continue;
    if (cue === "PROCEDURE" && quantity) continue;
    // "Does X define Y?" asks for a yes/no assertion about a relation; it is
    // not a request for a dictionary-style definition of Y.
    if (cue === "DEFINITION" && (yesNo || quantity || dateYear)) continue;
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

function explicitlyLinkedContinuation(sentence: string): boolean {
  const normalized = normalizedMatchText(sentence).trim();
  return /^(?:without (?:them|those|these|it)|in (?:their|its) absence|sin (?:ellos|ellas|estos|estas|eso|esos|esas)|a falta de (?:ellos|ellas|estos|estas|eso)|because of (?:this|that)|therefore|thus|consequently|this (?:keeps?|preserves?|prevents?|avoids?|allows?|ensures?)|doing so|as a result|por (?:ello|eso)|de modo que|esto (?:mantiene|preserva|evita|permite|asegura)|al hacerlo|asi|de esta forma|de este modo)\b/u.test(
    normalized,
  );
}

interface PassageWindow {
  text: string;
  evidence: string;
  scopeTitle?: string;
}

function passageWindows(passage: string, title?: string): PassageWindow[] {
  // Evidence for an answer predicate must stay local. A unit title may scope a
  // sentence, and an adjacent sentence may be joined only when it explicitly
  // refers back to its predecessor. For relation questions, the title may
  // identify the subject but cannot supply the predicate or object.
  const sentences = passage
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((sentence) => sentence.slice(0, 900).trim());
  const boundedSentences =
    sentences.length > 0 ? sentences : [passage.slice(0, 900).trim()];
  const boundedTitle = title?.trim().slice(0, 240);
  const windows: PassageWindow[] = boundedSentences.map((sentence) => ({
    text: sentence,
    evidence: sentence,
  }));

  if (boundedTitle) {
    for (const sentence of boundedSentences) {
      windows.push({
        text: `${boundedTitle}: ${sentence}`.slice(0, 1200),
        evidence: sentence,
        scopeTitle: boundedTitle,
      });
    }
  }

  for (let index = 1; index < boundedSentences.length; index += 1) {
    const current = boundedSentences[index]!;
    if (!explicitlyLinkedContinuation(current)) continue;
    const linked = `${boundedSentences[index - 1]} ${current}`.slice(0, 1800);
    windows.push({ text: linked, evidence: linked });
    if (boundedTitle) {
      windows.push({
        text: `${boundedTitle}: ${linked}`.slice(0, 2040),
        evidence: linked,
        scopeTitle: boundedTitle,
      });
    }
  }

  const seen = new Set<string>();
  return windows.filter((window) => {
    if (!window.text || seen.has(window.text)) return false;
    seen.add(window.text);
    return true;
  });
}

const CUE_TOKENS_THAT_REMAIN_PREDICATE_ANCHORS = new Set([
  "duplicate",
  "repeat",
]);

const PREDICATE_GRAMMAR_TOKENS = new Set([
  "using",
  "use",
  "or",
  "either",
  "both",
  "toward",
  "rather",
  "than",
  "instead",
  "via",
  "through",
  "usando",
  "usar",
  "o",
  "hacia",
  "mediante",
]);

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
        const canonical = canonicalSemanticToken(token);
        if (CUE_TOKENS_THAT_REMAIN_PREDICATE_ANCHORS.has(canonical)) continue;
        requirementWords.add(canonical);
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
          !PREDICATE_GRAMMAR_TOKENS.has(token) &&
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
  relationEvidence: string = window,
  relationScopeTitle?: string,
): {
  matched: PassageAnswerCue[];
  allMatched: boolean;
  relationRoleMatched: boolean;
} {
  const genericRequired = required.filter(
    (cue) => cue !== "YES_NO" && cue !== "QUANTITY" && cue !== "DATE_YEAR",
  );
  const genericMatched = passageAnswerCues(window, genericRequired);
  const matched = new Set<PassageAnswerCue>(genericMatched);

  if (required.includes("DEFINITION") && !matched.has("DEFINITION")) {
    const normalizedWindow = normalizedMatchText(window);
    const windowTokens = new Set(semanticTokens(window));
    const definitionAnchors = queryPredicateAnchors(query, ["DEFINITION"]);
    const overlap = definitionAnchors.filter((token) =>
      windowTokens.has(token),
    );
    const copularRelation =
      /\b(is|are|means|defined|refers|consists|es|son|significa|define|consiste)\b/u.test(
        normalizedWindow.trim(),
      );
    if (
      copularRelation &&
      overlap.length >= Math.min(2, definitionAnchors.length)
    ) {
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
  let relationRoleMatched = false;
  if (required.includes("YES_NO")) {
    const relation = queryYesNoRelationRoles(query);
    if (relation) {
      relationRoleMatched = relationRolesMatch(
        relationEvidence,
        relation,
        relationScopeTitle,
      );
      if (relationRoleMatched) matched.add("YES_NO");
    } else {
      relationRoleMatched = genericYesNoRelationRolesMatch(
        relationEvidence,
        query,
      );
      if (relationRoleMatched) matched.add("YES_NO");
    }
  }

  return {
    matched: [...matched],
    allMatched: required.every((cue) => matched.has(cue)),
    relationRoleMatched,
  };
}

function boundedPredicateSupport(
  passage: string,
  query: string,
  required: readonly PassageAnswerCue[],
  title?: string,
): {
  supported: boolean;
  matchedAnswerCues: PassageAnswerCue[];
  anchorCoverage: number;
  semanticAnchorOverlap: string[];
  relationRoleMatched: boolean;
} {
  const anchors = queryPredicateAnchors(query, required);
  const requiredAnchorOverlap = Math.min(2, Math.max(1, anchors.length));
  let best = {
    supported: false,
    matchedAnswerCues: [] as PassageAnswerCue[],
    anchorCoverage: 0,
    semanticAnchorOverlap: [] as string[],
    relationRoleMatched: false,
  };

  for (const window of passageWindows(passage, title)) {
    const windowTokens = new Set(semanticTokens(window.text));
    const overlap = anchors.filter((token) => windowTokens.has(token));
    const anchorCoverage =
      anchors.length === 0 ? 1 : overlap.length / anchors.length;
    const answer = answerRequirementsMatch(
      window.text,
      query,
      required,
      window.evidence,
      window.scopeTitle,
    );
    const boundedDefinitionRelation =
      required.includes("DEFINITION") &&
      answer.matched.includes("DEFINITION") &&
      overlap.length >= requiredAnchorOverlap;
    const enoughAnchors =
      anchors.length === 0 ||
      (overlap.length >= requiredAnchorOverlap &&
        (anchorCoverage >= 0.4 || boundedDefinitionRelation));
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
        relationRoleMatched: answer.relationRoleMatched,
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
  const excerpt = hit.excerpt.trim();
  const passage = excerpt;
  const passageSource = "EXCERPT" as const;
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
    hit.title?.trim() || hit.document.title?.trim() || undefined,
  );
  const claimRelationDiagnostics = requiredAnswerCues.includes("YES_NO")
    ? atomicClaimRelationDiagnostics(hit, excerpt, query)
    : null;
  const claimRelationSupport =
    claimRelationDiagnostics?.supported === true &&
    requiredAnswerCues
      .filter((cue) => cue !== "YES_NO")
      .every((cue) => boundedSupport.matchedAnswerCues.includes(cue));
  const explicitDefinitionSupport =
    boundedSupport.matchedAnswerCues.includes("DEFINITION");
  const definitionEvidenceEligible =
    !requiredAnswerCues.includes("DEFINITION") ||
    explicitDefinitionSupport ||
    definitionIdentityMatches(hit, excerpt, query);
  const conceptDefinitionSupport =
    !explicitDefinitionSupport &&
    definitionEvidenceEligible &&
    isIntroductoryConceptDefinition(hit, excerpt, query, requiredAnswerCues);
  const matchedAnswerCues = [
    ...new Set<PassageAnswerCue>([
      ...boundedSupport.matchedAnswerCues,
      ...(claimRelationSupport ? (["YES_NO"] as const) : []),
      ...(conceptDefinitionSupport ? (["DEFINITION"] as const) : []),
    ]),
  ];
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

  // A yes/no answer must still be about every explicitly named acronym.
  // The bounded evidence or its title may identify an entity; neighboring
  // document sections cannot supply an absent entity.
  const queryAcronyms = requiredAnswerCues.includes("YES_NO")
    ? (query.match(/\b[A-Z][A-Z0-9]{1,}\b/gu) ?? [])
    : [];
  const evidenceScopeTokens = new Set(
    normalizedAnswerabilityTokens(
      `${hit.title?.trim() || hit.document.title?.trim() || ""} ${excerpt}`,
    ),
  );
  const explicitAcronymsMatched = queryAcronyms.every((token) =>
    evidenceScopeTokens.has(token.toLocaleLowerCase("en-US")),
  );
  const yesNoRelationEligible =
    !requiredAnswerCues.includes("YES_NO") ||
    boundedSupport.relationRoleMatched ||
    claimRelationSupport;
  let reason: PassageSupportReason;
  if (!passage) {
    reason = "NO_CONCRETE_PASSAGE";
  } else if (!definitionEvidenceEligible) {
    reason = "ANSWER_CUE_MISMATCH";
  } else if (
    !yesNoRelationEligible &&
    requiredAnswerCues.length > matchedAnswerCues.length
  ) {
    reason = "ANSWER_CUE_MISMATCH";
  } else if (!explicitAcronymsMatched || !yesNoRelationEligible) {
    reason = "PASSAGE_SUPPORT_NOT_DEMONSTRATED";
  } else if (strongTextSupport) {
    reason = "PASSAGE_TEXT_SUPPORT";
  } else if (cueSemanticSupport) {
    reason = "PASSAGE_CUE_SUPPORT";
  } else if (claimRelationSupport) {
    reason = "CLAIM_RELATION_SUPPORT";
  } else if (conceptDefinitionSupport) {
    reason = "CONCEPT_DEFINITION_SUPPORT";
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
      reason === "PASSAGE_TEXT_SUPPORT" ||
      reason === "PASSAGE_CUE_SUPPORT" ||
      reason === "CLAIM_RELATION_SUPPORT" ||
      reason === "CONCEPT_DEFINITION_SUPPORT",
    reason,
    passageSource,
    passageCharacters: passage.length,
    excerptCharacters: excerpt.length,
    supportSurfaceExtendsExcerpt: false,
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
    claimRelationDiagnostics,
    boundedAnchorCoverage: boundedSupport.anchorCoverage,
    boundedRelationRoleMatched: boundedSupport.relationRoleMatched,
  };
}
