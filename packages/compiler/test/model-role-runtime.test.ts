import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createModelRoleRouteCandidates,
  routeModelRoleCandidates,
} from "../src/model-role-runtime.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("generic model-role runtime", () => {
  it("keeps an external COMMUNITY_SUMMARY fallback out of a LOCAL_ONLY route", () => {
    const candidates = createModelRoleRouteCandidates("COMMUNITY_SUMMARY", {
      AKP_MODEL_ROLE_POLICIES_JSON: JSON.stringify([
        {
          role: "COMMUNITY_SUMMARY",
          provider: "openai-compatible",
          model: "local-summary",
          endpointRef: "local",
          timeoutMs: 5_000,
          maxRetries: 0,
          concurrency: 1,
          dataResidency: "LOCAL_ONLY",
          fallbackRolesOrModels: ["external-summary"],
          degradationSafe: true,
        },
        {
          role: "COMMUNITY_SUMMARY_EXTERNAL",
          provider: "openai-compatible",
          model: "external-summary",
          endpointRef: "external",
          timeoutMs: 5_000,
          maxRetries: 0,
          concurrency: 1,
          dataResidency: "EXTERNAL_ALLOWED",
          degradationSafe: true,
        },
      ]),
      AKP_MODEL_ENDPOINTS_JSON: JSON.stringify({
        local: {
          baseUrl: "http://127.0.0.1:11434/v1",
          dataResidency: "LOCAL_ONLY",
        },
        external: {
          baseUrl: "https://models.example.test/v1",
          dataResidency: "EXTERNAL_ALLOWED",
          apiKeyEnv: "AKP_TEST_EXTERNAL_KEY",
        },
      }),
      AKP_TEST_EXTERNAL_KEY: "must-not-be-needed",
    });

    const decision = routeModelRoleCandidates(candidates, {
      dataResidency: "LOCAL_ONLY",
    });

    expect(
      decision.eligible.map((candidate) => candidate.descriptor.model),
    ).toEqual(["local-summary"]);
    expect(decision.rejected).toEqual([
      {
        candidate: expect.objectContaining({
          role: "COMMUNITY_SUMMARY_EXTERNAL",
          model: "external-summary",
          dataResidency: "EXTERNAL_ALLOWED",
        }),
        reason: "RESIDENCY_INCOMPATIBLE",
      },
    ]);
  });

  it("runs an unauthenticated local OpenAI-compatible role without an API key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "Local orientation summary." } }],
          usage: {
            prompt_tokens: 12,
            completion_tokens: 5,
            total_tokens: 17,
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );
    const candidates = createModelRoleRouteCandidates("COMMUNITY_SUMMARY", {
      AKP_MODEL_ROLE_POLICIES_JSON: JSON.stringify([
        {
          role: "COMMUNITY_SUMMARY",
          provider: "openai-compatible",
          model: "local-summary",
          endpointRef: "local",
          timeoutMs: 5_000,
          maxRetries: 0,
          concurrency: 1,
          dataResidency: "LOCAL_ONLY",
        },
      ]),
      AKP_MODEL_ENDPOINTS_JSON: JSON.stringify({
        local: {
          baseUrl: "http://127.0.0.1:11434/v1",
          dataResidency: "LOCAL_ONLY",
        },
      }),
    });

    const generator = candidates[0]!.createTextGenerator();
    const result = await generator.generate({
      system: "Summarize.",
      user: "A, B, C",
    });

    expect(result).toEqual({
      text: "Local orientation summary.",
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      "content-type": "application/json",
    });
  });
});
