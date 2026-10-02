import type { SearchHit } from "@akp/contracts";
import {
  markdownTableEvidence,
  type MarkdownSourceSpan,
} from "./markdown-table-evidence.js";
import { markdownVisibleSource } from "./markdown-visible-source.js";

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
  "who",
  "whom",
  "whose",
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
  "donde",
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
  "quien",
  "quienes",
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
  "where",
  "who",
  "whom",
  "whose",
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
  "that",
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
    (token) => !ANSWERABILITY_STOPWORDS.has(token),
  );
  // In an inverted question, do/does precedes the subject; it is not
  // part of the asserted relation in the evidence clause.
  if (queryTokens[0] === "do" || queryTokens[0] === "does") {
    queryTokens.shift();
  }
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

function definitionExcerptAnchorsMatch(
  excerpt: string,
  query: string,
): boolean {
  const anchors = queryPredicateAnchors(query, ["DEFINITION"]);
  if (anchors.length === 0) return false;
  const excerptTokens = new Set(semanticTokens(excerpt));
  const overlap = anchors.filter((token) => excerptTokens.has(token));
  return (
    overlap.length >= Math.min(2, anchors.length) &&
    overlap.length / anchors.length >= 0.6
  );
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
  const evidenceIsQuestion = isInterrogativeEvidence(excerpt);
  const supported =
    eligibleClaim &&
    !evidenceIsQuestion &&
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

  // An infinitive-led question still asks whether its relation holds.
  // It must not fall through to thematic token overlap.
  if (
    cues.size === 0 &&
    query.trim().endsWith("?") &&
    !QUESTION_SHAPE_TOKENS.has(tokens[0] ?? "")
  ) {
    cues.add("YES_NO");
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

function isInterrogativeEvidence(value: string): boolean {
  return /[?？؟][\p{Pe}\p{Pf}"'`*_]*\s*$/u.test(value.trim());
}

function withoutInterrogativeSentences(value: string): string {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return value
    .split(/\n+/u)
    .flatMap((line) =>
      [...segmenter.segment(line)].map((part) => part.segment.trim()),
    )
    .filter((sentence) => sentence && !isInterrogativeEvidence(sentence))
    .join("\n");
}
interface PassageWindow {
  text: string;
  evidence: string;
  scopeTitle?: string;
  structuralAnswerCues?: readonly PassageAnswerCue[];
  /**
   * Quantity evidence may be narrower than the rendered context. Table
   * headers and row labels identify a value but must never count as that
   * value themselves.
   */
  quantityEvidence?: string;
}

function withoutReferenceMarkup(passage: string): string {
  return passage
    .replace(/\[\[[^\]]+\]\]/gu, " ")
    .replace(/\[[^\]]+\]\([^)]*\)/gu, " ");
}

const TABLE_CONDITION_HEADER_PATTERNS = [
  ...QUERY_CUE_PATTERNS.CONDITION,
  ...PASSAGE_CUE_PATTERNS.CONDITION,
  "situation*",
  "situacion*",
] as const;

const TABLE_DECISION_HEADER_PATTERNS = ["decision*"] as const;

function tableHeaderMatches(
  value: string,
  patterns: readonly string[],
): boolean {
  const normalized = normalizedMatchText(value);
  const tokens = normalizedAnswerabilityTokens(value);
  if (patterns === TABLE_DECISION_HEADER_PATTERNS && tokens.length !== 1) {
    return false;
  }
  return patterns.some((pattern) =>
    patternMatches(normalized, tokens, pattern),
  );
}

function tableConditionWindows(
  passage: string,
  query: string,
): PassageWindow[] {
  const anchors = queryPredicateAnchors(query, ["CONDITION"]);
  const requiredAnchorOverlap = Math.min(2, Math.max(1, anchors.length));

  return markdownTableEvidence(passage).flatMap((table) => {
    const conditionColumns = new Set(
      table.header.cells
        .filter((cell) =>
          tableHeaderMatches(cell.source, TABLE_CONDITION_HEADER_PATTERNS),
        )
        .map((cell) => cell.columnIndex),
    );
    const decisionColumns = new Set(
      table.header.cells
        .filter((cell) =>
          tableHeaderMatches(cell.source, TABLE_DECISION_HEADER_PATTERNS),
        )
        .map((cell) => cell.columnIndex),
    );
    if (
      conditionColumns.size !== 1 ||
      decisionColumns.size !== 1 ||
      [...conditionColumns].some((column) => decisionColumns.has(column))
    )
      return [];

    return table.rows.flatMap((row) => {
      const conditionText = row.cells
        .filter((cell) => conditionColumns.has(cell.columnIndex))
        .map((cell) => cell.source)
        .join(" ")
        .trim();
      const decisionText = row.cells
        .filter((cell) => decisionColumns.has(cell.columnIndex))
        .map((cell) => cell.source)
        .join(" ")
        .trim();
      if (
        !conditionText ||
        !decisionText ||
        isInterrogativeEvidence(decisionText)
      )
        return [];

      const decisionTokens = new Set(semanticTokens(decisionText));
      const overlap = anchors.filter((token) => decisionTokens.has(token));
      const anchorCoverage =
        anchors.length === 0 ? 0 : overlap.length / anchors.length;
      if (overlap.length < requiredAnchorOverlap || anchorCoverage < 0.4) {
        return [];
      }

      return [
        {
          text: table.header.source.concat(String.fromCharCode(10), row.source),
          evidence: row.source,
          structuralAnswerCues: ["CONDITION"] as const,
        },
      ];
    });
  });
}

interface TablePeriodAxis {
  orientation: "COLUMNS" | "ROWS";
  periodColumn?: number;
  periods: Map<string, MarkdownTableCellLike>;
}

interface MarkdownTableCellLike {
  readonly columnIndex: number;
  readonly source: string;
}

interface StructuredQuantityWindows {
  windows: PassageWindow[];
  tableSpans: MarkdownSourceSpan[];
}

/**
 * Code literals can contain pipe-delimited text that looks like a table to a
 * line based scanner. Keep them out of the prose fallback while preserving
 * line offsets for the real-table AST spans above.
 */
function maskMarkdownCodeLiterals(value: string): string {
  return value
    .replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/gu, (block) =>
      block.replace(/[^\n]/gu, " "),
    )
    .replace(/`[^`\n]*`/gu, (literal) => literal.replace(/[^\n]/gu, " "));
}

function uniqueExplicitYears(value: string): string[] {
  return [...new Set(explicitYearValues(value))];
}

function standaloneTableYear(value: string): string | null {
  const years = uniqueExplicitYears(value);
  const tokens = normalizedAnswerabilityTokens(value);
  return years.length === 1 && tokens.length === 1 && tokens[0] === years[0]
    ? years[0]!
    : null;
}

function tableHeaderLooksTemporal(value: string): boolean {
  return semanticTokens(value).some((token) =>
    ["year", "date", "period", "ano", "fecha"].includes(token),
  );
}

function tableCellContainsQuantity(
  value: string,
  query: string,
  scope: string = value,
): boolean {
  return (
    value.trim().length > 0 && quantitativeEvidenceMatches(value, query, scope)
  );
}

function inspectTablePeriodHeaders(table: {
  header: { cells: readonly MarkdownTableCellLike[] };
}): {
  periods: Map<string, MarkdownTableCellLike>;
  hasTemporalTokens: boolean;
  ambiguous: boolean;
} {
  const periods = new Map<string, MarkdownTableCellLike>();
  let hasTemporalTokens = false;
  let ambiguous = false;
  for (const cell of table.header.cells) {
    const year = standaloneTableYear(cell.source);
    if (!year) continue;
    hasTemporalTokens = true;
    if (periods.has(year)) {
      ambiguous = true;
      continue;
    }
    periods.set(year, cell);
  }
  return { periods, hasTemporalTokens, ambiguous };
}

function inspectTablePeriodRows(table: {
  header: { cells: readonly MarkdownTableCellLike[] };
  rows: readonly {
    cells: readonly MarkdownTableCellLike[];
  }[];
}): {
  axis: TablePeriodAxis | null;
  hasTemporalTokens: boolean;
  ambiguous: boolean;
} {
  const hasTemporalTokens = table.rows.some((row) =>
    row.cells.some((cell) => {
      if (standaloneTableYear(cell.source) === null) return false;
      if (table.rows.length >= 2) return true;
      const headerCell = table.header.cells.find(
        (candidate) => candidate.columnIndex === cell.columnIndex,
      );
      return (
        (row.cells.length > 1 && cell.columnIndex === 0) ||
        tableHeaderLooksTemporal(headerCell?.source ?? "")
      );
    }),
  );
  // A row-oriented period axis needs more than one body row. With one row,
  // an ordinary metric value such as "launch year: 2023" is structurally
  // indistinguishable from a transposed table key.
  if (table.rows.length < 2) {
    return { axis: null, hasTemporalTokens, ambiguous: false };
  }

  const columnCount = Math.max(
    table.header.cells.length,
    ...table.rows.map((row) => row.cells.length),
  );
  const candidates: TablePeriodAxis[] = [];
  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const periods = new Map<string, MarkdownTableCellLike>();
    let valid = true;
    for (const row of table.rows) {
      const cell = row.cells.find((candidate) =>
        candidate.columnIndex === columnIndex,
      );
      const year = cell ? standaloneTableYear(cell.source) : null;
      if (!cell || !year || periods.has(year)) {
        valid = false;
        break;
      }
      periods.set(year, cell);
    }
    if (valid && periods.size === table.rows.length) {
      candidates.push({ orientation: "ROWS", periodColumn: columnIndex, periods });
    }
  }
  return {
    axis: candidates.length === 1 ? candidates[0]! : null,
    hasTemporalTokens,
    ambiguous: candidates.length > 1,
  };
}

function quantityMetricAnchors(query: string): string[] {
  const years = new Set(explicitYearValues(query));
  return queryPredicateAnchors(query, ["QUANTITY"]).filter(
    (token) => !years.has(token),
  );
}

function tableLabelText(
  cells: readonly MarkdownTableCellLike[],
  excludedColumns: ReadonlySet<number>,
  query: string,
): string {
  return cells
    .filter(
      (cell) =>
        !excludedColumns.has(cell.columnIndex) &&
        !tableCellContainsQuantity(cell.source, query),
    )
    .map((cell) => cell.source.trim())
    .filter(Boolean)
    .join(" ");
}

function selectUniqueTableRow(
  rows: readonly { cells: readonly MarkdownTableCellLike[] }[],
  query: string,
  excludedColumns: ReadonlySet<number>,
): { cells: readonly MarkdownTableCellLike[] } | null {
  if (rows.length === 0) return null;
  const anchors = quantityMetricAnchors(query);
  const scored = rows.map((row) => {
    const label = tableLabelText(row.cells, excludedColumns, query);
    const tokens = new Set(semanticTokens(label));
    return {
      row,
      score: anchors.filter((anchor) => tokens.has(anchor)).length,
    };
  });
  const maximum = Math.max(...scored.map((candidate) => candidate.score));
  const best = scored.filter((candidate) => candidate.score === maximum);
  if (rows.length === 1 && anchors.length === 0) return rows[0]!;
  const minimumRowAnchorOverlap = Math.min(2, Math.max(1, anchors.length));
  if (maximum < minimumRowAnchorOverlap || best.length !== 1) return null;
  return best[0]!.row;
}

function selectUniqueMetricColumn(
  table: {
    header: { source: string; cells: readonly MarkdownTableCellLike[] };
    rows: readonly { cells: readonly MarkdownTableCellLike[] }[];
  },
  periodColumn: number,
  query: string,
  requestedPeriods: readonly string[],
): MarkdownTableCellLike | null {
  const candidates = table.header.cells.filter(
    (cell) => cell.columnIndex !== periodColumn,
  );
  if (candidates.length === 0) return null;
  const anchors = quantityMetricAnchors(query);
  const scored = candidates.map((cell) => ({
    cell,
    score: anchors.filter((anchor) =>
      semanticTokens(cell.source).includes(anchor),
    ).length,
  }));
  const maximum = Math.max(...scored.map((candidate) => candidate.score));
  if (maximum > 0) {
    const best = scored.filter((candidate) => candidate.score === maximum);
    const minimumMetricAnchorOverlap = Math.min(2, Math.max(1, anchors.length));
    return maximum >= minimumMetricAnchorOverlap && best.length === 1
      ? best[0]!.cell
      : null;
  }

  const numeric = candidates.filter((candidate) =>
    requestedPeriods.some((period) => {
      const row = table.rows.find(
        (candidateRow) =>
          standaloneTableYear(
            candidateRow.cells.find(
              (cell) => cell.columnIndex === periodColumn,
            )?.source ?? "",
          ) === period,
      );
      const rowLabel = row
        ? tableLabelText(row.cells, new Set([periodColumn]), query)
        : "";
      return tableCellContainsQuantity(
        row?.cells.find((cell) => cell.columnIndex === candidate.columnIndex)
          ?.source ?? "",
        query,
        `${candidate.source} ${table.header.source} ${rowLabel}`,
      );
    }),
  );
  if (numeric.length === 1) return numeric[0]!;
  return candidates.length === 1 ? candidates[0]! : null;
}

function tableQuantityWindow(
  table: {
    header: { source: string; cells: readonly MarkdownTableCellLike[] };
    rows: readonly {
      source: string;
      cells: readonly MarkdownTableCellLike[];
    }[];
  },
  query: string,
  title: string | undefined,
): PassageWindow[] {
  const requestedPeriods = explicitYearValues(query);
  if (requestedPeriods.length === 0) return [];

  const headerAxis = inspectTablePeriodHeaders(table);
  const rowAxis = inspectTablePeriodRows(table);
  const hasTemporalTokens =
    headerAxis.hasTemporalTokens || rowAxis.hasTemporalTokens;
  if (headerAxis.ambiguous || rowAxis.ambiguous) return [];
  if (headerAxis.periods.size > 0 && rowAxis.axis) return [];

  if (headerAxis.periods.size > 0) {
    if (requestedPeriods.some((period) => !headerAxis.periods.has(period))) {
      return [];
    }
    const periodColumns = new Set(
      requestedPeriods.map((period) => headerAxis.periods.get(period)!.columnIndex),
    );
    const row = selectUniqueTableRow(table.rows, query, periodColumns);
    if (!row) return [];
    const label = tableLabelText(row.cells, periodColumns, query);
    const values = requestedPeriods.map((period) => {
      const periodCell = headerAxis.periods.get(period)!;
      const valueCell = row.cells.find(
        (cell) => cell.columnIndex === periodCell.columnIndex,
      );
      return valueCell &&
        tableCellContainsQuantity(
          valueCell.source,
          query,
          `${table.header.source} ${label}`,
        )
        ? { periodCell, valueCell }
        : null;
    });
    if (values.some((value) => value === null)) return [];
    const context = [
      label,
      ...values.map(
        (value) => `${value!.periodCell.source}: ${value!.valueCell.source}`,
      ),
    ]
      .filter(Boolean)
      .join("\n");
    return [
      {
        text: context,
        evidence: values.map((value) => value!.valueCell.source).join("\n"),
        quantityEvidence: [
          table.header.source,
          label,
          ...values.map((value) => value!.valueCell.source),
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];
  }

  if (rowAxis.axis) {
    const axis = rowAxis.axis;
    if (requestedPeriods.some((period) => !axis.periods.has(period))) {
      return [];
    }
    const metricHeader = selectUniqueMetricColumn(
      table,
      axis.periodColumn!,
      query,
      requestedPeriods,
    );
    if (!metricHeader) return [];
    const values = requestedPeriods.map((period) => {
      const periodCell = axis.periods.get(period)!;
      const row = table.rows.find((candidateRow) =>
        candidateRow.cells.some(
          (cell) =>
            cell.columnIndex === axis.periodColumn &&
            cell.source === periodCell.source,
        ),
      );
      const valueCell = row?.cells.find(
        (cell) => cell.columnIndex === metricHeader.columnIndex,
      );
      const label = row
        ? tableLabelText(row.cells, new Set([axis.periodColumn!]), query)
        : "";
      return valueCell &&
        tableCellContainsQuantity(
          valueCell.source,
          query,
          `${metricHeader.source} ${table.header.source} ${label}`,
        )
        ? { periodCell, valueCell }
        : null;
    });
    if (values.some((value) => value === null)) return [];
    const context = [
      metricHeader.source,
      ...values.map(
        (value) => `${value!.periodCell.source}: ${value!.valueCell.source}`,
      ),
    ]
      .filter(Boolean)
      .join("\n");
    return [
      {
        text: context,
        evidence: values.map((value) => value!.valueCell.source).join("\n"),
        quantityEvidence: [
          metricHeader.source,
          table.header.source,
          ...values.map((value) => value!.valueCell.source),
        ]
          .filter(Boolean)
          .join("\n"),
      },
    ];
  }

  // A title can qualify a table only when the table has no period tokens of
  // its own. The title never supplies the quantity; it only supplies scope.
  if (hasTemporalTokens || !title || !explicitYearBindingsMatch(title, query)) {
    return [];
  }
  const row = selectUniqueTableRow(table.rows, query, new Set());
  if (!row) return [];
  const label = tableLabelText(row.cells, new Set(), query);
  const valueCells = row.cells.filter((cell) =>
    tableCellContainsQuantity(
      cell.source,
      query,
      `${title} ${table.header.source} ${label}`,
    ),
  );
  if (valueCells.length !== 1) return [];
  return [
    {
      text: [title, label, valueCells[0]!.source]
        .filter(Boolean)
        .join("\n"),
      evidence: valueCells[0]!.source,
      quantityEvidence: [title, table.header.source, label, valueCells[0]!.source]
        .filter(Boolean)
        .join("\n"),
      scopeTitle: title,
    },
  ];
}

function tableQuantityWindows(
  passage: string,
  query: string,
  title?: string,
): StructuredQuantityWindows | null {
  const tables = markdownTableEvidence(passage);
  const hasCodeLiteral = /```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`/u.test(
    passage,
  );
  if (tables.length === 0 && !hasCodeLiteral) return null;
  return {
    windows: tables.flatMap((table) => tableQuantityWindow(table, query, title)),
    tableSpans: tables.map((table) => table.span),
  };
}

function removeTableSpans(
  passage: string,
  spans: readonly MarkdownSourceSpan[],
): string {
  if (spans.length === 0) return maskMarkdownCodeLiterals(passage);
  const ordered = [...spans].sort((left, right) => left.startOffset - right.startOffset);
  let cursor = 0;
  let output = "";
  for (const span of ordered) {
    if (span.startOffset < cursor) continue;
    output += passage.slice(cursor, span.startOffset);
    output += passage.slice(span.startOffset, span.endOffset).replace(/[^\n]/gu, " ");
    cursor = span.endOffset;
  }
  return maskMarkdownCodeLiterals(output + passage.slice(cursor));
}

function passageWindows(passage: string, title?: string): PassageWindow[] {
  // Evidence for an answer predicate must stay local. A unit title may scope a
  // sentence, and an adjacent sentence may be joined only when it explicitly
  // refers back to its predecessor. For relation questions, the title may
  // identify the subject but cannot supply the predicate or object.
  // A link to a proposition is a pointer, not an assertion of its content.
  const evidentialPassage = withoutReferenceMarkup(passage);
  const sentences = evidentialPassage
    .split(/(?<=[.!?])\s+|\n+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((sentence) => sentence.slice(0, 900).trim())
    .filter((sentence) => !isInterrogativeEvidence(sentence));
  const boundedSentences = sentences;
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

export function quantitativeEvidenceMatches(
  window: string,
  query: string,
  scope: string = window,
): boolean {
  const hasNumber =
    /(?:^|[\s([:;=|])(?:[$€£S\/]\s*)?[-+]?(?:(?:\d{1,3}(?:[,\s]\d{3})+)|\d+)(?:[.,]\d+)?(?:\s*%|\b)/u.test(
      window,
    );
  if (!hasNumber) return false;
  const normalizedQuery = normalizedMatchText(query);
  const normalizedWindow = normalizedMatchText(scope);
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

export function dateYearEvidenceMatches(
  window: string,
  query: string,
): boolean {
  const normalizedQuery = normalizedMatchText(query);
  const asksYear = /\b(year|ano)\b/u.test(normalizedQuery);
  if (asksYear) return /\b(?:19|20)\d{2}\b/u.test(window);
  return (
    /\b(?:19|20)\d{2}\b/u.test(window) ||
    /\b\d{1,2}[\/-]\d{1,2}[\/-](?:\d{2}|\d{4})\b/u.test(window)
  );
}

export function explicitYearValues(value: string): string[] {
  return normalizedAnswerabilityTokens(value).filter((token) => {
    const year = Number(token);
    return Number.isInteger(year) && year >= 1900 && year <= 2099;
  });
}

export function explicitYearBindingsMatch(
  scope: string,
  query: string,
): boolean {
  const requested = explicitYearValues(query);
  if (requested.length === 0) return true;
  const available = new Set(normalizedAnswerabilityTokens(scope));
  return requested.every((year) => available.has(year));
}

function answerRequirementsMatch(
  window: string,
  query: string,
  required: readonly PassageAnswerCue[],
  relationEvidence: string = window,
  relationScopeTitle?: string,
  structuralAnswerCues: readonly PassageAnswerCue[] = [],
  quantityEvidence: string = window,
): {
  matched: PassageAnswerCue[];
  allMatched: boolean;
  relationRoleMatched: boolean;
} {
  const genericRequired = required.filter(
    (cue) => cue !== "YES_NO" && cue !== "QUANTITY" && cue !== "DATE_YEAR",
  );
  const genericMatched = passageAnswerCues(window, genericRequired);
  const matched = new Set<PassageAnswerCue>([
    ...genericMatched,
    ...structuralAnswerCues.filter((cue) => required.includes(cue)),
  ]);

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
    quantitativeEvidenceMatches(quantityEvidence, query)
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
  // An interrogative sentence can state the same subject, predicate and object
  // as the query without asserting that the relation is true. Questions are
  // therefore never evidence for a YES_NO proposition by themselves.
  const relationEvidenceIsQuestion = isInterrogativeEvidence(relationEvidence);
  if (required.includes("YES_NO") && !relationEvidenceIsQuestion) {
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
  allowStructuredTableCondition = false,
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

  const explicitPeriodQuantity =
    required.includes("QUANTITY") && explicitYearValues(query).length > 0;
  const structuredQuantity = explicitPeriodQuantity
    ? tableQuantityWindows(passage, query, title)
    : null;
  const windows =
    allowStructuredTableCondition && required.includes("CONDITION")
      ? tableConditionWindows(passage, query)
      : structuredQuantity
        ? [
            ...structuredQuantity.windows,
            ...passageWindows(
              removeTableSpans(passage, structuredQuantity.tableSpans),
              title,
            ),
          ]
        : passageWindows(passage, title);

  for (const window of windows) {
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
      window.structuralAnswerCues,
      window.quantityEvidence,
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
  const excerpt = markdownVisibleSource(hit.excerpt).text.trim();
  const sourcePassage = withoutReferenceMarkup(excerpt).trim();
  const passage =
    hit.unitType === "TABLE"
      ? sourcePassage
      : withoutInterrogativeSentences(sourcePassage);
  const passageSource = "EXCERPT" as const;
  const explicitYearsMatched = explicitYearBindingsMatch(
    `${hit.title?.trim() || hit.document.title?.trim() || ""} ${passage}`,
    query,
  );
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
  const structuredTableCondition =
    hit.unitType === "TABLE" && requiredAnswerCues.includes("CONDITION");
  const tableSupportEligible =
    !structuredTableCondition || isSupportEligibleProposition(hit);
  const boundedSupport = boundedPredicateSupport(
    passage,
    query,
    requiredAnswerCues,
    structuredTableCondition
      ? undefined
      : hit.title?.trim() || hit.document.title?.trim() || undefined,
    structuredTableCondition,
  );
  const claimRelationDiagnostics = requiredAnswerCues.includes("YES_NO")
    ? atomicClaimRelationDiagnostics(hit, passage, query)
    : null;
  const claimRelationSupport =
    claimRelationDiagnostics?.supported === true &&
    requiredAnswerCues
      .filter((cue) => cue !== "YES_NO")
      .every((cue) => boundedSupport.matchedAnswerCues.includes(cue));
  const explicitDefinitionSupport =
    boundedSupport.matchedAnswerCues.includes("DEFINITION") &&
    definitionExcerptAnchorsMatch(passage, query);
  const definitionEvidenceEligible =
    !requiredAnswerCues.includes("DEFINITION") ||
    explicitDefinitionSupport ||
    definitionIdentityMatches(hit, passage, query);
  const conceptDefinitionSupport =
    !explicitDefinitionSupport &&
    definitionEvidenceEligible &&
    isIntroductoryConceptDefinition(hit, passage, query, requiredAnswerCues);
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
      `${hit.title?.trim() || hit.document.title?.trim() || ""} ${passage}`,
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
  // Reference markup may leave punctuation behind. Titles can scope real
  // assertions, but cannot turn a bare period or list marker into evidence.
  if (
    ![...passageTokens].some((token) => !ANSWERABILITY_STOPWORDS.has(token))
  ) {
    reason = "NO_CONCRETE_PASSAGE";
  } else if (!explicitYearsMatched) {
    reason = "PASSAGE_SUPPORT_NOT_DEMONSTRATED";
  } else if (!tableSupportEligible) {
    reason = "PASSAGE_SUPPORT_NOT_DEMONSTRATED";
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
