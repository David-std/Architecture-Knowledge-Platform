import { describe, expect, it } from "vitest";
import {
  boundedAssertionRecallQuery,
  boundedUnitLexicalRecallQuery,
} from "../src/assertion-recall.js";

describe("assertion recall query representation", () => {
  it("preserves accents exactly as the simple PostgreSQL dictionary does", () => {
    expect(
      boundedAssertionRecallQuery("¿Cómo funciona la nómina pública?"),
    ).toBe("cómo | funciona | nómina | pública");
    expect(boundedAssertionRecallQuery("nomina nómina NÓMINA")).toBe(
      "nomina | nómina",
    );
  });
  it("keeps unsafe tsquery operators outside tokens and bounds the query", () => {
    expect(boundedAssertionRecallQuery("alpha:*! beta | gamma &")).toBe(
      "alpha | beta | gamma",
    );
    expect(boundedAssertionRecallQuery("x y")).toBeNull();
    expect(
      boundedAssertionRecallQuery(
        Array.from({ length: 100 }, (_, i) => `term${i}`).join(" "),
      )?.split(" | "),
    ).toHaveLength(24);
  });
});

describe("bounded cross-document-type unit recall (first-stage candidates only)", () => {
  it("requires two distinct source-unit terms and does not accept one-term broad OR", () => {
    expect(boundedUnitLexicalRecallQuery("alpha")).toBeNull();
    expect(boundedUnitLexicalRecallQuery("alpha alpha")).toBeNull();
    expect(boundedUnitLexicalRecallQuery("alpha beta")).toBe("(alpha & beta)");
    expect(boundedUnitLexicalRecallQuery("alpha beta gamma")).toBe(
      "(alpha & beta) | (alpha & gamma) | (beta & gamma)",
    );
  });
  it("preserves Spanish accents and safely rejects tsquery injection operators", () => {
    expect(boundedUnitLexicalRecallQuery("¿Quién aprobó la auditoría?")).toBe(
      "(quién & aprobó) | (quién & auditoría) | (aprobó & auditoría)",
    );
    expect(boundedUnitLexicalRecallQuery("alpha:*! beta | gamma &")).toBe(
      "(alpha & beta) | (alpha & gamma) | (beta & gamma)",
    );
    const long = boundedUnitLexicalRecallQuery(
      Array.from({ length: 50 }, (_, i) => `topic${i}`).join(" "),
    )!;
    expect((long.match(/ & /gu) ?? []).length).toBe(28);
  });
});
