import { describe, expect, it } from "vitest";
import {
  CHAR_4_FALLBACK_TOKENIZER,
  measureTokens,
  type Tokenizer,
} from "../src/context-packet.js";

const samples = {
  english: "Retries use exponential backoff and bounded jitter.",
  spanish: "La política de reintentos conserva trazabilidad y evidencia.",
  code: "async function retry<T>(op: () => Promise<T>): Promise<T> {}",
  path: "/services/payments/src/retry-policy.ts",
  identifier: "ADR-042-RETRY-BOUNDARY",
} as const;

const exactCounts: Record<string, number> = {
  [samples.english]: 11,
  [samples.spanish]: 15,
  [samples.code]: 21,
  [samples.path]: 9,
  [samples.identifier]: 8,
};

const modelTokenizer: Tokenizer = {
  id: "model-tokenizer:test@pinned-revision",
  label: "Pinned model tokenizer fixture",
  quality: "EXACT",
  count(text) {
    const value = exactCounts[text];
    if (value === undefined) throw new Error("UNREGISTERED_TOKENIZER_FIXTURE");
    return value;
  },
};

describe("tokenizer quality contract", () => {
  it.each(Object.entries(samples))(
    "delegates %s token counts to the exact model tokenizer",
    (_kind, text) => {
      const measured = measureTokens(text, modelTokenizer);
      expect(measured.tokens).toBe(exactCounts[text]);
      expect(measured.metadata).toEqual({
        id: "model-tokenizer:test@pinned-revision",
        label: "Pinned model tokenizer fixture",
        quality: "EXACT",
        approximate: false,
        source: "injected",
      });
    },
  );

  it.each(Object.entries(samples))(
    "labels char/4 %s counts approximate",
    (_kind, text) => {
      const measured = measureTokens(text);
      expect(measured.tokens).toBe(Math.ceil(text.length / 4));
      expect(measured.metadata).toMatchObject({
        id: "char/4",
        quality: "APPROXIMATE",
        approximate: true,
        source: "fallback",
      });
    },
  );

  it("keeps an explicitly approximate injected estimator approximate", () => {
    const estimated = measureTokens("abcde", {
      id: "custom-estimator",
      label: "Custom approximate estimator",
      quality: "APPROXIMATE",
      count: (text) => Math.ceil(text.length / 3),
    });
    expect(estimated).toEqual({
      tokens: 2,
      metadata: {
        id: "custom-estimator",
        label: "Custom approximate estimator",
        quality: "APPROXIMATE",
        approximate: true,
        source: "injected",
      },
    });
  });

  it("never permits the char/4 fallback identity to claim exact quality", () => {
    expect(() =>
      measureTokens("cannot be exact", {
        ...CHAR_4_FALLBACK_TOKENIZER,
        quality: "EXACT",
        approximate: false,
      }),
    ).toThrow("TOKENIZER_QUALITY_INVALID:CHAR_4_CANNOT_BE_EXACT");
  });

  it("rejects conflicting compatibility metadata", () => {
    expect(() =>
      measureTokens("conflict", {
        id: "conflicting-tokenizer",
        quality: "EXACT",
        approximate: true,
        count: () => 1,
      }),
    ).toThrow(
      "TOKENIZER_QUALITY_INVALID:CONFLICTING_APPROXIMATE_METADATA",
    );
  });
});
