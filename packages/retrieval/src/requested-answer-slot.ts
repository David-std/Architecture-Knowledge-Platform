export type RequestedAnswerSlotRole =
  | "SUBJECT"
  | "OBJECT"
  | "RELATION_VALUE"
  | "LOCATION";

export type RequestedAnswerSlotLanguage = "EN" | "ES";

export interface RequestedAnswerSlotProjection {
  readonly role: RequestedAnswerSlotRole;
  readonly relationAnchor: string;
  readonly boundArgumentAnchors: readonly string[];
  readonly language: RequestedAnswerSlotLanguage;
  readonly derivation: "SURFACE_GRAMMAR";
}

const EN_INTERROGATIVES = new Set([
  "who",
  "whom",
  "whose",
  "what",
  "which",
  "where",
]);
const ES_INTERROGATIVES = new Set([
  "quien",
  "quienes",
  "que",
  "cual",
  "cuales",
  "donde",
]);

const EN_AUXILIARIES = new Set([
  "do",
  "does",
  "did",
  "can",
  "could",
  "should",
  "would",
  "must",
  "will",
]);
const ES_AUXILIARIES = new Set([
  "puede",
  "pueden",
  "debe",
  "deben",
]);

const COPULAS = new Set([
  "is",
  "are",
  "was",
  "were",
  "es",
  "son",
  "esta",
  "estan",
]);
const RELATION_PREPOSITIONS = new Set(["of", "for", "de", "del", "para"]);
const GRAMMAR_TOKENS = new Set([
  "a",
  "an",
  "the",
  "el",
  "la",
  "los",
  "las",
  "un",
  "una",
  "unos",
  "unas",
]);

function orderedSurfaceTokens(value: string): string[] {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLocaleLowerCase("und")
      .match(/[\p{L}\p{N}_-]+/gu) ?? []
  );
}

function contentAnchors(tokens: readonly string[]): string[] {
  return tokens.filter(
    (token) =>
      token.length >= 2 &&
      !GRAMMAR_TOKENS.has(token) &&
      !EN_AUXILIARIES.has(token) &&
      !ES_AUXILIARIES.has(token) &&
      !COPULAS.has(token) &&
      !RELATION_PREPOSITIONS.has(token),
  );
}

function languageFor(first: string): RequestedAnswerSlotLanguage | null {
  if (EN_INTERROGATIVES.has(first)) return "EN";
  if (ES_INTERROGATIVES.has(first)) return "ES";
  return null;
}

function copularRelationProjection(
  tokens: readonly string[],
  language: RequestedAnswerSlotLanguage,
): RequestedAnswerSlotProjection | null {
  if (tokens.length < 5 || !COPULAS.has(tokens[1]!)) return null;
  const prepositionIndex = tokens.findIndex(
    (token, index) => index > 1 && RELATION_PREPOSITIONS.has(token),
  );
  if (prepositionIndex < 3 || prepositionIndex >= tokens.length - 1) {
    return null;
  }
  const relationPhrase = contentAnchors(tokens.slice(2, prepositionIndex));
  const relationAnchor = relationPhrase.at(-1);
  const boundArgumentAnchors = contentAnchors(
    tokens.slice(prepositionIndex + 1),
  );
  if (!relationAnchor || boundArgumentAnchors.length === 0) return null;
  return {
    role: "RELATION_VALUE",
    relationAnchor,
    boundArgumentAnchors,
    language,
    derivation: "SURFACE_GRAMMAR",
  };
}

function auxiliaryObjectProjection(
  tokens: readonly string[],
  language: RequestedAnswerSlotLanguage,
): RequestedAnswerSlotProjection | null {
  const auxiliaries = language === "EN" ? EN_AUXILIARIES : ES_AUXILIARIES;
  const auxiliaryIndex = tokens.findIndex(
    (token, index) => index > 0 && auxiliaries.has(token),
  );
  if (auxiliaryIndex < 1) return null;
  const after = tokens.slice(auxiliaryIndex + 1);
  if (after.length < 2) return null;
  const subjectAnchor = contentAnchors(after.slice(0, 1))[0];
  const relationAnchor = contentAnchors(after.slice(1, 2))[0];
  const tail = contentAnchors(after.slice(2));
  if (!subjectAnchor || !relationAnchor) return null;
  return {
    role: tokens[0] === "where" || tokens[0] === "donde" ? "LOCATION" : "OBJECT",
    relationAnchor,
    boundArgumentAnchors: [subjectAnchor, ...tail],
    language,
    derivation: "SURFACE_GRAMMAR",
  };
}

function directSubjectProjection(
  tokens: readonly string[],
  language: RequestedAnswerSlotLanguage,
): RequestedAnswerSlotProjection | null {
  const first = tokens[0]!;
  if (first === "who" || first === "whom" || first === "quien" || first === "quienes") {
    const relationAnchor = contentAnchors(tokens.slice(1, 2))[0];
    const boundArgumentAnchors = contentAnchors(tokens.slice(2));
    if (!relationAnchor || boundArgumentAnchors.length === 0) return null;
    return {
      role: "SUBJECT",
      relationAnchor,
      boundArgumentAnchors,
      language,
      derivation: "SURFACE_GRAMMAR",
    };
  }

  if (
    first === "which" ||
    first === "what" ||
    first === "que" ||
    first === "cual" ||
    first === "cuales"
  ) {
    const descriptor = contentAnchors(tokens.slice(1, 2))[0];
    const relationAnchor = contentAnchors(tokens.slice(2, 3))[0];
    const boundArgumentAnchors = contentAnchors(tokens.slice(3));
    if (!descriptor || !relationAnchor || boundArgumentAnchors.length === 0) {
      return null;
    }
    return {
      role: "SUBJECT",
      relationAnchor,
      boundArgumentAnchors,
      language,
      derivation: "SURFACE_GRAMMAR",
    };
  }
  return null;
}

function directLocationProjection(
  tokens: readonly string[],
  language: RequestedAnswerSlotLanguage,
): RequestedAnswerSlotProjection | null {
  if (tokens[0] !== "donde") return null;
  const relationAnchor = contentAnchors(tokens.slice(1, 2))[0];
  const boundArgumentAnchors = contentAnchors(tokens.slice(2));
  if (!relationAnchor || boundArgumentAnchors.length === 0) return null;
  return {
    role: "LOCATION",
    relationAnchor,
    boundArgumentAnchors,
    language,
    derivation: "SURFACE_GRAMMAR",
  };
}

/**
 * Projects only bounded open-slot surface grammars.
 *
 * This helper does not infer synonymy, semantic roles, entity types or
 * evidence support. Unsupported/ambiguous question forms fail closed.
 */
export function projectRequestedAnswerSlot(
  query: string,
): RequestedAnswerSlotProjection | null {
  const tokens = orderedSurfaceTokens(query);
  if (tokens.length < 3) return null;
  const language = languageFor(tokens[0]!);
  if (!language) return null;

  const first = tokens[0]!;
  if (
    first === "why" ||
    first === "how" ||
    first === "when" ||
    first === "como" ||
    first === "cuando"
  ) {
    return null;
  }

  return (
    copularRelationProjection(tokens, language) ??
    auxiliaryObjectProjection(tokens, language) ??
    directLocationProjection(tokens, language) ??
    directSubjectProjection(tokens, language)
  );
}
