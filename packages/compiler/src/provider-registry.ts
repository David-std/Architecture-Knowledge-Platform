import { createHash } from "node:crypto";
import { z } from "zod";
import {
  ModelResidency,
  ModelRolePolicy,
  isModelResidencyCompatible,
  type ModelResidency as ModelResidencyValue,
  type ModelRolePolicy as ModelRolePolicyValue,
} from "@akp/contracts";
import type { KnowledgeCompilerPort } from "./contracts.js";
import { OpenAICompatibleKnowledgeCompiler } from "./openai-compatible.js";

export interface KnowledgeCompilerEnvironment {
  readonly [key: string]: string | undefined;
  readonly AKP_LLM_PROVIDER?: string;
  readonly AKP_LLM_BASE_URL?: string;
  readonly AKP_LLM_API_KEY?: string;
  readonly AKP_LLM_MODEL?: string;
  readonly AKP_LLM_TIMEOUT_MS?: string;
  readonly AKP_LLM_MAX_RETRIES?: string;
  readonly AKP_LLM_CONCURRENCY?: string;
  readonly AKP_LLM_ENDPOINT_REF?: string;
  readonly AKP_LLM_DATA_RESIDENCY?: string;
  readonly AKP_MODEL_ROLE_POLICIES_JSON?: string;
  readonly AKP_MODEL_ENDPOINTS_JSON?: string;
}

export interface KnowledgeCompilerDescriptor {
  role: string;
  provider: "openai-compatible";
  model: string;
  endpointRef: string;
  policyDataResidency: ModelResidencyValue;
  dataResidency: ModelResidencyValue;
  configurationHash: string;
}

export interface ConfiguredKnowledgeCompiler {
  compiler: KnowledgeCompilerPort;
  descriptor: KnowledgeCompilerDescriptor;
}

export interface KnowledgeCompilerRouteCandidate {
  policy: ModelRolePolicyValue;
  descriptor: KnowledgeCompilerDescriptor;
  supportsStructuredOutput: boolean;
  createConfigured: () => ConfiguredKnowledgeCompiler;
}

export type KnowledgeCompilerRouteRejectionReason =
  | "RESIDENCY_INCOMPATIBLE"
  | "STRUCTURED_OUTPUT_UNAVAILABLE";

export interface KnowledgeCompilerRouteDecision {
  selected: KnowledgeCompilerRouteCandidate | null;
  rejected: Array<{
    candidate: KnowledgeCompilerDescriptor;
    reason: KnowledgeCompilerRouteRejectionReason;
  }>;
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

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new KnowledgeCompilerUnavailableError(
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

function explicitResidency(
  value: string | undefined,
): ModelResidencyValue | null {
  if (!value?.trim()) return null;
  const parsed = ModelResidency.safeParse(value.trim());
  if (!parsed.success) {
    throw new KnowledgeCompilerUnavailableError(
      "AKP_LLM_DATA_RESIDENCY must be LOCAL_ONLY, ORG_APPROVED, or EXTERNAL_ALLOWED",
    );
  }
  return parsed.data;
}

function legacyEndpointResidency(
  baseUrl: string,
  configured: string | undefined,
): ModelResidencyValue {
  const explicit = explicitResidency(configured);
  if (explicit) return explicit;
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new KnowledgeCompilerUnavailableError(
      "AKP_LLM_BASE_URL must be a valid URL",
    );
  }
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(hostname)
    ? "LOCAL_ONLY"
    : "EXTERNAL_ALLOWED";
}

function validateOpenAICompatiblePolicy(policy: ModelRolePolicyValue): void {
  if (policy.provider.toLowerCase() !== "openai-compatible") {
    throw new KnowledgeCompilerUnavailableError(
      `Unsupported KNOWLEDGE_COMPILE provider: ${policy.provider}`,
    );
  }
  if (policy.timeoutMs < 1_000 || policy.timeoutMs > 120_000) {
    throw new KnowledgeCompilerUnavailableError(
      "openai-compatible timeoutMs must be between 1000 and 120000",
    );
  }
  if (policy.maxRetries > 3) {
    throw new KnowledgeCompilerUnavailableError(
      "openai-compatible maxRetries must be between 0 and 3",
    );
  }
}

function resolvePolicyOrder(
  policies: ModelRolePolicyValue[],
): ModelRolePolicyValue[] {
  const roots = policies.filter((policy) => policy.role === "KNOWLEDGE_COMPILE");
  if (roots.length === 0) return [];
  if (roots.length > 1) {
    throw new KnowledgeCompilerUnavailableError(
      "AKP_MODEL_ROLE_POLICIES_JSON contains multiple KNOWLEDGE_COMPILE roots",
    );
  }
  const ordered: ModelRolePolicyValue[] = [];
  const queued = [roots[0]!];
  const seen = new Set<string>();

  while (queued.length) {
    const policy = queued.shift()!;
    const identity = `${policy.role}\0${policy.provider}\0${policy.model}\0${policy.endpointRef ?? ""}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    ordered.push(policy);

    for (const fallback of policy.fallbackRolesOrModels ?? []) {
      const matches = policies.filter(
        (candidate) =>
          candidate.role === fallback || candidate.model === fallback,
      );
      if (matches.length !== 1) {
        throw new KnowledgeCompilerUnavailableError(
          `Fallback ${fallback} must resolve to exactly one model-role policy`,
        );
      }
      queued.push(matches[0]!);
    }
  }
  return ordered;
}

function endpointBindings(
  env: KnowledgeCompilerEnvironment,
): Record<string, EndpointBinding> {
  const raw = env.AKP_MODEL_ENDPOINTS_JSON?.trim();
  if (!raw) return {};
  const parsed = z.record(z.string().min(1), EndpointBinding).safeParse(
    parseJson(raw, "AKP_MODEL_ENDPOINTS_JSON"),
  );
  if (!parsed.success) {
    throw new KnowledgeCompilerUnavailableError(
      "AKP_MODEL_ENDPOINTS_JSON does not match the endpoint registry schema",
    );
  }
  return parsed.data;
}

function candidateFromPolicy(
  policy: ModelRolePolicyValue,
  endpointRef: string,
  endpoint: EndpointBinding,
  env: KnowledgeCompilerEnvironment,
): KnowledgeCompilerRouteCandidate {
  validateOpenAICompatiblePolicy(policy);
  if (!isModelResidencyCompatible(policy.dataResidency, endpoint.dataResidency)) {
    throw new KnowledgeCompilerUnavailableError(
      `Endpoint ${endpointRef} residency ${endpoint.dataResidency} violates model-role policy ${policy.dataResidency}`,
    );
  }
  const descriptor: KnowledgeCompilerDescriptor = {
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
    createConfigured: () => {
      const apiKey = endpoint.apiKeyEnv
        ? env[endpoint.apiKeyEnv]?.trim()
        : undefined;
      if (endpoint.apiKeyEnv && !apiKey) {
        throw new KnowledgeCompilerUnavailableError(
          `Configured API-key environment variable is unavailable for endpointRef ${endpointRef}`,
        );
      }
      return {
        compiler: new OpenAICompatibleKnowledgeCompiler({
          baseUrl: endpoint.baseUrl,
          model: policy.model,
          timeoutMs: policy.timeoutMs,
          maxRetries: policy.maxRetries,
          ...(apiKey ? { apiKey } : {}),
        }),
        descriptor,
      };
    },
  };
}

function configuredPolicyCandidates(
  env: KnowledgeCompilerEnvironment,
): KnowledgeCompilerRouteCandidate[] | null {
  const raw = env.AKP_MODEL_ROLE_POLICIES_JSON?.trim();
  if (!raw) return null;
  const parsed = z
    .array(ModelRolePolicy)
    .max(100)
    .safeParse(parseJson(raw, "AKP_MODEL_ROLE_POLICIES_JSON"));
  if (!parsed.success) {
    throw new KnowledgeCompilerUnavailableError(
      "AKP_MODEL_ROLE_POLICIES_JSON does not match ModelRolePolicy[]",
    );
  }
  const endpoints = endpointBindings(env);
  return resolvePolicyOrder(parsed.data).map((policy) => {
    const endpointRef = policy.endpointRef?.trim();
    if (!endpointRef) {
      throw new KnowledgeCompilerUnavailableError(
        `Model-role policy ${policy.role}/${policy.model} requires endpointRef`,
      );
    }
    const endpoint = endpoints[endpointRef];
    if (!endpoint) {
      throw new KnowledgeCompilerUnavailableError(
        `No endpoint binding exists for endpointRef ${endpointRef}`,
      );
    }
    return candidateFromPolicy(policy, endpointRef, endpoint, env);
  });
}

function legacyCandidate(
  env: KnowledgeCompilerEnvironment,
): KnowledgeCompilerRouteCandidate | null {
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
  const concurrency = positiveInteger(
    env.AKP_LLM_CONCURRENCY,
    "AKP_LLM_CONCURRENCY",
    1,
  );
  const endpointRef =
    env.AKP_LLM_ENDPOINT_REF?.trim() || "legacy-knowledge-compile";
  const policy = ModelRolePolicy.parse({
    role: "KNOWLEDGE_COMPILE",
    provider: "openai-compatible",
    model,
    endpointRef,
    timeoutMs,
    maxRetries,
    concurrency,
    structuredOutputRequired: true,
    dataResidency: legacyEndpointResidency(
      baseUrl,
      env.AKP_LLM_DATA_RESIDENCY,
    ),
    degradationSafe: false,
  });
  const descriptor: KnowledgeCompilerDescriptor = {
    role: policy.role,
    provider: "openai-compatible",
    model,
    endpointRef,
    policyDataResidency: policy.dataResidency,
    dataResidency: policy.dataResidency,
    configurationHash: configurationHash(policy, endpointRef, {
      baseUrl,
      dataResidency: policy.dataResidency,
      ...(env.AKP_LLM_API_KEY?.trim()
        ? { apiKeyEnv: "AKP_LLM_API_KEY" }
        : {}),
    }),
  };
  validateOpenAICompatiblePolicy(policy);
  return {
    policy,
    descriptor,
    supportsStructuredOutput: true,
    createConfigured: () => ({
      compiler: new OpenAICompatibleKnowledgeCompiler({
        baseUrl,
        model,
        timeoutMs,
        maxRetries,
        ...(env.AKP_LLM_API_KEY?.trim()
          ? { apiKey: env.AKP_LLM_API_KEY.trim() }
          : {}),
      }),
      descriptor,
    }),
  };
}

export function createKnowledgeCompilerRouteCandidates(
  env: KnowledgeCompilerEnvironment = process.env,
): KnowledgeCompilerRouteCandidate[] {
  const configured = configuredPolicyCandidates(env);
  if (configured) return configured;
  const legacy = legacyCandidate(env);
  return legacy ? [legacy] : [];
}

export function routeKnowledgeCompilerCandidates(
  candidates: KnowledgeCompilerRouteCandidate[],
  requirements: {
    dataResidency: ModelResidencyValue;
    structuredOutputRequired?: boolean;
  },
): KnowledgeCompilerRouteDecision {
  const rejected: KnowledgeCompilerRouteDecision["rejected"] = [];
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
    return { selected: candidate, rejected };
  }
  return { selected: null, rejected };
}

/**
 * Backward-compatible direct resolver for callers that do not need contextual
 * routing. New runtime paths should route candidates after loading source,
 * space, and profile constraints.
 */
export function createConfiguredKnowledgeCompiler(
  env: KnowledgeCompilerEnvironment = process.env,
): ConfiguredKnowledgeCompiler | null {
  const candidate = createKnowledgeCompilerRouteCandidates(env)[0];
  return candidate ? candidate.createConfigured() : null;
}
