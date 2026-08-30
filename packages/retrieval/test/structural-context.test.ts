import { describe, expect, it } from "vitest";
import { rehydrateStructuralContext } from "../src/structural-context.js";

describe("rehydrateStructuralContext", () => {
  it("rehydrates an atomic unit from a bounded section parent", () => {
    const child = "A rule must preserve its evidence locator.";
    const result = rehydrateStructuralContext(
      {
        body: child,
        unitType: "RULE",
        parentBody: `# Evidence rules\n\n${"context ".repeat(300)}\n${child}\n${"tail ".repeat(300)}`,
        parentUnitType: "SECTION",
      },
      600,
    );

    expect(result).toContain(child);
    expect(result.length).toBeLessThanOrEqual(600);
  });

  it("never expands a DOCUMENT container into the packet", () => {
    const child = "Only this atomic table row is relevant.";
    const result = rehydrateStructuralContext({
      body: child,
      unitType: "TABLE",
      parentBody: `Entire dossier ${"x".repeat(20_000)}`,
      parentUnitType: "DOCUMENT",
    });

    expect(result).toBe(child);
    expect(result).not.toContain("Entire dossier");
  });
});
