import type {
  QueryTransformerPort,
  QueryTransformationInput,
  QueryTransformationResult,
} from "./query-transform.js";

/**
 * Shadow-only query-to-candidate expansion. It cannot certify a source,
 * substitute for question answering, or admit an answer.
 *
 * A high-signal anchor and two original query terms form a narrow lexical
 * probe. The original query is always searched by the retrieval host.
 * This transformer supplies supplementary candidate probes only.
 */
export const S2_QUESTION_CANDIDATE_TRANSFORMER_ID =
  "s2-bounded-question-candidate-probes-v1";

const FUNCTION_TOKENS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "is",
  "it",
  "many",
  "much",
  "of",
  "on",
  "or",
  "the",
  "their",
  "to",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "who",
  "whose",
  "why",
  "will",
  "with",
  "would",
  "about",
  "its",
  "them",
  "a",
  "al",
  "de",
  "del",
  "donde",
  "dónde",
  "el",
  "en",
  "es",
  "esta",
  "está",
  "estas",
  "estos",
  "la",
  "las",
  "los",
  "más",
  "más",
  "muchos",
  "muchas",
  "cuántos",
  "cuantas",
  "cuántas",
  "cuánto",
  "cuanto",
  "para",
  "por",
  "que",
  "qué",
  "se",
  "son",
  "su",
  "sus",
  "un",
  "una",
  "unas",
  "unos",
  "y",
]);

const SCOPE_MODIFIERS = new Set([
  "not",
  "never",
  "without",
  "unless",
  "except",
  "only",
  "no",
  "nunca",
  "jamás",
  "sin",
  "salvo",
  "excepto",
  "únicamente",
  "solamente",
  "ninguno",
  "ninguna",
  "antes",
  "después",
  "before",
  "after",
  "si",
  "sí",
  "solo",
  "sólo",
  "more",
  "less",
  "higher",
  "lower",
  "greater",
  "fewer",
  "than",
  "más",
  "menos",
  "mayor",
  "menor",
]);
const TOKEN = /[\p{L}\p{N}][\p{L}\p{M}\p{N}_:./-]*/gu;

export class S2BoundedQuestionCandidateTransformer implements QueryTransformerPort {
  readonly id = S2_QUESTION_CANDIDATE_TRANSFORMER_ID;
  readonly kind = "MULTI_QUERY" as const;

  async transform(
    input: QueryTransformationInput,
  ): Promise<QueryTransformationResult> {
    const originalQuery = input.originalQuery.replace(/\s+/gu, " ").trim();
    const result: QueryTransformationResult = {
      transformerId: this.id,
      originalQuery,
      variants: [],
    };
    if (!originalQuery || originalQuery.length > 4096) return result;
    const cap = input.maxVariants ?? 2;
    if (!Number.isSafeInteger(cap) || cap < 1 || cap > 8) return result;
    const tokens = [...originalQuery.matchAll(TOKEN)].map((m) => m[0]);
    if (tokens.length < 4 || tokens.length > 48) return result;
    if (tokens.some((t) => SCOPE_MODIFIERS.has(t.toLocaleLowerCase())))
      return result;

    const anchors = tokens.filter(
      (term) =>
        /^[\p{Lu}]/u.test(term) &&
        /[\p{L}]/u.test(term) &&
        !FUNCTION_TOKENS.has(term.toLocaleLowerCase()),
    );
    // Multiple guessed proper names may bind unrelated sources. Abstain
    // rather than choosing the wrong subject.
    if (anchors.length !== 1) return result;
    const anchor = anchors[0]!;
    const other = tokens.filter(
      (token) =>
        token !== anchor && !FUNCTION_TOKENS.has(token.toLocaleLowerCase()),
    );
    if (other.length < 2) return result;
    const requiredNumbers = tokens.filter((t) => /\p{N}/u.test(t));
    // Numeric identifiers and exact quantities must never be dropped by
    // candidate expansion. We do not reformat or derive them.
    const groups = [other.slice(0, 2), other.slice(-2)];
    const seen = new Set<string>();
    for (const terms of groups) {
      const queryTokens = [anchor, ...terms];
      if (requiredNumbers.some((v) => !queryTokens.includes(v))) continue;
      const query = queryTokens.join(" ");
      const key = query.toLocaleLowerCase();
      if (key === originalQuery.toLocaleLowerCase() || seen.has(key)) continue;
      seen.add(key);
      result.variants.push({
        ordinal: result.variants.length + 1,
        kind: this.kind,
        query,
        reason:
          "DEV_SHADOW_ONLY: original query tokens; candidate recall, never proof",
      });
      if (result.variants.length >= cap) break;
    }
    return result;
  }
}
