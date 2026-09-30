import { normalizedAnswerabilityTokens } from "./support-verifier.js";

export const ASSERTION_RECALL_SELECTION_MARKER = "lexical:assertion-recall:";

export function boundedAssertionRecallQuery(query: string): string | null {
  const terms = normalizedAnswerabilityTokens(query)
    .filter((term) => term.length >= 3 && term.length <= 64)
    .slice(0, 24);
  return terms.length > 1 ? terms.join(" | ") : null;
}

export function assertionRecallSelectionReason(reason: string): string {
  return `${ASSERTION_RECALL_SELECTION_MARKER}${reason}`;
}

export function isAssertionRecallSelectionReason(
  reason: string | null | undefined,
): boolean {
  return (
    typeof reason === "string" &&
    reason.includes(ASSERTION_RECALL_SELECTION_MARKER)
  );
}
