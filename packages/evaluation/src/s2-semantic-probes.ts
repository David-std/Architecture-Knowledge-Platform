import type {
  S2SemanticProbe,
  S2SemanticProbeInput,
  S2SemanticProbeResult,
} from "./s2-semantic-evidence.js";

/** Compatible with the existing local multilingual QA evidence adapter. */
export interface S2ExtractiveQaVerifier {
  verify(input: { readonly query: string; readonly passage: string }): Promise<{
    readonly decision: "SUPPORTS" | "INSUFFICIENT";
    readonly evidenceSpan?: {
      readonly startOffset: number;
      readonly endOffset: number;
    };
  }>;
}

/**
 * QA is only an answer-location relevance probe; matching a phrase within
 * an answer never certifies the answer's claim or negation (NLI is separate).
 */
export function createS2QaRelevanceProbe(
  id: string,
  qa: S2ExtractiveQaVerifier,
): S2SemanticProbe {
  if (!id.includes("@")) throw new Error("S2_QA_MODEL_REVISION_REQUIRED");
  return {
    id,
    verify: async (
      input: S2SemanticProbeInput,
    ): Promise<S2SemanticProbeResult> => {
      const result = await qa.verify({
        query: input.originalQuestion,
        passage: input.exactQuote,
      });
      const span = result.evidenceSpan;
      if (
        result.decision !== "SUPPORTS" ||
        !span ||
        !Number.isSafeInteger(span.startOffset) ||
        !Number.isSafeInteger(span.endOffset) ||
        span.startOffset < 0 ||
        span.endOffset > input.exactQuote.length ||
        span.startOffset >= span.endOffset
      )
        return { decision: "INSUFFICIENT", reason: "QA_NO_BOUND_ANSWER" };
      const substring = input.exactQuote.slice(
        span.startOffset,
        span.endOffset,
      );
      const fold = (value: string) =>
        value.normalize("NFC").toLocaleLowerCase("und").trim();
      // A QA span that cannot be found in the writer's answer is insufficient.
      // Cross-language paraphrases may abstain. This is intentional.
      if (
        !substring.trim() ||
        !fold(input.answerClaim).includes(fold(substring))
      )
        return { decision: "INSUFFICIENT", reason: "QA_ANSWER_CLAIM_MISMATCH" };
      return {
        decision: "SUPPORTS",
        reason: "QA_QUOTE_SPAN_FOUND_IN_CLAIM",
        evidenceSpan: {
          startUtf16: span.startOffset,
          endUtf16: span.endOffset,
        },
      };
    },
  };
}

/**
 * Open-question focus: unlike substring-matching answer probes, this only
 * asks if the original question has an extractive answer at an exact quote
 * span. The separate entailment gate checks the complete generated claim,
 * allowing cross-language paraphrases without trusting lexical equivalence.
 */
export function createS2QaQuestionFocusProbe(
  id: string,
  qa: S2ExtractiveQaVerifier,
): S2SemanticProbe {
  if (!id.includes("@")) throw new Error("S2_QA_MODEL_REVISION_REQUIRED");
  return {
    id,
    verify: async (input): Promise<S2SemanticProbeResult> => {
      const result = await qa.verify({
        query: input.originalQuestion,
        passage: input.exactQuote,
      });
      if (result.decision !== "SUPPORTS" || !result.evidenceSpan)
        return {
          decision: "INSUFFICIENT",
          reason: "QUESTION_NOT_ANSWERED_BY_QUOTE",
        };
      const { startOffset: start, endOffset: end } = result.evidenceSpan;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        end > input.exactQuote.length ||
        end <= start ||
        !input.exactQuote.slice(start, end).trim()
      )
        return { decision: "INSUFFICIENT", reason: "QA_FOCUS_SPAN_UNBOUND" };
      // The enclosing semantic cascade independently replays UTF-16 boundaries.
      return {
        decision: "SUPPORTS",
        reason: "QUESTION_FOCUS_FOUND_IN_QUOTE",
        evidenceSpan: { startUtf16: start, endUtf16: end },
      };
    },
  };
}

export interface S2DirectNliRuntime {
  infer(
    premise: string,
    hypothesis: string,
  ): Promise<{
    readonly entailment: number;
    readonly contradiction: number;
    readonly neutral: number;
  }>;
  /** Exact token count using the SAME pinned tokenizer as infer(). */
  countTokens(premise: string, hypothesis: string): Promise<number>;
}

export interface S2DirectNliProbeConfig {
  readonly id: string;
  readonly runtime: S2DirectNliRuntime;
  readonly minimumScore: number;
  readonly minimumMargin: number;
  /**
   * Reject before invocation when evidence may exceed an NLI tokenizer window.
   * A caller must independently enforce token limits in its model runtime.
   */
  readonly maxCombinedUtf16: number;
  readonly maxTokens: number;
}

/** Direct quote → writer claim NLI; never uses the model-supplied source ID. */
export function createS2DirectNliClaimProbe(
  config: S2DirectNliProbeConfig,
): S2SemanticProbe {
  const {
    id,
    runtime,
    minimumScore,
    minimumMargin,
    maxCombinedUtf16,
    maxTokens,
  } = config;
  if (
    !id.includes("@") ||
    ![minimumScore, minimumMargin].every(
      (score) => Number.isFinite(score) && score >= 0 && score <= 1,
    ) ||
    !Number.isSafeInteger(maxCombinedUtf16) ||
    maxCombinedUtf16 < 1 ||
    maxCombinedUtf16 > 4000 ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens <= 0 ||
    maxTokens > 512
  )
    throw new Error("S2_NLI_UNPINNED_OR_INVALID_CONFIGURATION");

  return {
    id,
    verify: async (input): Promise<S2SemanticProbeResult> => {
      if (input.exactQuote.length + input.answerClaim.length > maxCombinedUtf16)
        return {
          decision: "INSUFFICIENT",
          reason: "NLI_MODEL_INPUT_BUDGET_EXCEEDED",
        };
      const tokens = await runtime.countTokens(
        input.exactQuote,
        input.answerClaim,
      );
      if (!Number.isSafeInteger(tokens) || tokens <= 0 || tokens > maxTokens)
        return {
          decision: "INSUFFICIENT",
          reason: "NLI_TOKEN_WINDOW_EXCEEDED",
        };
      const result = await runtime.infer(input.exactQuote, input.answerClaim);
      if (
        ![result.entailment, result.neutral, result.contradiction].every(
          (value) => Number.isFinite(value) && value >= 0 && value <= 1,
        ) ||
        Math.abs(
          result.entailment + result.neutral + result.contradiction - 1,
        ) > 0.01
      )
        throw new Error("NLI_DISTRIBUTION_INVALID");
      const ranked = [
        ["SUPPORTS", result.entailment],
        ["CONTRADICTS", result.contradiction],
        ["INSUFFICIENT", result.neutral],
      ] as const;
      const sorted = [...ranked].sort((a, b) => b[1] - a[1]);
      const first = sorted[0]!;
      const second = sorted[1]!;
      if (
        first[1] < minimumScore ||
        first[1] - second[1] < minimumMargin ||
        first[0] === "INSUFFICIENT"
      )
        return {
          decision: "INSUFFICIENT",
          reason: "NLI_UNCALIBRATED_OR_NEUTRAL",
          score: first[1],
        };
      return {
        decision: first[0],
        reason:
          first[0] === "SUPPORTS"
            ? "NLI_CLAIM_ENTAILED_BY_QUOTE"
            : "NLI_CLAIM_CONTRADICTED_BY_QUOTE",
        score: first[1],
        evidenceSpan: {
          startUtf16: 0,
          endUtf16: input.exactQuote.length,
        },
      };
    },
  };
}
