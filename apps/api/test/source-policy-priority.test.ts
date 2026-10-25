import { describe, expect, it } from "vitest";
import { mayPrioritizeGovernedRule } from "../src/routes/search.js";

describe("retrieved rule selection authority", () => {
  it("does not promote source documents that advertise policy or payment instructions", () => {
    for (const layer of ["source", "resource"]) {
      expect(
        mayPrioritizeGovernedRule({
          kind: "rule",
          layer,
          trust: "HUMAN_REVIEWED",
        }),
      ).toBe(false);
    }
    for (const trust of ["DERIVED", "MACHINE_SUPPORTED"]) {
      expect(
        mayPrioritizeGovernedRule({
          kind: "rule",
          layer: "rules",
          trust,
        }),
      ).toBe(false);
    }
  });

  it("reserves mandatory priority for reviewed rule-kind material", () => {
    expect(
      mayPrioritizeGovernedRule({
        kind: "rule",
        layer: "rules",
        trust: "HUMAN_REVIEWED",
      }),
    ).toBe(true);
    expect(
      mayPrioritizeGovernedRule({
        kind: "evidence",
        layer: "rules",
        trust: "HUMAN_REVIEWED",
      }),
    ).toBe(false);
  });
});
