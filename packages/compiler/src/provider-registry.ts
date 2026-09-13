import type { KnowledgeCompilerPort } from "./contracts.js";
import { OpenAICompatibleKnowledgeCompiler } from "./openai-compatible.js";

export interface KnowledgeCompilerEnvironment {
  readonly AKP_LLM_PROVIDER?: string;
  readonly AKP_LLM_BASE_URL?: string;
  readonly AKP_LLM_API_KEY?: string;
  readonly AKP_LLM_MODEL?: string;
  readonly AKP_LLM_TIMEOUT_MS?: string;
  readonly AKP_LLM_MAX_RETRIES?: string;
}

export interface ConfiguredKnowledgeCompiler {
  compiler: KnowledgeCompilerPort;
  descriptor: {
    provider: "openai-compatible";
    model: string;
    baseUrl: string;
  };
}

export class KnowledgeCompilerUnavailableError extends Error {
  readonly code = "KNOWLEDGE_COMPILER_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "KnowledgeCompilerUnavailableError";
  }
}

function positiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new KnowledgeCompilerUnavailableError(
      `${name} must be a positive integer`,
    );
  }
  return parsed;
}

function nonNegativeInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || !value.trim()) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new KnowledgeCompilerUnavailableError(
      `${name} must be a non-negative integer`,
    );
  }
  return parsed;
}

/**
 * Resolve the explicitly configured compiler. Unset/disabled configuration is
 * the supported source-summary fallback; malformed enabled configuration fails
 * visibly instead of silently pretending semantic compilation occurred.
 */
export function createConfiguredKnowledgeCompiler(
  env: KnowledgeCompilerEnvironment = process.env,
): ConfiguredKnowledgeCompiler | null {
  const provider = env.AKP_LLM_PROVIDER?.trim().toLowerCase();
  if (!provider || provider === "disabled") return null;
  if (provider !== "openai-compatible") {
    throw new KnowledgeCompilerUnavailableError(
      `Unsupported AKP_LLM_PROVIDER: ${provider}`,
    );
  }

  const baseUrl = env.AKP_LLM_BASE_URL?.trim();
  if (!baseUrl) {
    throw new KnowledgeCompilerUnavailableError(
      "AKP_LLM_BASE_URL is required for openai-compatible compilation",
    );
  }
  const model = env.AKP_LLM_MODEL?.trim();
  if (!model) {
    throw new KnowledgeCompilerUnavailableError(
      "AKP_LLM_MODEL is required for openai-compatible compilation",
    );
  }

  const timeoutMs = positiveInteger(
    env.AKP_LLM_TIMEOUT_MS,
    "AKP_LLM_TIMEOUT_MS",
    30_000,
  );
  const maxRetries = nonNegativeInteger(
    env.AKP_LLM_MAX_RETRIES,
    "AKP_LLM_MAX_RETRIES",
    1,
  );
  if (maxRetries > 3) {
    throw new KnowledgeCompilerUnavailableError(
      "AKP_LLM_MAX_RETRIES must be between 0 and 3",
    );
  }

  return {
    compiler: new OpenAICompatibleKnowledgeCompiler({
      baseUrl,
      model,
      timeoutMs,
      maxRetries,
      ...(env.AKP_LLM_API_KEY?.trim()
        ? { apiKey: env.AKP_LLM_API_KEY.trim() }
        : {}),
    }),
    descriptor: {
      provider: "openai-compatible",
      model,
      baseUrl,
    },
  };
}
