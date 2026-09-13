import { describe, expect, it } from "vitest";
import {
  KnowledgeCompilerUnavailableError,
  createConfiguredKnowledgeCompiler,
} from "../src/index.js";

describe("knowledge compiler provider registry", () => {
  it("uses the explicit source-summary fallback when disabled or unset", () => {
    expect(createConfiguredKnowledgeCompiler({})).toBeNull();
    expect(
      createConfiguredKnowledgeCompiler({ AKP_LLM_PROVIDER: "disabled" }),
    ).toBeNull();
  });

  it("accepts an unauthenticated local OpenAI-compatible endpoint", () => {
    const configured = createConfiguredKnowledgeCompiler({
      AKP_LLM_PROVIDER: "openai-compatible",
      AKP_LLM_BASE_URL: "http://127.0.0.1:11434/v1",
      AKP_LLM_MODEL: "local-compiler",
      AKP_LLM_MAX_RETRIES: "0",
    });
    expect(configured?.descriptor).toEqual({
      provider: "openai-compatible",
      model: "local-compiler",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
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
  });
});
