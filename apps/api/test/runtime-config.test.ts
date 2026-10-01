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

  it("lets only the contextual cross-encoder enforce evidence support", () => {
    expect(
      loadApiRuntimeConfig({
        AKP_EVIDENCE_VERIFIER_PROVIDER: "contextual-cross-encoder",
        AKP_EVIDENCE_VERIFIER_MODE: "ENFORCE",
      }),
    ).toMatchObject({
      evidenceVerifierProvider: "contextual-cross-encoder",
      evidenceVerifierMode: "ENFORCE",
      evidenceVerifierMinimumSupportScore: null,
    });
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
    ).toThrow(/contextual-cross-encoder/);
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
