import { describe, expect, it } from "vitest";
import {
  isModelResidencyCompatible,
  ModelRolePolicy,
  mostRestrictiveModelResidency,
} from "../src/model-role-policy.js";

describe("ModelRolePolicy", () => {
  it("keeps model roles extensible while validating operational controls", () => {
    const parsed = ModelRolePolicy.parse({
      role: "PRIVATE_SUMMARIZER",
      provider: "openai-compatible",
      model: "local-model",
      endpointRef: "local-primary",
      maxInputTokens: 16_384,
      maxOutputTokens: 2_048,
      timeoutMs: 30_000,
      maxRetries: 2,
      concurrency: 4,
      structuredOutputRequired: true,
      dataResidency: "LOCAL_ONLY",
      fallbackRolesOrModels: ["PRIVATE_SUMMARIZER_FALLBACK"],
      costCeiling: 0,
      degradationSafe: false,
    });

    expect(parsed.role).toBe("PRIVATE_SUMMARIZER");
    expect(parsed.dataResidency).toBe("LOCAL_ONLY");
  });

  it("selects the most restrictive residency boundary", () => {
    expect(
      mostRestrictiveModelResidency(
        "EXTERNAL_ALLOWED",
        "ORG_APPROVED",
        "LOCAL_ONLY",
      ),
    ).toBe("LOCAL_ONLY");
    expect(mostRestrictiveModelResidency()).toBe("EXTERNAL_ALLOWED");
  });

  it("only accepts candidates at least as restrictive as the requirement", () => {
    expect(isModelResidencyCompatible("LOCAL_ONLY", "LOCAL_ONLY")).toBe(true);
    expect(isModelResidencyCompatible("LOCAL_ONLY", "ORG_APPROVED")).toBe(
      false,
    );
    expect(isModelResidencyCompatible("LOCAL_ONLY", "EXTERNAL_ALLOWED")).toBe(
      false,
    );

    expect(isModelResidencyCompatible("ORG_APPROVED", "LOCAL_ONLY")).toBe(true);
    expect(isModelResidencyCompatible("ORG_APPROVED", "ORG_APPROVED")).toBe(
      true,
    );
    expect(
      isModelResidencyCompatible("ORG_APPROVED", "EXTERNAL_ALLOWED"),
    ).toBe(false);

    expect(
      isModelResidencyCompatible("EXTERNAL_ALLOWED", "LOCAL_ONLY"),
    ).toBe(true);
    expect(
      isModelResidencyCompatible("EXTERNAL_ALLOWED", "ORG_APPROVED"),
    ).toBe(true);
    expect(
      isModelResidencyCompatible("EXTERNAL_ALLOWED", "EXTERNAL_ALLOWED"),
    ).toBe(true);
  });

  it("rejects unsafe retry and concurrency controls", () => {
    const base = {
      role: "KNOWLEDGE_COMPILE",
      provider: "openai-compatible",
      model: "model",
      timeoutMs: 30_000,
      maxRetries: 2,
      concurrency: 4,
      dataResidency: "ORG_APPROVED",
    };

    expect(
      ModelRolePolicy.safeParse({ ...base, maxRetries: -1 }).success,
    ).toBe(false);
    expect(
      ModelRolePolicy.safeParse({ ...base, concurrency: 0 }).success,
    ).toBe(false);
  });
});
