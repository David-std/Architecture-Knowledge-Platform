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
    options: { readonly top_k: 1 },
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
          Number.isFinite(entry.score),
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

  const exact = passage.indexOf(answer);
  if (exact >= 0) {
    return { startOffset: exact, endOffset: exact + answer.length };
  }

  const foldedPassage = passage.toLocaleLowerCase("en-US");
  const foldedAnswer = answer.toLocaleLowerCase("en-US");
  const folded = foldedPassage.indexOf(foldedAnswer);
  return folded < 0
    ? null
    : { startOffset: folded, endOffset: folded + answer.length };
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
    return answerer as unknown as LocalMultilingualQaEvidencePipeline;
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
    this.id = `local-multilingual-qa@${LOCAL_MULTILINGUAL_QA_EVIDENCE_REVISION}:min=${this.minimumSupportScore}`;
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
      }),
    );
    if (!result) {
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
