/**
 * Shadow-only answer-value to projected-claim surface binding.
 * The claim projector can echo the requested answer accurately while dropping
 * or replacing it in its declarative claim. This check exposes that failure.
 * A bound value is a necessary lexical observation for *some* answer types,
 * never sufficient proof of role fidelity, entailment or citation support.
 * Missing literal values can be correct paraphrases, translations and yes/no
 * responses, so this diagnostic MUST NOT act as a generic semantic veto.
 */
export interface S2ClaimAnswerAnchor {
  readonly status:
    | "UNIQUE_LITERAL_VALUE"
    | "REPEATED_LITERAL_VALUE"
    | "LITERAL_VALUE_NOT_FOUND"
    | "BOOLEAN_VALUE_REQUIRES_SEMANTIC_REWRITE"
    | "REJECTED";
  readonly reason: string;
  /** Coordinates in the unmodified declarative claim; only for a unique literal. */
  readonly startUtf16: number | null;
  readonly endUtf16: number | null;
  readonly claimEquivalenceVerified: false;
  readonly sourceEntailmentVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

const word = /[\p{L}\p{M}\p{N}_]/u;
const booleanAnswer = /^(?:yes|no|sí|si|true|false|verdadero|falso)$/iu;
function boundary(body: string, start: number, end: number): boolean {
  const before = start > 0 ? [...body.slice(0, start)].at(-1) : undefined;
  const after = end < body.length ? [...body.slice(end)][0] : undefined;
  const first = [...body.slice(start, end)][0];
  const last = [...body.slice(start, end)].at(-1);
  return (
    !(first && word.test(first) && before && word.test(before)) &&
    !(last && word.test(last) && after && word.test(after))
  );
}
export function checkS2ClaimAnswerAnchor(
  proposedAnswer: string,
  declarativeClaim: string,
): S2ClaimAnswerAnchor {
  const make = (
    status: S2ClaimAnswerAnchor["status"],
    reason: string,
    startUtf16: number | null = null,
    endUtf16: number | null = null,
  ): S2ClaimAnswerAnchor => ({
    status,
    reason,
    startUtf16,
    endUtf16,
    claimEquivalenceVerified: false,
    sourceEntailmentVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  if (
    typeof proposedAnswer !== "string" ||
    typeof declarativeClaim !== "string" ||
    !proposedAnswer.trim() ||
    proposedAnswer.trim() !== proposedAnswer ||
    proposedAnswer.length > 2048 ||
    !declarativeClaim.trim() ||
    declarativeClaim.length > 4096
  )
    return make("REJECTED", "ANSWER_OR_CLAIM_INVALID");
  if (booleanAnswer.test(proposedAnswer))
    return make(
      "BOOLEAN_VALUE_REQUIRES_SEMANTIC_REWRITE",
      "YES_NO_ANSWER_CANNOT_BE_LITERAL_ENTAILMENT_PROOF",
    );
  // The regex consumes only literal case variations; all indices remain
  // UTF-16 coordinates in the original, unnormalized declarative claim.
  // NFKC, stemming, fuzzy synonym matches and translation are deliberately
  // left to a separately evaluated semantic verifier.
  const escaped = proposedAnswer.replace(/[.*+?^$\{\}()|[\]\\]/gu, "\\$&");
  const literal = new RegExp(escaped, "giu");
  const matches: Array<{ start: number; end: number }> = [];
  for (const match of declarativeClaim.matchAll(literal)) {
    const start = match.index;
    const end = start + match[0].length;
    if (boundary(declarativeClaim, start, end)) matches.push({ start, end });
    if (matches.length > 1) break;
  }
  if (matches.length === 0)
    return make(
      "LITERAL_VALUE_NOT_FOUND",
      "PROJECTION_VALUE_OMITTED_OR_PARAPHRASED_UNVERIFIED",
    );
  if (matches.length > 1)
    return make("REPEATED_LITERAL_VALUE", "PROJECTION_VALUE_SPAN_NOT_UNIQUE");
  return make(
    "UNIQUE_LITERAL_VALUE",
    "ANSWER_VALUE_SURFACE_ONLY_NOT_CLAIM_EQUIVALENCE",
    matches[0]!.start,
    matches[0]!.end,
  );
}
