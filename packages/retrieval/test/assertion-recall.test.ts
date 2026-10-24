import { describe, expect, it } from "vitest";
import { boundedAssertionRecallQuery } from "../src/assertion-recall.js";

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
