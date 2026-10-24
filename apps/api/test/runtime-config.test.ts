import { describe, expect, it } from "vitest";
import { loadApiRuntimeConfig } from "../src/runtime-config.js";

describe("API runtime configuration", () => {
  it.each(["", "abc", "0", "-1", "9007199254740992"])(
    "rejects invalid AKP_RATE_LIMIT_MAX=%j",
    (value) => {
      expect(() => loadApiRuntimeConfig({ AKP_RATE_LIMIT_MAX: value })).toThrow(
        /AKP_RATE_LIMIT_MAX/,
      );
    },
  );

  it.each(["", "abc", "0", "-1", "65536"])(
    "rejects invalid PORT=%j",
    (value) => {
      expect(() => loadApiRuntimeConfig({ PORT: value })).toThrow(/PORT/);
    },
  );

  it("accepts bounded integer settings and preserves defaults", () => {
    expect(loadApiRuntimeConfig({})).toEqual({
      rateLimitMax: 120,
      port: 8080,
      evidenceVerifierProvider: "disabled",
      evidenceVerifierMode: "SHADOW",
      evidenceVerifierMinimumSupportScore: null,
      evidenceVerifierMaxCandidates: 16,
      evidenceVerifierLocalFilesOnly: false,
      evidenceAdmissionTimeoutMs: 25000,
      evidenceAdmissionMinDistinctDocuments: 1,
      evidenceAdmissionAbstainOnConflict: false,
      evidenceReader: null,
      queryTransformProvider: "disabled",
      queryTranslation: null,
    });
    expect(
      loadApiRuntimeConfig({ AKP_RATE_LIMIT_MAX: "240", PORT: "9090" }),
    ).toMatchObject({ rateLimitMax: 240, port: 9090 });
  });

  it("keeps local evidence verification shadow-only and explicit", () => {
    expect(() =>
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "local-multilingual-qa",
      }),
    ).toThrow(/AKP_EVIDENCE_VERIFIER_MIN_SCORE/);

    expect(() =>
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "local-multilingual-qa",
        AKP_EVIDENCE_VERIFIER_MIN_SCORE: "0.8",
        AKP_EVIDENCE_VERIFIER_MODE: "ENFORCE",
      }),
    ).toThrow(/SHADOW/);

    expect(
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "local-multilingual-qa",
        AKP_EVIDENCE_VERIFIER_MIN_SCORE: "0.8",
        AKP_EVIDENCE_VERIFIER_MAX_CANDIDATES: "24",
        AKP_EVIDENCE_VERIFIER_LOCAL_FILES_ONLY: "true",
      }),
    ).toMatchObject({
      evidenceVerifierProvider: "local-multilingual-qa",
      evidenceVerifierMode: "SHADOW",
      evidenceVerifierMinimumSupportScore: 0.8,
      evidenceVerifierMaxCandidates: 24,
      evidenceVerifierLocalFilesOnly: true,
    });
  });

  it("keeps relevance-only cross-encoder scores shadow-only", () => {
    expect(() =>
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "contextual-cross-encoder",
        AKP_EVIDENCE_VERIFIER_MODE: "ENFORCE",
      }),
    ).toThrow(/cross-encoder-reader.*SHADOW/);
    expect(
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "contextual-cross-encoder",
        AKP_EVIDENCE_VERIFIER_MIN_SCORE: "0.6",
      }),
    ).toMatchObject({
      evidenceVerifierMode: "SHADOW",
      evidenceVerifierMinimumSupportScore: 0.6,
    });
    expect(() =>
      loadApiRuntimeConfig({ AKP_EVIDENCE_VERIFIER_MODE: "ENFORCE" }),
    ).toThrow(/cross-encoder-reader/);
    expect(() =>
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "contextual-cross-encoder",
        AKP_EVIDENCE_VERIFIER_MODE: "enforce",
      }),
    ).toThrow(/AKP_EVIDENCE_VERIFIER_MODE/);
    expect(() =>
      loadApiRuntimeConfig({ AKP_EVIDENCE_VERIFIER_PROVIDER: "reranker" }),
    ).toThrow(/AKP_EVIDENCE_VERIFIER_PROVIDER/);
  });

  it("requires an explicit reader endpoint for the cross-encoder reader", () => {
    expect(() =>
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "cross-encoder-reader",
      }),
    ).toThrow(/AKP_EVIDENCE_READER_BASE_URL/);
    expect(
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "cross-encoder-reader",
        AKP_EVIDENCE_VERIFIER_MODE: "ENFORCE",
        AKP_EVIDENCE_READER_BASE_URL: "http://127.0.0.1:11434",
        AKP_EVIDENCE_READER_MODEL: "local-reader",
        AKP_EVIDENCE_READER_SHORTLIST: "3",
      }),
    ).toMatchObject({
      evidenceVerifierMode: "ENFORCE",
      evidenceReader: {
        baseUrl: "http://127.0.0.1:11434",
        model: "local-reader",
        apiKey: null,
        shortlistSize: 3,
        timeoutMs: 30000,
        jsonResponseFormat: true,
      },
    });
    expect(() =>
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "cross-encoder-reader",
        AKP_EVIDENCE_READER_BASE_URL: "http://127.0.0.1:11434",
        AKP_EVIDENCE_READER_MODEL: "local-reader",
        AKP_EVIDENCE_READER_SHORTLIST: "40",
      }),
    ).toThrow(/AKP_EVIDENCE_READER_SHORTLIST/);
  });

  it("configures hosted reader output budget and reasoning only when explicitly enabled", () => {
    const base = {
      AKP_EVIDENCE_VERIFIER_PROVIDER: "cross-encoder-reader",
      AKP_EVIDENCE_READER_BASE_URL:
        "https://generativelanguage.googleapis.com/v1beta/openai/",
      AKP_EVIDENCE_READER_MODEL: "hosted-model",
    };
    expect(loadApiRuntimeConfig(base).evidenceReader).toMatchObject({
      maxOutputTokens: 256,
      reasoningEffort: null,
    });
    expect(
      loadApiRuntimeConfig({
        ...base,
        AKP_EVIDENCE_READER_MAX_OUTPUT_TOKENS: "1024",
        AKP_EVIDENCE_READER_REASONING_EFFORT: "low",
      }).evidenceReader,
    ).toMatchObject({ maxOutputTokens: 1024, reasoningEffort: "low" });
    for (const value of ["15", "0", "16385", "abc"]) {
      expect(() =>
        loadApiRuntimeConfig({
          ...base,
          AKP_EVIDENCE_READER_MAX_OUTPUT_TOKENS: value,
        }),
      ).toThrow(/AKP_EVIDENCE_READER_MAX_OUTPUT_TOKENS/);
    }
    expect(() =>
      loadApiRuntimeConfig({
        ...base,
        AKP_EVIDENCE_READER_REASONING_EFFORT: "ultra",
      }),
    ).toThrow(/AKP_EVIDENCE_READER_REASONING_EFFORT/);
  });

  it("selects layered admission only with an explicit reader", () => {
    expect(() =>
      loadApiRuntimeConfig({ AKP_EVIDENCE_VERIFIER_MODE: "LAYERED" }),
    ).toThrow(/"LAYERED" requires AKP_EVIDENCE_VERIFIER_PROVIDER/);
    expect(() =>
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "contextual-cross-encoder",
        AKP_EVIDENCE_VERIFIER_MODE: "LAYERED",
      }),
    ).toThrow(/cross-encoder-reader.*SHADOW/);
    expect(
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "cross-encoder-reader",
        AKP_EVIDENCE_VERIFIER_MODE: "LAYERED",
        AKP_EVIDENCE_READER_BASE_URL: "https://reader.example.test/v1",
        AKP_EVIDENCE_READER_MODEL: "hosted-reader",
        AKP_EVIDENCE_READER_API_KEY: "test-key",
        AKP_EVIDENCE_READER_JSON_RESPONSE_FORMAT: "false",
        AKP_EVIDENCE_ADMISSION_TIMEOUT_MS: "20000",
        AKP_EVIDENCE_VERIFIER_MAX_CANDIDATES: "32",
      }),
    ).toMatchObject({
      evidenceVerifierMode: "LAYERED",
      evidenceVerifierMaxCandidates: 32,
      evidenceAdmissionTimeoutMs: 20000,
      evidenceReader: {
        baseUrl: "https://reader.example.test/v1",
        model: "hosted-reader",
        apiKey: "test-key",
        shortlistSize: 4,
        jsonResponseFormat: false,
      },
    });
  });

  it("selects query transformation providers explicitly", () => {
    expect(
      loadApiRuntimeConfig({ AKP_QUERY_TRANSFORM_ENABLED: "true" }),
    ).toMatchObject({
      queryTransformProvider: "deterministic-decomposer",
      queryTranslation: null,
    });
    expect(() =>
      loadApiRuntimeConfig({
        AKP_QUERY_TRANSFORM_PROVIDER: "openai-compatible-translation",
      }),
    ).toThrow(/AKP_QUERY_TRANSLATION_BASE_URL/);
    expect(() =>
      loadApiRuntimeConfig({
        AKP_QUERY_TRANSFORM_PROVIDER: "openai-compatible-translation",
        AKP_QUERY_TRANSLATION_BASE_URL: "http://127.0.0.1:11434",
        AKP_QUERY_TRANSLATION_MODEL: "local-model",
        AKP_QUERY_TRANSLATION_LANGUAGES: "es,spanish",
      }),
    ).toThrow(/ISO 639-1/);
    expect(
      loadApiRuntimeConfig({
        AKP_QUERY_TRANSFORM_PROVIDER: "openai-compatible-translation",
        AKP_QUERY_TRANSLATION_BASE_URL: "https://translator.example.test/v1",
        AKP_QUERY_TRANSLATION_MODEL: "hosted-model",
        AKP_QUERY_TRANSLATION_LANGUAGES: " es, EN ,es",
        AKP_QUERY_TRANSLATION_API_KEY: "test-key",
        AKP_QUERY_TRANSLATION_JSON_RESPONSE_FORMAT: "false",
      }),
    ).toMatchObject({
      queryTransformProvider: "openai-compatible-translation",
      queryTranslation: {
        baseUrl: "https://translator.example.test/v1",
        model: "hosted-model",
        apiKey: "test-key",
        corpusLanguages: ["es", "en"],
        timeoutMs: 10000,
        jsonResponseFormat: false,
      },
    });
    expect(() =>
      loadApiRuntimeConfig({ AKP_QUERY_TRANSFORM_PROVIDER: "llm" }),
    ).toThrow(/AKP_QUERY_TRANSFORM_PROVIDER/);
  });

  it.each(["", "9", "60001", "abc"])(
    "rejects invalid AKP_EVIDENCE_ADMISSION_TIMEOUT_MS=%j",
    (value) => {
      expect(() =>
        loadApiRuntimeConfig({ AKP_EVIDENCE_ADMISSION_TIMEOUT_MS: value }),
      ).toThrow(/AKP_EVIDENCE_ADMISSION_TIMEOUT_MS/);
    },
  );

  it("validates selective admission document diversity and conflict policy", () => {
    expect(
      loadApiRuntimeConfig({
        AKP_EVIDENCE_ADMISSION_MIN_DISTINCT_DOCUMENTS: "3",
        AKP_EVIDENCE_ADMISSION_ABSTAIN_ON_CONFLICT: "true",
      }),
    ).toMatchObject({
      evidenceAdmissionMinDistinctDocuments: 3,
      evidenceAdmissionAbstainOnConflict: true,
    });
    for (const value of ["", "0", "17", "1.5", "abc"]) {
      expect(() =>
        loadApiRuntimeConfig({
          AKP_EVIDENCE_ADMISSION_MIN_DISTINCT_DOCUMENTS: value,
        }),
      ).toThrow(/AKP_EVIDENCE_ADMISSION_MIN_DISTINCT_DOCUMENTS/);
    }
    for (const value of ["yes", "1", "TRUE", ""]) {
      expect(() =>
        loadApiRuntimeConfig({
          AKP_EVIDENCE_ADMISSION_ABSTAIN_ON_CONFLICT: value,
        }),
      ).toThrow(/AKP_EVIDENCE_ADMISSION_ABSTAIN_ON_CONFLICT/);
    }
  });

  it.each(["", "0", "-0.1", "1.1", "abc"])(
    "rejects invalid AKP_EVIDENCE_VERIFIER_MIN_SCORE=%j",
    (value) => {
      expect(() =>
        loadApiRuntimeConfig({
          AKP_EVIDENCE_VERIFIER_MIN_SCORE: value,
        }),
      ).toThrow(/AKP_EVIDENCE_VERIFIER_MIN_SCORE/);
    },
  );

  it.each(["yes", "1", "TRUE"])(
    "rejects invalid AKP_EVIDENCE_VERIFIER_LOCAL_FILES_ONLY=%j",
    (value) => {
      expect(() =>
        loadApiRuntimeConfig({
          AKP_EVIDENCE_VERIFIER_LOCAL_FILES_ONLY: value,
        }),
      ).toThrow(/AKP_EVIDENCE_VERIFIER_LOCAL_FILES_ONLY/);
    },
  );
});
