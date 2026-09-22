import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ModelResidency,
  ModelRolePolicy,
  isModelResidencyCompatible,
  type ModelResidency as ModelResidencyValue,
  type ModelRolePolicy as ModelRolePolicyValue,
} from "@akp/contracts";

export interface ModelRoleRuntimeEnvironment {
  readonly [key: string]: string | undefined;
  readonly AKP_MODEL_ROLE_POLICIES_JSON?: string;
  readonly AKP_MODEL_ENDPOINTS_JSON?: string;
}

export interface ModelRoleDescriptor {
  role: string;
  provider: "openai-compatible";
  model: string;
  endpointRef: string;
  policyDataResidency: ModelResidencyValue;
  dataResidency: ModelResidencyValue;
  configurationHash: string;
}

export interface ModelTextGenerationInput {
  system: string;
  user: string;
  responseFormat?: "text" | "json_object";
}

export interface ModelTextGenerationUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ModelTextGenerationResult {
  text: string;
  usage?: ModelTextGenerationUsage;
}

export interface ModelTextGenerator {
  generate(input: ModelTextGenerationInput): Promise<ModelTextGenerationResult>;
}

export interface ModelRoleRouteCandidate {
  policy: ModelRolePolicyValue;
  descriptor: ModelRoleDescriptor;
  supportsStructuredOutput: boolean;
  createTextGenerator: () => ModelTextGenerator;
}

export type ModelRoleRouteRejectionReason =
  | "RESIDENCY_INCOMPATIBLE"
  | "STRUCTURED_OUTPUT_UNAVAILABLE";

export interface ModelRoleRouteDecision {
  selected: ModelRoleRouteCandidate | null;
  eligible: ModelRoleRouteCandidate[];
  rejected: Array<{
    candidate: ModelRoleDescriptor;
    reason: ModelRoleRouteRejectionReason;
  }>;
}

export class ModelRoleRuntimeUnavailableError extends Error {
  readonly code = "MODEL_ROLE_RUNTIME_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "ModelRoleRuntimeUnavailableError";
  }
}

const EndpointBinding = z
  .object({
    baseUrl: z.string().url(),
    dataResidency: ModelResidency,
    apiKeyEnv: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
  })
  .strict();

type EndpointBinding = z.infer<typeof EndpointBinding>;

interface OpenAICompatibleTextOptions {
  baseUrl: string;
  apiKey?: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens?: number;
}

interface ConcurrencyGate {
  limit: number;
  active: number;
  waiters: Array<() => void>;
}

const concurrencyGates = new Map<string, ConcurrencyGate>();
const MAX_PROVIDER_RESPONSE_BYTES = 1_000_000;

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ModelRoleRuntimeUnavailableError(
      `${name} must contain valid JSON`,
    );
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function configurationHash(
  policy: ModelRolePolicyValue,
  endpointRef: string,
  endpoint: EndpointBinding,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        stableValue({
          policy,
          endpoint: {
            endpointRef,
            baseUrl: endpoint.baseUrl,
            dataResidency: endpoint.dataResidency,
            apiKeyEnv: endpoint.apiKeyEnv ?? null,
          },
        }),
      ),
    )
    .digest("hex");
}

function endpointBindings(
  env: ModelRoleRuntimeEnvironment,
): Record<string, EndpointBinding> {
  const raw = env.AKP_MODEL_ENDPOINTS_JSON?.trim();
  if (!raw) return {};
  const parsed = z
    .record(z.string().min(1), EndpointBinding)
    .safeParse(parseJson(raw, "AKP_MODEL_ENDPOINTS_JSON"));
  if (!parsed.success) {
    throw new ModelRoleRuntimeUnavailableError(
      "AKP_MODEL_ENDPOINTS_JSON does not match the endpoint registry schema",
    );
  }
  return parsed.data;
}

function validatePolicy(policy: ModelRolePolicyValue): void {
  if (policy.provider.toLowerCase() !== "openai-compatible") {
    throw new ModelRoleRuntimeUnavailableError(
      `Unsupported ${policy.role} provider: ${policy.provider}`,
    );
  }
  if (policy.timeoutMs < 1_000 || policy.timeoutMs > 120_000) {
    throw new ModelRoleRuntimeUnavailableError(
      "openai-compatible timeoutMs must be between 1000 and 120000",
    );
  }
  if (policy.maxRetries > 3) {
    throw new ModelRoleRuntimeUnavailableError(
      "openai-compatible maxRetries must be between 0 and 3",
    );
  }
  if (policy.maxInputTokens !== undefined) {
    throw new ModelRoleRuntimeUnavailableError(
      "openai-compatible maxInputTokens requires an exact provider tokenizer adapter",
    );
  }
  if (policy.costCeiling !== undefined) {
    throw new ModelRoleRuntimeUnavailableError(
      "openai-compatible costCeiling requires provider cost accounting",
    );
  }
}

function resolvePolicyOrder(
  policies: ModelRolePolicyValue[],
  rootRole: string,
): ModelRolePolicyValue[] {
  const roots = policies.filter((policy) => policy.role === rootRole);
  if (roots.length === 0) return [];
  if (roots.length > 1) {
    throw new ModelRoleRuntimeUnavailableError(
      `AKP_MODEL_ROLE_POLICIES_JSON contains multiple ${rootRole} roots`,
    );
  }

  const ordered: ModelRolePolicyValue[] = [];
  const queued = [roots[0]!];
  const seen = new Set<string>();
  while (queued.length) {
    const policy = queued.shift()!;
    const identity = [
      policy.role,
      policy.provider,
      policy.model,
      policy.endpointRef ?? "",
    ].join("\0");
    if (seen.has(identity)) continue;
    seen.add(identity);
    ordered.push(policy);

    for (const fallback of policy.fallbackRolesOrModels ?? []) {
      const matches = policies.filter(
        (candidate) =>
          candidate.role === fallback || candidate.model === fallback,
      );
      if (matches.length !== 1) {
        throw new ModelRoleRuntimeUnavailableError(
          `Fallback ${fallback} must resolve to exactly one model-role policy`,
        );
      }
      queued.push(matches[0]!);
    }
  }
  return ordered;
}

async function acquireConcurrency(
  key: string,
  limit: number,
): Promise<() => void> {
  let gate = concurrencyGates.get(key);
  if (!gate) {
    gate = { limit, active: 0, waiters: [] };
    concurrencyGates.set(key, gate);
  } else if (gate.limit !== limit) {
    throw new ModelRoleRuntimeUnavailableError(
      "Model-role concurrency changed without a configuration-hash change",
    );
  }

  if (gate.active >= gate.limit) {
    await new Promise<void>((resolve) => gate!.waiters.push(resolve));
  } else {
    gate.active += 1;
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = gate!.waiters.shift();
    if (next) {
      next();
      return;
    }
    gate!.active -= 1;
    if (gate!.active === 0) concurrencyGates.delete(key);
  };
}

function joinEndpoint(baseUrl: string): string {
  return `${baseUrl.replaceAll(/\/+$/g, "")}/chat/completions`;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function usageFromResponse(value: unknown): ModelTextGenerationUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return undefined;
  }
  const record = usage as Record<string, unknown>;
  const inputTokens = Number(record.prompt_tokens);
  const outputTokens = Number(record.completion_tokens);
  const totalTokens = Number(record.total_tokens);
  const result: ModelTextGenerationUsage = {};
  if (Number.isFinite(inputTokens) && inputTokens >= 0) {
    result.inputTokens = inputTokens;
  }
  if (Number.isFinite(outputTokens) && outputTokens >= 0) {
    result.outputTokens = outputTokens;
  }
  if (Number.isFinite(totalTokens) && totalTokens >= 0) {
    result.totalTokens = totalTokens;
  }
  return Object.keys(result).length ? result : undefined;
}

function contentFromResponse(value: unknown): string {
  if (!value || typeof value !== "object") {
    throw new Error("MODEL_PROVIDER_RESPONSE_INVALID");
  }
  const choices = (value as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length) {
    throw new Error("MODEL_PROVIDER_CHOICES_MISSING");
  }
  const message = (choices[0] as { message?: unknown })?.message;
  if (!message || typeof message !== "object") {
    throw new Error("MODEL_PROVIDER_MESSAGE_MISSING");
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("MODEL_PROVIDER_CONTENT_MISSING");
  }
  return content.trim();
}

class OpenAICompatibleTextGenerator implements ModelTextGenerator {
  readonly #options: OpenAICompatibleTextOptions;

  constructor(options: OpenAICompatibleTextOptions) {
    this.#options = options;
  }

  async generate(
    input: ModelTextGenerationInput,
  ): Promise<ModelTextGenerationResult> {
    const requestBody = JSON.stringify({
      model: this.#options.model,
      temperature: 0,
      ...(input.responseFormat === "json_object"
        ? { response_format: { type: "json_object" } }
        : {}),
      ...(this.#options.maxOutputTokens === undefined
        ? {}
        : { max_tokens: this.#options.maxOutputTokens }),
      messages: [
        { role: "system", content: input.system },
        { role: "user", content: input.user },
      ],
    });

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.#options.maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.#options.timeoutMs,
      );
      try {
        const response = await fetch(joinEndpoint(this.#options.baseUrl), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.#options.apiKey
              ? { authorization: `Bearer ${this.#options.apiKey}` }
              : {}),
          },
          body: requestBody,
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = isRetryableStatus(response.status);
          lastError = new Error(
            `MODEL_PROVIDER_HTTP_${response.status}${retryable ? "_RETRYABLE" : ""}`,
          );
          if (!retryable || attempt === this.#options.maxRetries) {
            throw lastError;
          }
        } else {
          const responseText = await response.text();
          if (
            Buffer.byteLength(responseText, "utf8") >
            MAX_PROVIDER_RESPONSE_BYTES
          ) {
            throw new Error("MODEL_PROVIDER_RESPONSE_TOO_LARGE");
          }
          let responseJson: unknown;
          try {
            responseJson = JSON.parse(responseText);
          } catch {
            throw new Error("MODEL_PROVIDER_RESPONSE_INVALID");
          }
          return {
            text: contentFromResponse(responseJson),
            ...(usageFromResponse(responseJson)
              ? { usage: usageFromResponse(responseJson) }
              : {}),
          };
        }
      } catch (error) {
        lastError = error;
        const abort = error instanceof Error && error.name === "AbortError";
        const networkFailure = error instanceof TypeError;
        const retryable =
          abort ||
          networkFailure ||
          (error instanceof Error && error.message.endsWith("_RETRYABLE"));
        if (!retryable || attempt === this.#options.maxRetries) {
          if (abort) throw new Error("MODEL_PROVIDER_TIMEOUT");
          if (networkFailure) throw new Error("MODEL_PROVIDER_NETWORK");
          throw error;
        }
      } finally {
        clearTimeout(timeout);
      }
      await sleep(250 * 2 ** attempt);
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("MODEL_PROVIDER_FAILED");
  }
}

function candidateFromPolicy(
  policy: ModelRolePolicyValue,
  endpointRef: string,
  endpoint: EndpointBinding,
  env: ModelRoleRuntimeEnvironment,
): ModelRoleRouteCandidate {
  validatePolicy(policy);
  if (
    !isModelResidencyCompatible(policy.dataResidency, endpoint.dataResidency)
  ) {
    throw new ModelRoleRuntimeUnavailableError(
      `Endpoint ${endpointRef} residency ${endpoint.dataResidency} violates model-role policy ${policy.dataResidency}`,
    );
  }

  const descriptor: ModelRoleDescriptor = {
    role: policy.role,
    provider: "openai-compatible",
    model: policy.model,
    endpointRef,
    policyDataResidency: policy.dataResidency,
    dataResidency: endpoint.dataResidency,
    configurationHash: configurationHash(policy, endpointRef, endpoint),
  };

  return {
    policy,
    descriptor,
    supportsStructuredOutput: true,
    createTextGenerator: () => {
      const apiKey = endpoint.apiKeyEnv
        ? env[endpoint.apiKeyEnv]?.trim()
        : undefined;
      if (endpoint.apiKeyEnv && !apiKey) {
        throw new ModelRoleRuntimeUnavailableError(
          `Configured API-key environment variable is unavailable for endpointRef ${endpointRef}`,
        );
      }
      const delegate = new OpenAICompatibleTextGenerator({
        baseUrl: endpoint.baseUrl,
        model: policy.model,
        timeoutMs: policy.timeoutMs,
        maxRetries: policy.maxRetries,
        ...(policy.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: policy.maxOutputTokens }),
        ...(apiKey ? { apiKey } : {}),
      });
      return {
        generate: async (input) => {
          const release = await acquireConcurrency(
            descriptor.configurationHash,
            policy.concurrency,
          );
          try {
            return await delegate.generate(input);
          } finally {
            release();
          }
        },
      };
    },
  };
}

export function createModelRoleRouteCandidates(
  role: string,
  env: ModelRoleRuntimeEnvironment = process.env,
): ModelRoleRouteCandidate[] {
  const normalizedRole = role.trim();
  if (!normalizedRole) {
    throw new ModelRoleRuntimeUnavailableError("Model role is required");
  }
  const raw = env.AKP_MODEL_ROLE_POLICIES_JSON?.trim();
  if (!raw) return [];
  const parsed = z
    .array(ModelRolePolicy)
    .max(100)
    .safeParse(parseJson(raw, "AKP_MODEL_ROLE_POLICIES_JSON"));
  if (!parsed.success) {
    throw new ModelRoleRuntimeUnavailableError(
      "AKP_MODEL_ROLE_POLICIES_JSON does not match ModelRolePolicy[]",
    );
  }
  const endpoints = endpointBindings(env);
  return resolvePolicyOrder(parsed.data, normalizedRole).map((policy) => {
    const endpointRef = policy.endpointRef?.trim();
    if (!endpointRef) {
      throw new ModelRoleRuntimeUnavailableError(
        `Model-role policy ${policy.role}/${policy.model} requires endpointRef`,
      );
    }
    const endpoint = endpoints[endpointRef];
    if (!endpoint) {
      throw new ModelRoleRuntimeUnavailableError(
        `No endpoint binding exists for endpointRef ${endpointRef}`,
      );
    }
    return candidateFromPolicy(policy, endpointRef, endpoint, env);
  });
}

export function routeModelRoleCandidates(
  candidates: ModelRoleRouteCandidate[],
  requirements: {
    dataResidency: ModelResidencyValue;
    structuredOutputRequired?: boolean;
  },
): ModelRoleRouteDecision {
  const rejected: ModelRoleRouteDecision["rejected"] = [];
  const eligible: ModelRoleRouteCandidate[] = [];
  for (const candidate of candidates) {
    if (
      !isModelResidencyCompatible(
        requirements.dataResidency,
        candidate.descriptor.dataResidency,
      )
    ) {
      rejected.push({
        candidate: candidate.descriptor,
        reason: "RESIDENCY_INCOMPATIBLE",
      });
      continue;
    }
    if (
      requirements.structuredOutputRequired &&
      !candidate.supportsStructuredOutput
    ) {
      rejected.push({
        candidate: candidate.descriptor,
        reason: "STRUCTURED_OUTPUT_UNAVAILABLE",
      });
      continue;
    }
    eligible.push(candidate);
  }
  return {
    selected: eligible[0] ?? null,
    eligible,
    rejected,
  };
}

export function modelRoleProviderFailureCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  return /^MODEL_PROVIDER_[A-Z0-9_]+$/.test(error.message)
    ? error.message
    : null;
}
