import { createHash } from "node:crypto";
import {
  DeterministicEmbeddingAdapter,
  type EmbeddingDescriptor,
  type EmbeddingProvider,
} from "./embeddings.js";
import {
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  LocalSemanticEmbeddingAdapter,
} from "./local-semantic-embedding.js";
import {
  OpenAICompatibleEmbeddingAdapter,
  type OpenAICompatibleInputStrategy,
} from "./openai-compatible-embedding.js";

export type ConfiguredEmbeddingProviderKind =
  "local-multilingual-e5" | "openai-compatible" | "deterministic-test";

export interface EmbeddingProviderEnvironment {
  readonly AKP_EMBEDDING_PROVIDER?: string;
  readonly AKP_EMBEDDING_BASE_URL?: string;
  readonly AKP_EMBEDDING_MODEL?: string;
  readonly AKP_EMBEDDING_MODEL_REVISION?: string;
  readonly AKP_EMBEDDING_DIMENSIONS?: string;
  readonly AKP_EMBEDDING_NORMALIZATION?: string;
  readonly AKP_EMBEDDING_INPUT_STRATEGY?: string;
  readonly AKP_EMBEDDING_CONFIGURATION_VERSION?: string;
  readonly AKP_EMBEDDING_API_KEY?: string;
  readonly AKP_EMBEDDING_TIMEOUT_MS?: string;
  readonly AKP_EMBEDDING_MAX_BATCH_SIZE?: string;
  readonly AKP_EMBEDDING_MAX_RETRIES?: string;
  readonly AKP_MODEL_CACHE_DIR?: string;
  readonly AKP_LOCAL_FILES_ONLY?: string;
  readonly AKP_ALLOW_DETERMINISTIC_EMBEDDINGS?: string;
  readonly NODE_ENV?: string;
}

export interface ActiveEmbeddingGenerationDescriptor extends EmbeddingDescriptor {
  generationId: string;
  spaceId: string;
  vaultId: string;
  corpusRevision: string;
}

export type EmbeddingProviderResolver = (
  descriptor: ActiveEmbeddingGenerationDescriptor,
) => EmbeddingProvider | Promise<EmbeddingProvider>;

export class EmbeddingProviderUnavailableError extends Error {
  readonly code = "EMBEDDING_PROVIDER_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "EmbeddingProviderUnavailableError";
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

function redactRuntimeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
    .replace(
      /\b(api[_ -]?key|authorization|credential|password|passwd|secret|token)\b\s*[:=]\s*[^\s,;]+/giu,
      "$1=[REDACTED]",
    )
    .replace(/(https?:\/\/)[^/\s:@]+:[^@\s/]+@/giu, "$1[REDACTED]@")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu,
      "[REDACTED]",
    );
}

/** Serialize redacted runtime metadata without ever retaining credentials. */
export function serializeEmbeddingRuntime(
  runtime: EmbeddingDescriptor["runtime"],
): string {
  if (typeof runtime === "string") return redactRuntimeText(runtime.trim());
  const secretKey =
    /(?:api[_-]?key|authorization|credential|password|secret|token)/iu;
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [
            key,
            secretKey.test(key) ? "[REDACTED]" : sanitize(nested),
          ]),
      );
    }
    if (typeof value === "string") return redactRuntimeText(value);
    return value;
  };
  return JSON.stringify(sanitize(runtime));
}

export function configurationHashForEmbeddingDescriptor(
  descriptor: EmbeddingDescriptor,
): string {
  if (descriptor.configurationHash) return descriptor.configurationHash;
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          provider: descriptor.provider,
          model: descriptor.model,
          modelRevision: descriptor.modelRevision,
          dimensions: descriptor.dimensions,
          normalization: descriptor.normalization,
          inputStrategy: descriptor.inputStrategy,
          configurationVersion: descriptor.configurationVersion,
          runtime: serializeEmbeddingRuntime(descriptor.runtime),
        }),
      ),
    )
    .digest("hex");
}

function descriptorDifference(
  expected: EmbeddingDescriptor,
  actual: EmbeddingDescriptor,
): string | null {
  const fields: Array<keyof Omit<EmbeddingDescriptor, "runtime">> = [
    "provider",
    "model",
    "modelRevision",
    "dimensions",
    "normalization",
    "inputStrategy",
    "configurationVersion",
  ];
  for (const field of fields) {
    if (expected[field] !== actual[field]) return String(field);
  }
  if (
    expected.configurationHash &&
    expected.configurationHash !==
      configurationHashForEmbeddingDescriptor(actual)
  ) {
    return "configurationHash";
  }
  return serializeEmbeddingRuntime(expected.runtime) ===
    serializeEmbeddingRuntime(actual.runtime)
    ? null
    : "runtime";
}

export function assertEmbeddingDescriptorCompatible(
  expected: EmbeddingDescriptor,
  actual: EmbeddingDescriptor,
): void {
  const difference = descriptorDifference(expected, actual);
  if (difference) {
    throw new EmbeddingProviderUnavailableError(
      `Configured embedding provider does not match active generation field: ${difference}`,
    );
  }
}

function positiveInteger(
  value: string | undefined,
  name: string,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new EmbeddingProviderUnavailableError(
      `${name} must be a positive integer`,
    );
  }
  return parsed;
}

function nonNegativeInteger(
  value: string | undefined,
  name: string,
  fallback?: number,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new EmbeddingProviderUnavailableError(
      `${name} must be a non-negative integer`,
    );
  }
  return parsed;
}

function configuredOpenAIProvider(
  env: EmbeddingProviderEnvironment,
  expected?: ActiveEmbeddingGenerationDescriptor,
): OpenAICompatibleEmbeddingAdapter {
  const baseUrl = env.AKP_EMBEDDING_BASE_URL?.trim();
  if (!baseUrl) {
    throw new EmbeddingProviderUnavailableError(
      "AKP_EMBEDDING_BASE_URL is required for an OpenAI-compatible generation",
    );
  }
  const model = expected?.model ?? env.AKP_EMBEDDING_MODEL?.trim();
  if (!model) {
    throw new EmbeddingProviderUnavailableError(
      "AKP_EMBEDDING_MODEL is required for an OpenAI-compatible generation",
    );
  }
  const dimensions =
    expected?.dimensions ??
    positiveInteger(env.AKP_EMBEDDING_DIMENSIONS, "AKP_EMBEDDING_DIMENSIONS");
  const inputStrategy = (expected?.inputStrategy ??
    env.AKP_EMBEDDING_INPUT_STRATEGY ??
    "none") as OpenAICompatibleInputStrategy;
  if (
    inputStrategy !== "none" &&
    inputStrategy !== "e5-query-passage-prefix-v1"
  ) {
    throw new EmbeddingProviderUnavailableError(
      "AKP_EMBEDDING_INPUT_STRATEGY is unsupported",
    );
  }
  const configurationVersion =
    expected?.configurationVersion ??
    env.AKP_EMBEDDING_CONFIGURATION_VERSION?.trim();
  return new OpenAICompatibleEmbeddingAdapter({
    baseUrl,
    model,
    dimensions,
    modelRevision:
      expected?.modelRevision ??
      env.AKP_EMBEDDING_MODEL_REVISION?.trim() ??
      "unversioned",
    normalization:
      expected?.normalization ??
      env.AKP_EMBEDDING_NORMALIZATION?.trim() ??
      "provider-defined",
    inputStrategy,
    ...(configurationVersion ? { configurationVersion } : {}),
    ...(env.AKP_EMBEDDING_API_KEY ? { apiKey: env.AKP_EMBEDDING_API_KEY } : {}),
    timeoutMs: positiveInteger(
      env.AKP_EMBEDDING_TIMEOUT_MS,
      "AKP_EMBEDDING_TIMEOUT_MS",
      30_000,
    ),
    maxBatchSize: positiveInteger(
      env.AKP_EMBEDDING_MAX_BATCH_SIZE,
      "AKP_EMBEDDING_MAX_BATCH_SIZE",
      64,
    ),
    maxRetries: nonNegativeInteger(
      env.AKP_EMBEDDING_MAX_RETRIES,
      "AKP_EMBEDDING_MAX_RETRIES",
      2,
    ),
  });
}

/**
 * Resolve the explicitly selected indexing provider. There is deliberately no
 * production default: an unset provider means that vector generation is not
 * requested. The deterministic provider requires an explicit test-only opt-in.
 */
export function createConfiguredEmbeddingProvider(
  env: EmbeddingProviderEnvironment = process.env,
): EmbeddingProvider | null {
  const kind = env.AKP_EMBEDDING_PROVIDER?.trim() as
    ConfiguredEmbeddingProviderKind | undefined;
  if (!kind) return null;
  if (kind === "local-multilingual-e5") {
    return new LocalSemanticEmbeddingAdapter({
      ...(env.AKP_MODEL_CACHE_DIR ? { cacheDir: env.AKP_MODEL_CACHE_DIR } : {}),
      localFilesOnly: env.AKP_LOCAL_FILES_ONLY === "1",
      maxBatchSize: positiveInteger(
        env.AKP_EMBEDDING_MAX_BATCH_SIZE,
        "AKP_EMBEDDING_MAX_BATCH_SIZE",
        16,
      ),
    });
  }
  if (kind === "openai-compatible") return configuredOpenAIProvider(env);
  if (kind === "deterministic-test") {
    if (
      env.NODE_ENV === "production" ||
      (env.NODE_ENV !== "test" &&
        env.AKP_ALLOW_DETERMINISTIC_EMBEDDINGS !== "true")
    ) {
      throw new EmbeddingProviderUnavailableError(
        "Deterministic embeddings are unavailable in production and require an explicit test/benchmark opt-in",
      );
    }
    return new DeterministicEmbeddingAdapter();
  }
  throw new EmbeddingProviderUnavailableError(
    `Unsupported AKP_EMBEDDING_PROVIDER: ${String(kind)}`,
  );
}

/** Resolve the exact provider/configuration recorded by an active generation. */
export function createEmbeddingProviderForGeneration(
  generation: ActiveEmbeddingGenerationDescriptor,
  env: EmbeddingProviderEnvironment = process.env,
): EmbeddingProvider {
  let provider: EmbeddingProvider;
  if (generation.provider === LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.provider) {
    provider = new LocalSemanticEmbeddingAdapter({
      ...(env.AKP_MODEL_CACHE_DIR ? { cacheDir: env.AKP_MODEL_CACHE_DIR } : {}),
      localFilesOnly: env.AKP_LOCAL_FILES_ONLY === "1",
      maxBatchSize: positiveInteger(
        env.AKP_EMBEDDING_MAX_BATCH_SIZE,
        "AKP_EMBEDDING_MAX_BATCH_SIZE",
        16,
      ),
    });
  } else if (generation.provider === "openai-compatible-http") {
    provider = configuredOpenAIProvider(env, generation);
  } else if (generation.provider === "local-deterministic") {
    if (
      env.NODE_ENV === "production" ||
      (env.NODE_ENV !== "test" &&
        env.AKP_ALLOW_DETERMINISTIC_EMBEDDINGS !== "true")
    ) {
      throw new EmbeddingProviderUnavailableError(
        "The active deterministic generation is unavailable in production and is reserved for tests/benchmarks",
      );
    }
    provider = new DeterministicEmbeddingAdapter();
  } else {
    throw new EmbeddingProviderUnavailableError(
      `No embedding provider is registered for ${generation.provider}`,
    );
  }
  assertEmbeddingDescriptorCompatible(generation, provider.descriptor);
  return provider;
}

/** Embeds queries with the exact provider and preprocessing of a generation. */
export class QueryEmbeddingService {
  constructor(
    private readonly resolveProvider: EmbeddingProviderResolver = createEmbeddingProviderForGeneration,
  ) {}

  async embedQuery(
    query: string,
    generation: ActiveEmbeddingGenerationDescriptor,
    signal?: AbortSignal,
  ): Promise<number[]> {
    if (!query.trim()) throw new Error("EMBEDDING_QUERY_REQUIRED");
    const provider = await this.resolveProvider(generation);
    assertEmbeddingDescriptorCompatible(generation, provider.descriptor);
    const vectors = await provider.embed([query], {
      role: "query",
      ...(signal ? { signal } : {}),
    });
    const vector = vectors[0];
    if (!vector || vector.length !== generation.dimensions) {
      throw new Error("EMBEDDING_QUERY_DIMENSION_MISMATCH");
    }
    if (vector.some((value) => !Number.isFinite(value))) {
      throw new Error("EMBEDDING_QUERY_VECTOR_INVALID");
    }
    if (generation.normalization.toLowerCase() === "l2") {
      const norm = Math.hypot(...vector);
      if (!Number.isFinite(norm) || Math.abs(norm - 1) > 1e-4) {
        throw new Error("EMBEDDING_QUERY_NORMALIZATION_MISMATCH");
      }
    }
    return vector;
  }
}
