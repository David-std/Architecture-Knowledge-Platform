import type {
  EmbeddingDescriptor,
  EmbeddingPort,
  EmbeddingRequestOptions,
} from "./embeddings.js";

/**
 * The model revision is pinned to a Hub commit so a generation can be
 * reproduced after the `main` branch of the model repository moves.
 *
 * Source: https://huggingface.co/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3
 */
export const MULTILINGUAL_E5_SMALL_MODEL = "intfloat/multilingual-e5-small";
export const MULTILINGUAL_E5_SMALL_REVISION =
  "614241f622f53c4eeff9890bdc4f31cfecc418b3";

export const MULTILINGUAL_E5_SMALL_DIMENSIONS = 384;
export const MULTILINGUAL_E5_SMALL_QUERY_PREFIX = "query: ";
export const MULTILINGUAL_E5_SMALL_PASSAGE_PREFIX = "passage: ";

/** The input role controls the prefix required by the E5 model card. */
export type LocalSemanticInputRole = "query" | "passage";

/**
 * Runtime details are part of the descriptor because changing any of these
 * can produce vectors that are not compatible with an existing generation.
 */
export interface LocalSemanticEmbeddingRuntime {
  readonly library: "@huggingface/transformers";
  readonly libraryVersion: "4.2.0";
  readonly backend: "onnxruntime-node";
  readonly device: "cpu";
  readonly dtype: "fp32";
  readonly subfolder: "onnx";
  /** Base name; Transformers.js appends the dtype suffix and `.onnx`. */
  readonly modelFileName: "model_O4";
  readonly maxTokens: 512;
}

/**
 * A provider descriptor extends the existing port descriptor without
 * changing its compatibility contract.  `inputStrategy` and `runtime` are
 * intentionally explicit so they can be persisted in an embedding
 * generation configuration hash by the caller.
 */
export interface LocalSemanticEmbeddingDescriptor extends EmbeddingDescriptor {
  readonly inputStrategy: "e5-query-passage-prefix-v1";
  readonly runtime: LocalSemanticEmbeddingRuntime;
}

export const LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR: LocalSemanticEmbeddingDescriptor =
  Object.freeze({
    provider: "local-transformers-js",
    model: MULTILINGUAL_E5_SMALL_MODEL,
    modelRevision: MULTILINGUAL_E5_SMALL_REVISION,
    dimensions: MULTILINGUAL_E5_SMALL_DIMENSIONS,
    normalization: "l2",
    inputStrategy: "e5-query-passage-prefix-v1",
    configurationVersion: "transformers-js-4.2.0-e5-onnx-o4-v1",
    runtime: Object.freeze({
      library: "@huggingface/transformers",
      libraryVersion: "4.2.0",
      backend: "onnxruntime-node",
      device: "cpu",
      dtype: "fp32",
      subfolder: "onnx",
      modelFileName: "model_O4",
      maxTokens: 512,
    }),
  });

export interface LocalSemanticPipelineLoadOptions {
  readonly model: typeof MULTILINGUAL_E5_SMALL_MODEL;
  readonly revision: typeof MULTILINGUAL_E5_SMALL_REVISION;
  readonly subfolder: "onnx";
  readonly modelFileName: "model_O4";
  readonly cacheDir?: string;
  readonly localFilesOnly: boolean;
}

export interface LocalSemanticFeatureExtractionOptions {
  readonly pooling: "mean";
  readonly normalize: true;
}

/**
 * This is the small surface used from Transformers.js.  Keeping it local
 * makes the adapter mechanically testable without downloading a model.
 */
export interface LocalSemanticPipelineResult {
  readonly dims: readonly number[];
  readonly tolist: () => unknown;
}

export interface LocalSemanticPipeline {
  (
    texts: readonly string[],
    options: LocalSemanticFeatureExtractionOptions,
  ): Promise<LocalSemanticPipelineResult>;
  readonly dispose?: () => Promise<void> | void;
}

export type LocalSemanticPipelineFactory = (
  options: LocalSemanticPipelineLoadOptions,
) => Promise<LocalSemanticPipeline>;

export interface LocalSemanticEmbeddingOptions {
  /** Maximum number of prefixed texts sent to one inference call. */
  readonly maxBatchSize?: number;
  /** Transformers.js model cache. Omit to use its platform default. */
  readonly cacheDir?: string;
  /** If true, loading fails rather than contacting the Hub. */
  readonly localFilesOnly?: boolean;
  /** Dependency injection seam for offline tests and alternative runtimes. */
  readonly pipelineFactory?: LocalSemanticPipelineFactory;
}

const DEFAULT_MAX_BATCH_SIZE = 16;

/**
 * Transformers.js defaults its Node cache below the installed package. With
 * pnpm that path can exceed the Win32 path limit before the model filename is
 * appended, which makes ONNX Runtime report a fully downloaded model as
 * missing. Keep the cache location operational (and out of the persisted
 * descriptor), while selecting a short per-user directory on Windows.
 */
export function resolveLocalSemanticCacheDir(
  explicitCacheDir?: string,
): string | undefined {
  if (explicitCacheDir !== undefined) {
    if (!explicitCacheDir.trim()) {
      throw new Error("local semantic embedding cacheDir must be non-empty");
    }
    return explicitCacheDir;
  }
  if (process.env.AKP_MODEL_CACHE_DIR?.trim()) {
    return process.env.AKP_MODEL_CACHE_DIR;
  }
  if (process.platform !== "win32") return undefined;
  const base = process.env.LOCALAPPDATA?.trim() || process.env.TEMP?.trim();
  return base ? `${base}/AKP/model-cache` : undefined;
}

function validateMaxBatchSize(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      "local semantic embedding maxBatchSize must be a positive integer",
    );
  }
  return value;
}

function prefixText(text: string, role: LocalSemanticInputRole): string {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("local semantic embedding input text must be non-empty");
  }

  const trimmed = text.trim();
  const prefix =
    role === "query"
      ? MULTILINGUAL_E5_SMALL_QUERY_PREFIX
      : MULTILINGUAL_E5_SMALL_PASSAGE_PREFIX;

  // Avoid producing `query: passage: ...` when a caller already supplied an
  // E5 role.  The requested role always wins, which keeps query/passage
  // configuration explicit at the adapter boundary.
  const withoutRolePrefix = /^(?:query|passage):\s*/iu.test(trimmed)
    ? trimmed.replace(/^(?:query|passage):\s*/iu, "")
    : trimmed;
  return `${prefix}${withoutRolePrefix}`;
}

function normalizeL2(values: readonly number[], index: number): number[] {
  if (values.length !== MULTILINGUAL_E5_SMALL_DIMENSIONS) {
    throw new Error(
      `local semantic embedding output row ${index} has ${values.length} dimensions; expected ${MULTILINGUAL_E5_SMALL_DIMENSIONS}`,
    );
  }

  let squaredNorm = 0;
  for (const value of values) {
    if (!Number.isFinite(value)) {
      throw new Error(
        `local semantic embedding output row ${index} contains a non-finite value`,
      );
    }
    squaredNorm += value * value;
  }

  const norm = Math.sqrt(squaredNorm);
  if (!Number.isFinite(norm) || norm === 0) {
    throw new Error(
      `local semantic embedding output row ${index} cannot be L2-normalized`,
    );
  }
  return values.map((value) => value / norm);
}

function rowsFromPipelineResult(
  result: LocalSemanticPipelineResult,
  expectedRows: number,
): number[][] {
  if (
    result.dims.length !== 2 ||
    result.dims[0] !== expectedRows ||
    result.dims[1] !== MULTILINGUAL_E5_SMALL_DIMENSIONS
  ) {
    throw new Error(
      `local semantic embedding output dimensions ${JSON.stringify(result.dims)} do not match [${expectedRows}, ${MULTILINGUAL_E5_SMALL_DIMENSIONS}]`,
    );
  }

  const listed = result.tolist();
  if (!Array.isArray(listed) || listed.length !== expectedRows) {
    throw new Error(
      "local semantic embedding output row count does not match the input batch",
    );
  }

  return listed.map((row, index) => {
    if (!Array.isArray(row)) {
      throw new Error(
        `local semantic embedding output row ${index} is not an array`,
      );
    }
    return normalizeL2(row, index);
  });
}

/**
 * Default Transformers.js loader.  The package is imported only when the
 * first embedding request is made; constructing an adapter is side-effect
 * free and never downloads a model.
 */
export const defaultLocalSemanticPipelineFactory: LocalSemanticPipelineFactory =
  async (options) => {
    const { pipeline } = await import("@huggingface/transformers");
    const pipelineOptions: Parameters<typeof pipeline>[2] = {
      revision: options.revision,
      subfolder: options.subfolder,
      model_file_name: options.modelFileName,
      local_files_only: options.localFilesOnly,
      ...(options.cacheDir === undefined
        ? {}
        : { cache_dir: options.cacheDir }),
      device: "cpu",
      dtype: "fp32",
    };
    const extractor = await pipeline(
      "feature-extraction",
      options.model,
      pipelineOptions,
    );

    return extractor as unknown as LocalSemanticPipeline;
  };

/**
 * Local multilingual semantic embeddings backed by Transformers.js.
 *
 * `embed` defaults to the passage role for compatibility with the existing
 * EmbeddingPort used while indexing.  Queries should use `embedQueries` so
 * the model's asymmetric retrieval prefixes remain correct.
 */
export class LocalSemanticEmbeddingAdapter implements EmbeddingPort {
  readonly descriptor = LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR;

  private readonly maxBatchSize: number;
  private readonly cacheDir: string | undefined;
  private readonly localFilesOnly: boolean;
  private readonly pipelineFactory: LocalSemanticPipelineFactory;
  private pipelinePromise: Promise<LocalSemanticPipeline> | undefined;

  constructor(options: LocalSemanticEmbeddingOptions = {}) {
    this.maxBatchSize = validateMaxBatchSize(
      options.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE,
    );
    this.cacheDir = resolveLocalSemanticCacheDir(options.cacheDir);
    this.localFilesOnly = options.localFilesOnly ?? false;
    this.pipelineFactory =
      options.pipelineFactory ?? defaultLocalSemanticPipelineFactory;
  }

  /** Load the pipeline once; no model work occurs before this method is used. */
  async load(): Promise<void> {
    await this.getPipeline();
  }

  async embed(
    texts: readonly string[],
    request: LocalSemanticInputRole | EmbeddingRequestOptions = "passage",
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const role =
      typeof request === "string" ? request : (request.role ?? "passage");
    if (
      request !== null &&
      typeof request === "object" &&
      request.signal?.aborted
    ) {
      throw (
        request.signal.reason ??
        new Error("local semantic embedding request aborted")
      );
    }

    const pipeline = await this.getPipeline();
    const vectors: number[][] = [];

    for (let start = 0; start < texts.length; start += this.maxBatchSize) {
      const batch = texts
        .slice(start, start + this.maxBatchSize)
        .map((text) => prefixText(text, role));
      if (
        request !== null &&
        typeof request === "object" &&
        request.signal?.aborted
      ) {
        throw (
          request.signal.reason ??
          new Error("local semantic embedding request aborted")
        );
      }
      const result = await pipeline(batch, {
        pooling: "mean",
        normalize: true,
      });
      vectors.push(...rowsFromPipelineResult(result, batch.length));
    }

    return vectors;
  }

  async embedQueries(texts: readonly string[]): Promise<number[][]> {
    return this.embed(texts, "query");
  }

  async embedPassages(texts: readonly string[]): Promise<number[][]> {
    return this.embed(texts, "passage");
  }

  async dispose(): Promise<void> {
    const pipeline = await this.pipelinePromise;
    await pipeline?.dispose?.();
    this.pipelinePromise = undefined;
  }

  private async getPipeline(): Promise<LocalSemanticPipeline> {
    if (this.pipelinePromise === undefined) {
      const pending = this.pipelineFactory({
        model: MULTILINGUAL_E5_SMALL_MODEL,
        revision: MULTILINGUAL_E5_SMALL_REVISION,
        subfolder: "onnx",
        modelFileName: "model_O4",
        localFilesOnly: this.localFilesOnly,
        ...(this.cacheDir === undefined ? {} : { cacheDir: this.cacheDir }),
      });
      this.pipelinePromise = pending.catch((error: unknown) => {
        // A failed download/model initialization must not poison a long-lived
        // worker forever; a later request may retry after the environment is
        // repaired.  The original error remains visible to the caller.
        this.pipelinePromise = undefined;
        throw error;
      });
    }
    return this.pipelinePromise;
  }
}
