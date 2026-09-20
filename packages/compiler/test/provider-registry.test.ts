import { describe, expect, it } from "vitest";
import {
  KnowledgeCompilerUnavailableError,
  createConfiguredKnowledgeCompiler,
  createKnowledgeCompilerRouteCandidates,
  routeKnowledgeCompilerCandidates,
} from "../src/index.js";

describe("knowledge compiler provider registry", () => {
  it("uses the explicit source-summary fallback when disabled or unset", () => {
    expect(createConfiguredKnowledgeCompiler({})).toBeNull();
    expect(
      createConfiguredKnowledgeCompiler({ AKP_LLM_PROVIDER: "disabled" }),
    ).toBeNull();
  });

  it("accepts an unauthenticated local OpenAI-compatible endpoint without persisting its URL", () => {
    const configured = createConfiguredKnowledgeCompiler({
      AKP_LLM_PROVIDER: "openai-compatible",
      AKP_LLM_BASE_URL: "http://127.0.0.1:11434/v1",
      AKP_LLM_MODEL: "local-compiler",
      AKP_LLM_MAX_RETRIES: "0",
    });
    expect(configured?.descriptor).toMatchObject({
      role: "KNOWLEDGE_COMPILE",
      provider: "openai-compatible",
      model: "local-compiler",
      endpointRef: "legacy-knowledge-compile",
      dataResidency: "LOCAL_ONLY",
    });
    expect(configured?.descriptor.configurationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(configured?.descriptor).not.toHaveProperty("baseUrl");
  });

  it("filters an incompatible external primary before selecting a local fallback", () => {
    const candidates = createKnowledgeCompilerRouteCandidates({
      AKP_MODEL_ROLE_POLICIES_JSON: JSON.stringify([
        {
          role: "KNOWLEDGE_COMPILE",
          provider: "openai-compatible",
          model: "external-primary",
          endpointRef: "external",
          timeoutMs: 30_000,
          maxRetries: 1,
          concurrency: 2,
          structuredOutputRequired: true,
          dataResidency: "EXTERNAL_ALLOWED",
          fallbackRolesOrModels: ["local-fallback"],
        },
        {
          role: "KNOWLEDGE_COMPILE_LOCAL",
          provider: "openai-compatible",
          model: "local-fallback",
          endpointRef: "local",
          timeoutMs: 30_000,
          maxRetries: 1,
          concurrency: 1,
          structuredOutputRequired: true,
          dataResidency: "LOCAL_ONLY",
        },
      ]),
      AKP_MODEL_ENDPOINTS_JSON: JSON.stringify({
        external: { baseUrl: "https://models.example.test/v1" },
        local: { baseUrl: "http://127.0.0.1:11434/v1" },
      }),
    });

    const decision = routeKnowledgeCompilerCandidates(candidates, {
      dataResidency: "LOCAL_ONLY",
      structuredOutputRequired: true,
    });

    expect(decision.selected?.descriptor.model).toBe("local-fallback");
    expect(decision.rejected).toEqual([
      {
        candidate: expect.objectContaining({ model: "external-primary" }),
        reason: "RESIDENCY_INCOMPATIBLE",
      },
    ]);
  });

  it("fails visibly for malformed enabled configuration", () => {
    expect(() =>
      createConfiguredKnowledgeCompiler({
        AKP_LLM_PROVIDER: "openai-compatible",
        AKP_LLM_MODEL: "missing-url",
      }),
    ).toThrow(KnowledgeCompilerUnavailableError);
    expect(() =>
      createConfiguredKnowledgeCompiler({ AKP_LLM_PROVIDER: "mystery" }),
    ).toThrow(/Unsupported AKP_LLM_PROVIDER/);
    expect(() =>
      createKnowledgeCompilerRouteCandidates({
        AKP_MODEL_ROLE_POLICIES_JSON: "not-json",
      }),
    ).toThrow(/valid JSON/);
  });
});
