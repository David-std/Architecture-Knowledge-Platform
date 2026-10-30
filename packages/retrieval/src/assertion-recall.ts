export const ASSERTION_RECALL_SELECTION_MARKER = "lexical:assertion-recall:";

export function boundedAssertionRecallQuery(query: string): string | null {
  // PostgreSQL's simple dictionary retains accents. Query lexemes must use
  // the same representation, rather than the semantic verifier's accent fold.
  const terms = [
    ...new Set(
      query
        .normalize("NFC")
        .toLocaleLowerCase("en-US")
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ]
    .filter((term) => term.length >= 3 && term.length <= 64)
    .slice(0, 24);
  return terms.length > 1 ? terms.join(" | ") : null;
}

export function assertionRecallSelectionReason(reason: string): string {
  return ASSERTION_RECALL_SELECTION_MARKER + reason;
}

export function isAssertionRecallSelectionReason(
  reason: string | null | undefined,
): boolean {
  return (
    typeof reason === "string" &&
    reason.includes(ASSERTION_RECALL_SELECTION_MARKER)
  );
}

/**
 * Candidate-only first-stage recall of non-claim Markdown units when the full
 * natural-language query has too many required lexemes. Require two distinct
 * significant original query tokens within one indexed unit's searchable
 * fields (not merely across different document units). A matching index
 * row is still NOT proof of an original SOURCE span. Do not stem, translate, infer synonyms or
 * declare an entailment relationship from this query.
 *
 * This bounded 2-of-N tsquery is deliberately opt-in at the queryKnowledge
 * library boundary. It must not bypass caller ACL, source revision or Reader
 * verification, and should be compared on frozen EN/ES source-unit qrels
 * before any runtime promotion.
 */
export const BOUNDED_UNIT_RECALL_SELECTION_MARKER =
  "lexical:bounded-unit-recall:";

export function boundedUnitLexicalRecallQuery(query: string): string | null {
  const tokens = [
    ...new Set(
      query
        .normalize("NFC")
        .toLocaleLowerCase("en-US")
        .match(/[\p{L}\p{N}]+/gu) ?? [],
    ),
  ]
    .filter((token) => token.length >= 4 && token.length <= 64)
    .slice(0, 8);
  if (tokens.length < 2) return null;
  const pairs: string[] = [];
  for (let left = 0; left < tokens.length; left++)
    for (let right = left + 1; right < tokens.length; right++)
      pairs.push(`(${tokens[left]} & ${tokens[right]})`);
  return pairs.join(" | ");
}
