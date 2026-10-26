import { createHash } from "node:crypto";
import {
  attributeS2VerbatimQuote,
  type S2ExactQuoteOriginal,
} from "./s2-exact-quote-attribution.js";

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

/**
 * S2 architectural-boundary diagnostic: the reader v5 returns an answer,
 * requested fact and quotation, while the production admission contract
 * forwards only its citation span and verdict. This retains the independently
 * attributable literal answer VALUE, when present, for shadow measurement.
 * A value being inside the quote is NOT proof that it answers the question.
 */
export interface S2ReaderAnswerSlotTransfer {
  readonly status:
    | "LITERAL_VALUE_BOUND_TO_ORIGINAL"
    | "EXTRACTED_VALUE_NOT_LITERAL_IN_QUOTE"
    | "EXTRACTED_VALUE_AMBIGUOUS_IN_QUOTE"
    | "BOOLEAN_VALUE_NEEDS_RELATION_CHECK"
    | "READER_ABSTAINED"
    | "INVALID_ORIGINAL_QUOTE"
    | "INVALID_READER_ANSWER";
  readonly reason: string;
  readonly sourceSha256: string | null;
  readonly requestedFactSha256: string | null;
  readonly extractedAnswerSha256: string | null;
  readonly quoteStartUtf16: number | null;
  readonly quoteEndUtf16: number | null;
  readonly answerValueStartUtf16: number | null;
  readonly answerValueEndUtf16: number | null;
  readonly literalValueIsNotEntailmentProof: true;
  readonly actualQueryAnswerRoleVerified: false;
  readonly quantitativeEquivalenceVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

export function traceS2ReaderAnswerSlotTransfer(
  input: {
    readonly question: string;
    readonly needed: string;
    readonly extractedAnswer: string;
    readonly quote: string;
    readonly answers: boolean;
  },
  source: S2ExactQuoteOriginal,
): S2ReaderAnswerSlotTransfer {
  const make = (
    status: S2ReaderAnswerSlotTransfer["status"],
    reason: string,
    quoteStartUtf16: number | null = null,
    quoteEndUtf16: number | null = null,
    answerValueStartUtf16: number | null = null,
    answerValueEndUtf16: number | null = null,
  ): S2ReaderAnswerSlotTransfer => ({
    status,
    reason,
    sourceSha256:
      typeof source?.sourceSha256 === "string" ? source.sourceSha256 : null,
    requestedFactSha256:
      typeof input?.needed === "string" && input.needed.trim()
        ? createHash("sha256").update(input.needed).digest("hex")
        : null,
    extractedAnswerSha256:
      typeof input?.extractedAnswer === "string" && input.extractedAnswer.trim()
        ? createHash("sha256").update(input.extractedAnswer).digest("hex")
        : null,
    quoteStartUtf16,
    quoteEndUtf16,
    answerValueStartUtf16,
    answerValueEndUtf16,
    literalValueIsNotEntailmentProof: true,
    actualQueryAnswerRoleVerified: false,
    quantitativeEquivalenceVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  if (
    !input ||
    typeof input.question !== "string" ||
    !input.question.trim() ||
    input.question.length > 2048 ||
    typeof input.answers !== "boolean" ||
    typeof input.needed !== "string" ||
    typeof input.extractedAnswer !== "string" ||
    typeof input.quote !== "string" ||
    !source?.assignedSourceId
  )
    return make("INVALID_READER_ANSWER", "READER_SLOT_INPUT_INVALID");
  if (!input.answers) {
    return input.needed === "" &&
      input.extractedAnswer === "" &&
      input.quote === ""
      ? make("READER_ABSTAINED", "READER_NO_ANSWER")
      : make("INVALID_READER_ANSWER", "READER_ABSTENTION_CONTAINS_FACT");
  }
  if (
    !input.needed.trim() ||
    !input.extractedAnswer.trim() ||
    input.extractedAnswer !== input.extractedAnswer.trim() ||
    input.extractedAnswer.length > 2048 ||
    input.needed.length > 2048
  )
    return make(
      "INVALID_READER_ANSWER",
      "ANSWER_VALUE_OR_REQUESTED_FACT_INVALID",
    );
  const attributed = attributeS2VerbatimQuote(
    {
      answerText: input.extractedAnswer,
      evidenceQuote: input.quote,
      sourceId: source.assignedSourceId,
      abstained: false,
    },
    [source],
  );
  if (
    attributed.status !== "VERBATIM_UNIQUE_SOURCE_BOUND" ||
    attributed.assignedSourceId !== source.assignedSourceId ||
    !attributed.modelSourceIdConfirmed ||
    attributed.startUtf16 === null ||
    attributed.endUtf16 === null
  )
    return make("INVALID_ORIGINAL_QUOTE", "EXACT_ORIGINAL_F3_BINDING_FAILED");

  const start = attributed.startUtf16;
  const end = attributed.endUtf16;
  if (
    /^(?:yes|no|sí|si|true|false|verdadero|falso)$/iu.test(
      input.extractedAnswer,
    )
  ) {
    return make(
      "BOOLEAN_VALUE_NEEDS_RELATION_CHECK",
      "POLARITY_ANSWER_NOT_LITERAL_VALUE_PROOF",
      start,
      end,
    );
  }
  // Preserve original UTF-16 coordinates. No stemming, translation, case
  // folding, numeric word->digit equivalence or fuzzy restoration.
  const value = input.extractedAnswer;
  const word = /[\p{L}\p{M}\p{N}_]/u;
  const boundary = (cursor: number) =>
    (!word.test(input.quote[cursor - 1] ?? "") || !word.test(value[0] ?? "")) &&
    (!word.test(input.quote[cursor + value.length] ?? "") ||
      !word.test(value.at(-1) ?? ""));
  const offsets: number[] = [];
  for (
    let cursor = input.quote.indexOf(value);
    cursor >= 0;
    cursor = input.quote.indexOf(value, cursor + 1)
  ) {
    if (boundary(cursor)) offsets.push(cursor);
    if (offsets.length > 1) break;
  }
  if (offsets.length === 0)
    return make(
      "EXTRACTED_VALUE_NOT_LITERAL_IN_QUOTE",
      "CROSS_LANGUAGE_OR_PARAPHRASED_VALUE_UNATTESTED",
      start,
      end,
    );
  if (offsets.length > 1)
    return make(
      "EXTRACTED_VALUE_AMBIGUOUS_IN_QUOTE",
      "MULTIPLE_VALUE_OCCURRENCES_NOT_DISAMBIGUATED",
      start,
      end,
    );
  return make(
    "LITERAL_VALUE_BOUND_TO_ORIGINAL",
    "READER_VALUE_LITERALLY_PRESENT_BUT_RELATION_UNVERIFIED",
    start,
    end,
    start + offsets[0]!,
    start + offsets[0]! + value.length,
  );
}
