import { resolveLocalSemanticCacheDir } from "./local-semantic-embedding.js";

export const MULTILINGUAL_BGE_RERANKER_MODEL =
  "onnx-community/bge-reranker-v2-m3-ONNX";
export const MULTILINGUAL_BGE_RERANKER_REVISION =
  "6f5ff65298512715a1e669753bc754d2bc8f367b";

export interface LocalBgeCrossEncoderDescriptor {
  readonly model: typeof MULTILINGUAL_BGE_RERANKER_MODEL;
  readonly revision: typeof MULTILINGUAL_BGE_RERANKER_REVISION;
  readonly runtime: "@huggingface/transformers";
  readonly task: "query-passage-cross-encoder-reranking";
  readonly device: "cpu";
  readonly dtype: "int8";
  readonly subfolder: "onnx";
  readonly modelFileName: "model";
  readonly maxTokens: 512;
}

export const LOCAL_MULTILINGUAL_BGE_RERANKER_DESCRIPTOR: LocalBgeCrossEncoderDescriptor =
  Object.freeze({
    model: MULTILINGUAL_BGE_RERANKER_MODEL,
    revision: MULTILINGUAL_BGE_RERANKER_REVISION,
    runtime: "@huggingface/transformers",
    task: "query-passage-cross-encoder-reranking",
    device: "cpu",
    dtype: "int8",
    subfolder: "onnx",
    modelFileName: "model",
    maxTokens: 512,
  });

export interface LocalBgeCrossEncoderRuntime {
  scoreLogit(query: string, passage: string): Promise<number>;
  readonly dispose?: () => Promise<void> | void;
}

export interface LocalBgeCrossEncoderRuntimeLoadOptions {
  readonly model: typeof MULTILINGUAL_BGE_RERANKER_MODEL;
  readonly revision: typeof MULTILINGUAL_BGE_RERANKER_REVISION;
  readonly cacheDir?: string;
  readonly localFilesOnly: boolean;
}

export type LocalBgeCrossEncoderRuntimeFactory = (
  options: LocalBgeCrossEncoderRuntimeLoadOptions,
) => Promise<LocalBgeCrossEncoderRuntime>;

export interface LocalBgeCrossEncoderRerankerOptions {
  readonly cacheDir?: string;
  readonly localFilesOnly?: boolean;
  readonly runtimeFactory?: LocalBgeCrossEncoderRuntimeFactory;
}

function nonEmpty(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${name} must be a non-empty string`);
  return trimmed;
}

function sigmoid(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error("LOCAL_BGE_RERANKER_LOGIT_INVALID");
  }
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export const defaultLocalBgeCrossEncoderRuntimeFactory: LocalBgeCrossEncoderRuntimeFactory =
  async (options) => {
    const { AutoModelForSequenceClassification, AutoTokenizer } =
      await import("@huggingface/transformers");
    const cacheOptions = {
      revision: options.revision,
      local_files_only: options.localFilesOnly,
      ...(options.cacheDir === undefined
        ? {}
        : { cache_dir: options.cacheDir }),
    };
    const tokenizer = await AutoTokenizer.from_pretrained(
      options.model,
      cacheOptions,
    );
    const model = await AutoModelForSequenceClassification.from_pretrained(
      options.model,
      {
        ...cacheOptions,
        subfolder: LOCAL_MULTILINGUAL_BGE_RERANKER_DESCRIPTOR.subfolder,
        model_file_name:
          LOCAL_MULTILINGUAL_BGE_RERANKER_DESCRIPTOR.modelFileName,
        dtype: LOCAL_MULTILINGUAL_BGE_RERANKER_DESCRIPTOR.dtype,
        device: LOCAL_MULTILINGUAL_BGE_RERANKER_DESCRIPTOR.device,
      },
    );

    return {
      scoreLogit: async (query, passage) => {
        const inputs = await tokenizer(query, {
          text_pair: passage,
          truncation: true,
          max_length: LOCAL_MULTILINGUAL_BGE_RERANKER_DESCRIPTOR.maxTokens,
        });
        const output = (await model(inputs)) as unknown as {
          logits?: { data?: ArrayLike<number> };
        };
        const data = output.logits?.data;
        if (!data || data.length < 1) {
          throw new Error("LOCAL_BGE_RERANKER_LOGIT_MISSING");
        }
        const logit = Number(data[0]);
        if (!Number.isFinite(logit)) {
          throw new Error("LOCAL_BGE_RERANKER_LOGIT_INVALID");
        }
        return logit;
      },
      dispose: async () => {
        await model.dispose?.();
      },
    };
  };

/**
 * Pinned local multilingual cross-encoder scorer.
 *
 * This adapter only produces relevance scores. It does not authorize a
 * candidate, establish evidence support, or change retrieval defaults.
 */
export class LocalBgeCrossEncoderReranker {
  readonly descriptor = LOCAL_MULTILINGUAL_BGE_RERANKER_DESCRIPTOR;

  private readonly cacheDir: string | undefined;
  private readonly localFilesOnly: boolean;
  private readonly runtimeFactory: LocalBgeCrossEncoderRuntimeFactory;
  private runtimePromise: Promise<LocalBgeCrossEncoderRuntime> | undefined;

  constructor(options: LocalBgeCrossEncoderRerankerOptions = {}) {
    this.cacheDir = resolveLocalSemanticCacheDir(options.cacheDir);
    this.localFilesOnly = options.localFilesOnly ?? false;
    this.runtimeFactory =
      options.runtimeFactory ?? defaultLocalBgeCrossEncoderRuntimeFactory;
  }

  async load(): Promise<void> {
    await this.getRuntime();
  }

  async score(query: string, passage: string): Promise<number> {
    const normalizedQuery = nonEmpty(query, "BGE reranker query");
    const normalizedPassage = nonEmpty(passage, "BGE reranker passage");
    const runtime = await this.getRuntime();
    return sigmoid(await runtime.scoreLogit(normalizedQuery, normalizedPassage));
  }

  async scoreMany(
    query: string,
    passages: readonly string[],
  ): Promise<number[]> {
    if (passages.length === 0) return [];
    const scores: number[] = [];
    for (const passage of passages) {
      scores.push(await this.score(query, passage));
    }
    return scores;
  }

  async dispose(): Promise<void> {
    if (!this.runtimePromise) return;
    const runtime = await this.runtimePromise;
    await runtime.dispose?.();
    this.runtimePromise = undefined;
  }

  private getRuntime(): Promise<LocalBgeCrossEncoderRuntime> {
    this.runtimePromise ??= this.runtimeFactory({
      model: MULTILINGUAL_BGE_RERANKER_MODEL,
      revision: MULTILINGUAL_BGE_RERANKER_REVISION,
      ...(this.cacheDir === undefined ? {} : { cacheDir: this.cacheDir }),
      localFilesOnly: this.localFilesOnly,
    });
    return this.runtimePromise;
  }
}
