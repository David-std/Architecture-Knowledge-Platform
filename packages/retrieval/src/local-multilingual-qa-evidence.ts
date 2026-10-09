import type {
  QueryConditionedEvidenceVerification,
  QueryConditionedEvidenceVerifier,
  QueryConditionedEvidenceVerifierInput,
} from "./answerability.js";
import { resolveLocalSemanticCacheDir } from "./local-semantic-embedding.js";

export const LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL =
  "onnx-community/xlm-roberta-base-squad2-distilled-ONNX";
export const LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION =
  "484112fae76dde6ad01b640192d559cbc2d488e1";

export interface LocalMultilingualQaEvidencePipelineLoadOptions {
  readonly model: typeof LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL;
  readonly revision: typeof LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION;
  readonly cacheDir?: string;
  readonly localFilesOnly: boolean;
}

export interface LocalMultilingualQaEvidencePipelineResult {
  readonly answer: string;
  readonly score: number;
  readonly start?: number;
  readonly end?: number;
}

export interface LocalMultilingualQaEvidencePipeline {
  (
    question: string,
    context: string,
    options: {
      readonly top_k: 1;
      readonly handle_impossible_answer: true;
      readonly max_answer_len: 15;
    },
  ): Promise<
    | LocalMultilingualQaEvidencePipelineResult
    | readonly LocalMultilingualQaEvidencePipelineResult[]
  >;
  readonly dispose?: () => Promise<void> | void;
}

export type LocalMultilingualQaEvidencePipelineFactory = (
  options: LocalMultilingualQaEvidencePipelineLoadOptions,
) => Promise<LocalMultilingualQaEvidencePipeline>;

export interface LocalMultilingualQaEvidenceVerifierOptions {
  readonly minimumSupportScore: number;
  readonly cacheDir?: string;
  readonly localFilesOnly?: boolean;
  readonly pipelineFactory?: LocalMultilingualQaEvidencePipelineFactory;
}

function validatedSupportScore(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(
      "local multilingual QA evidence minimumSupportScore must be in (0,1]",
    );
  }
  return value;
}

function bestResult(
  result:
    | LocalMultilingualQaEvidencePipelineResult
    | readonly LocalMultilingualQaEvidencePipelineResult[],
): LocalMultilingualQaEvidencePipelineResult | null {
  const values = Array.isArray(result) ? result : [result];
  return (
    [...values]
      .filter(
        (entry) =>
          typeof entry?.answer === "string" &&
          typeof entry?.score === "number" &&
          Number.isFinite(entry.score) &&
          entry.score >= 0 &&
          entry.score <= 1,
      )
      .sort((left, right) => right.score - left.score)[0] ?? null
  );
}

function evidenceSpanForAnswer(
  passage: string,
  result: LocalMultilingualQaEvidencePipelineResult,
): { startOffset: number; endOffset: number } | null {
  const answer = result.answer.trim();
  if (!answer) return null;

  if (
    Number.isSafeInteger(result.start) &&
    Number.isSafeInteger(result.end) &&
    (result.start ?? -1) >= 0 &&
    (result.end ?? -1) > (result.start ?? -1) &&
    (result.end ?? passage.length + 1) <= passage.length
  ) {
    const start = result.start as number;
    const end = result.end as number;
    if (passage.slice(start, end).trim() === answer) {
      return { startOffset: start, endOffset: end };
    }
  }

  // The JS reader has no token offsets. A repeated decoded string cannot
  // identify which occurrence the model selected; fail closed instead of
  // fabricating an offset. Case folding can also change UTF-16 string length.
  const exact = passage.indexOf(answer);
  if (exact < 0 || passage.indexOf(answer, exact + 1) >= 0) return null;
  return { startOffset: exact, endOffset: exact + answer.length };
}

export interface ExtractiveQaLogitsInput {
  readonly inputIds: readonly number[];
  readonly attentionMask: readonly number[];
  readonly startLogits: readonly number[];
  readonly endLogits: readonly number[];
  readonly separatorTokenId: number;
  readonly classificationTokenId: number;
  readonly specialTokenIds: readonly number[];
  readonly maxAnswerTokens: number;
}

export interface ExtractiveQaDecodedSpan {
  readonly startToken: number | null;
  readonly endToken: number | null;
  readonly score: number;
}

/**
 * SQuAD2 decoding follows Transformers' select_starts_ends: question, padding
 * and special tokens are masked; CLS remains in both normalizers and competes
 * with real spans as the no-answer outcome. Unlike the JS pipeline, we retain
 * that outcome. These probabilities are diagnostic until held-out calibration.
 */
export function decodeExtractiveQaLogits(
  input: ExtractiveQaLogitsInput,
): ExtractiveQaDecodedSpan {
  const size = input.inputIds.length;
  const separator = input.inputIds.indexOf(input.separatorTokenId);
  if (
    size === 0 ||
    input.attentionMask.length !== size ||
    input.startLogits.length !== size ||
    input.endLogits.length !== size ||
    input.inputIds[0] !== input.classificationTokenId ||
    input.attentionMask[0] !== 1 ||
    separator <= 0 ||
    !Number.isSafeInteger(input.maxAnswerTokens) ||
    input.maxAnswerTokens <= 0 ||
    [...input.startLogits, ...input.endLogits].some(
      (value) => !Number.isFinite(value),
    )
  ) {
    throw new Error("LOCAL_MULTILINGUAL_QA_LOGITS_INVALID");
  }
  const special = new Set(input.specialTokenIds);
  const allowed = input.inputIds.map(
    (id, index) =>
      index > separator && input.attentionMask[index] === 1 && !special.has(id),
  );
  const distribution = (logits: readonly number[]): number[] => {
    const masked = logits.map((value, index) =>
      index === 0 || allowed[index] ? value : -Infinity,
    );
    const maximum = Math.max(...masked);
    const exp = masked.map((value) => Math.exp(value - maximum));
    const total = exp.reduce((sum, value) => sum + value, 0);
    return exp.map((value) => value / total);
  };
  const start = distribution(input.startLogits);
  const end = distribution(input.endLogits);
  let best: ExtractiveQaDecodedSpan = {
    startToken: null,
    endToken: null,
    score: start[0]! * end[0]!,
  };
  for (let left = separator + 1; left < size; left += 1) {
    if (!allowed[left]) continue;
    for (
      let right = left;
      right < Math.min(size, left + input.maxAnswerTokens);
      right += 1
    ) {
      if (!allowed[right]) break;
      const score = start[left]! * end[right]!;
      // Ties retain the no-answer outcome, not an arbitrary source phrase.
      if (score > best.score) {
        best = { startToken: left, endToken: right, score };
      }
    }
  }
  return best;
}
export const defaultLocalMultilingualQaEvidencePipelineFactory: LocalMultilingualQaEvidencePipelineFactory =
  async (options) => {
    const { pipeline } = await import("@huggingface/transformers");
    const pipelineOptions: Parameters<typeof pipeline>[2] = {
      revision: options.revision,
      local_files_only: options.localFilesOnly,
      ...(options.cacheDir === undefined
        ? {}
        : { cache_dir: options.cacheDir }),
      device: "cpu",
      dtype: "q8",
    };
    const answerer = await pipeline(
      "question-answering",
      options.model,
      pipelineOptions,
    );
    const reader: LocalMultilingualQaEvidencePipeline = async (
      question,
      context,
      decoderOptions,
    ) => {
      // Do not silently discard a question or the tail of its evidence.
      const inputs = answerer.tokenizer(question, {
        text_pair: context,
        padding: false,
        truncation: false,
      });
      const inputIds = (inputs.input_ids.tolist()[0] as bigint[]).map(Number);
      const attentionMask = (inputs.attention_mask.tolist()[0] as bigint[]).map(
        Number,
      );
      const modelLimit = Number(answerer.tokenizer.model_max_length);
      if (
        !Number.isSafeInteger(modelLimit) ||
        modelLimit <= 0 ||
        inputIds.length > modelLimit
      ) {
        throw new Error("LOCAL_MULTILINGUAL_QA_INPUT_EXCEEDS_MODEL_WINDOW");
      }
      const outputs = await answerer.model(inputs);
      const span = decodeExtractiveQaLogits({
        inputIds,
        attentionMask,
        startLogits: outputs.start_logits.tolist()[0] as number[],
        endLogits: outputs.end_logits.tolist()[0] as number[],
        separatorTokenId: answerer.tokenizer.sep_token_id,
        // The pinned XLM-R model uses its BOS/CLS token at position zero.
        classificationTokenId: answerer.tokenizer.bos_token_id,
        specialTokenIds: answerer.tokenizer.all_special_ids,
        maxAnswerTokens: decoderOptions.max_answer_len,
      });
      return {
        score: span.score,
        answer:
          span.startToken === null || span.endToken === null
            ? ""
            : answerer.tokenizer.decode(
                inputIds.slice(span.startToken, span.endToken + 1),
                { skip_special_tokens: true },
              ),
      };
    };
    return Object.assign(reader, { dispose: () => answerer.dispose() });
  };

export class LocalMultilingualQaEvidenceVerifier implements QueryConditionedEvidenceVerifier {
  readonly id: string;

  private readonly minimumSupportScore: number;
  private readonly cacheDir: string | undefined;
  private readonly localFilesOnly: boolean;
  private readonly pipelineFactory: LocalMultilingualQaEvidencePipelineFactory;
  private pipelinePromise:
    Promise<LocalMultilingualQaEvidencePipeline> | undefined;

  constructor(options: LocalMultilingualQaEvidenceVerifierOptions) {
    this.minimumSupportScore = validatedSupportScore(
      options.minimumSupportScore,
    );
    this.cacheDir = resolveLocalSemanticCacheDir(options.cacheDir);
    this.localFilesOnly = options.localFilesOnly ?? false;
    this.pipelineFactory =
      options.pipelineFactory ??
      defaultLocalMultilingualQaEvidencePipelineFactory;
    this.id = `local-multilingual-qa@${LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION}:squad2-null-v1:min=${this.minimumSupportScore}`;
  }

  async verify(
    input: QueryConditionedEvidenceVerifierInput,
  ): Promise<QueryConditionedEvidenceVerification> {
    if (!input.query.trim() || !input.passage.trim()) {
      return {
        decision: "INSUFFICIENT",
        reason: "LOCAL_MULTILINGUAL_QA_EMPTY_INPUT",
      };
    }

    const result = bestResult(
      await (
        await this.getPipeline()
      )(input.query, input.passage, {
        top_k: 1,
        handle_impossible_answer: true,
        max_answer_len: 15,
      }),
    );
    if (!result || !result.answer.trim()) {
      return {
        decision: "INSUFFICIENT",
        reason: "LOCAL_MULTILINGUAL_QA_NO_ANSWER",
      };
    }
    if (result.score < this.minimumSupportScore) {
      return {
        decision: "INSUFFICIENT",
        score: result.score,
        reason: "LOCAL_MULTILINGUAL_QA_BELOW_CALIBRATED_THRESHOLD",
      };
    }

    const evidenceSpan = evidenceSpanForAnswer(input.passage, result);
    if (!evidenceSpan) {
      return {
        decision: "INSUFFICIENT",
        score: result.score,
        reason: "LOCAL_MULTILINGUAL_QA_ANSWER_NOT_MAPPABLE",
      };
    }

    return {
      decision: "SUPPORTS",
      score: result.score,
      evidenceSpan,
      reason: "LOCAL_MULTILINGUAL_QA_EXTRACTIVE_SUPPORT",
    };
  }

  async dispose(): Promise<void> {
    const pipeline = await this.pipelinePromise;
    await pipeline?.dispose?.();
    this.pipelinePromise = undefined;
  }

  private async getPipeline(): Promise<LocalMultilingualQaEvidencePipeline> {
    if (this.pipelinePromise === undefined) {
      const pending = this.pipelineFactory({
        model: LOCAL_MULTILINGUAL_QA_EVIDENCE_MODEL,
        revision: LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION,
        localFilesOnly: this.localFilesOnly,
        ...(this.cacheDir === undefined ? {} : { cacheDir: this.cacheDir }),
      });
      this.pipelinePromise = pending.catch((error: unknown) => {
        this.pipelinePromise = undefined;
        throw error;
      });
    }
    return this.pipelinePromise;
  }
}
