import type {
  QueryConditionedEvidenceVerification,
  QueryConditionedEvidenceSpan,
} from "./answerability.js";
import { markdownVisibleSource } from "./markdown-visible-source.js";

/** Stable, non-sensitive failures at the verifier/source boundary. */
export type SourceVerificationFailureCode =
  | "QUERY_CONDITIONED_EVIDENCE_RESULT_INVALID"
  | "QUERY_CONDITIONED_EVIDENCE_DECISION_INVALID"
  | "QUERY_CONDITIONED_EVIDENCE_REASON_REQUIRED"
  | "QUERY_CONDITIONED_EVIDENCE_SCORE_INVALID"
  | "QUERY_CONDITIONED_EVIDENCE_SPAN_REQUIRED"
  | "QUERY_CONDITIONED_EVIDENCE_SPAN_INVALID"
  | "QUERY_CONDITIONED_EVIDENCE_SPAN_HIDDEN_SOURCE"
  | "QUERY_CONDITIONED_EVIDENCE_SPAN_UNEXPECTED"
  | "QUERY_CONDITIONED_EVIDENCE_INPUT_INVALID"
  | "QUERY_CONDITIONED_EVIDENCE_BATCH_SIZE_MISMATCH"
  | "QUERY_CONDITIONED_EVIDENCE_VERIFIER_ERROR"
  | "RUNTIME_CRASHED"
  | "SEMANTIC_READER_TIMEOUT";

export class SourceVerificationError extends Error {
  readonly code: SourceVerificationFailureCode;

  constructor(code: SourceVerificationFailureCode) {
    super(code);
    this.name = "SourceVerificationError";
    this.code = code;
  }
}

/**
 * Convert arbitrary provider/application failures to an inspectable stable
 * code. Provider messages may contain source bytes, URLs or credentials.
 */
export function sourceVerificationFailureCode(
  error: unknown,
): SourceVerificationFailureCode {
  if (error instanceof SourceVerificationError) return error.code;
  // Kept as a stable legacy runtime code; arbitrary provider messages remain
  // deliberately collapsed to the generic verifier failure below.
  if (error instanceof Error && error.message === "RUNTIME_CRASHED") {
    return "RUNTIME_CRASHED";
  }
  return "QUERY_CONDITIONED_EVIDENCE_VERIFIER_ERROR";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHighSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit: number): boolean {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

/** UTF-16 offsets must not split one Unicode code point into two source spans. */
export function sourceSpanUsesCodePointBoundaries(
  passage: string,
  startOffset: number,
  endOffset: number,
): boolean {
  const isBoundary = (offset: number): boolean =>
    offset === 0 ||
    offset === passage.length ||
    !(
      isHighSurrogate(passage.charCodeAt(offset - 1)) &&
      isLowSurrogate(passage.charCodeAt(offset))
    );
  return isBoundary(startOffset) && isBoundary(endOffset);
}

function validSpan(
  passage: string,
  span: unknown,
): span is QueryConditionedEvidenceSpan {
  if (!isRecord(span)) return false;
  return (
    Number.isSafeInteger(span.startOffset) &&
    Number.isSafeInteger(span.endOffset) &&
    (span.startOffset as number) >= 0 &&
    (span.endOffset as number) > (span.startOffset as number) &&
    (span.endOffset as number) <= passage.length &&
    sourceSpanUsesCodePointBoundaries(
      passage,
      span.startOffset as number,
      span.endOffset as number,
    )
  );
}

function spanTouchesHiddenSource(
  passage: string,
  span: QueryConditionedEvidenceSpan,
): boolean {
  return markdownVisibleSource(passage).comments.some(
    (comment) =>
      comment.startOffset < span.endOffset &&
      comment.endOffset > span.startOffset,
  );
}

/**
 * Validate untrusted verifier output against the exact UTF-16 passage it was
 * asked to inspect. Both positive and contradictory decisions require a
 * visible, non-empty source span; insufficient results must not carry one.
 */
export function validateSourceBoundVerification(
  passage: unknown,
  result: unknown,
): QueryConditionedEvidenceVerification {
  if (typeof passage !== "string") {
    throw new SourceVerificationError(
      "QUERY_CONDITIONED_EVIDENCE_INPUT_INVALID",
    );
  }
  if (!isRecord(result)) {
    throw new SourceVerificationError(
      "QUERY_CONDITIONED_EVIDENCE_RESULT_INVALID",
    );
  }

  const decision = result.decision;
  if (
    decision !== "SUPPORTS" &&
    decision !== "CONTRADICTS" &&
    decision !== "INSUFFICIENT"
  ) {
    throw new SourceVerificationError(
      "QUERY_CONDITIONED_EVIDENCE_DECISION_INVALID",
    );
  }

  const reason = result.reason;
  if (typeof reason !== "string" || !reason.trim()) {
    throw new SourceVerificationError(
      "QUERY_CONDITIONED_EVIDENCE_REASON_REQUIRED",
    );
  }

  const score = result.score;
  if (
    score !== undefined &&
    (typeof score !== "number" ||
      !Number.isFinite(score) ||
      score < 0 ||
      score > 1)
  ) {
    throw new SourceVerificationError(
      "QUERY_CONDITIONED_EVIDENCE_SCORE_INVALID",
    );
  }

  const evidenceSpan = result.evidenceSpan;
  if (decision === "SUPPORTS" || decision === "CONTRADICTS") {
    if (evidenceSpan === undefined || evidenceSpan === null) {
      throw new SourceVerificationError(
        "QUERY_CONDITIONED_EVIDENCE_SPAN_REQUIRED",
      );
    }
    if (!validSpan(passage, evidenceSpan)) {
      throw new SourceVerificationError(
        "QUERY_CONDITIONED_EVIDENCE_SPAN_INVALID",
      );
    }
    const normalizedSpan: QueryConditionedEvidenceSpan = {
      startOffset: evidenceSpan.startOffset,
      endOffset: evidenceSpan.endOffset,
    };
    if (spanTouchesHiddenSource(passage, normalizedSpan)) {
      throw new SourceVerificationError(
        "QUERY_CONDITIONED_EVIDENCE_SPAN_HIDDEN_SOURCE",
      );
    }
    return {
      decision,
      ...(score === undefined ? {} : { score }),
      evidenceSpan: normalizedSpan,
      reason: reason.trim(),
    };
  }

  if (evidenceSpan !== undefined) {
    throw new SourceVerificationError(
      "QUERY_CONDITIONED_EVIDENCE_SPAN_UNEXPECTED",
    );
  }
  return {
    decision,
    ...(score === undefined ? {} : { score }),
    reason: reason.trim(),
  };
}
