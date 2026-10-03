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
      evidenceReader: null,
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
