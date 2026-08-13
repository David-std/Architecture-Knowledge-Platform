import { describe, expect, it } from "vitest";
import { parseKnowledgeUnits } from "../src/chunking.js";

describe("hierarchical chunking", () => {
  it("keeps fenced examples within their structural section", () => {
    const units = parseKnowledgeUnits(
      "Rules",
      "# Rule\nA rule and its condition.\n```ts\nconst value = true;\n```\n## Counterexample\nDo not bypass review.",
    );
    expect(units.map((unit) => unit.unitType)).toEqual([
      "DOCUMENT",
      "SECTION",
      "RULE",
      "CODE_EVIDENCE",
      "SECTION",
      "COUNTEREXAMPLE",
    ]);
    expect(units[3]?.body).toContain("const value");
    expect(units[0]?.embeddingEligible).toBe(false);
    expect(units[1]?.parentUnitKey).toBe("document");
    expect(units[2]?.parentUnitKey).toBe("section-1");
  });

  it("keeps tables, figures and equations atomic with line locators", () => {
    const units = parseKnowledgeUnits(
      "Structured",
      [
        "# Evidence",
        "| Rule | Result |",
        "| --- | --- |",
        "| A | B |",
        "",
        "![diagram](diagram.png)",
        "",
        "$$",
        "E = mc^2",
        "$$",
      ].join("\n"),
    );
    const atomic = units.filter((unit) => unit.embeddingEligible);
    expect(atomic.map((unit) => unit.unitType)).toEqual([
      "TABLE",
      "FIGURE",
      "EQUATION",
    ]);
    expect(atomic[0]?.locator).toMatchObject({ startLine: 2, endLine: 4 });
    expect(atomic.every((unit) => unit.parentUnitKey === "section-1")).toBe(
      true,
    );
  });

  it("assigns stable distinct keys to repeated identical blocks", () => {
    const units = parseKnowledgeUnits(
      "Repeated evidence",
      "# Evidence\nSame assertion.\n\nSame assertion.",
    ).filter((unit) => unit.embeddingEligible);

    expect(units).toHaveLength(2);
    expect(units[0]?.contentHash).toBe(units[1]?.contentHash);
    expect(units[0]?.unitKey).not.toBe(units[1]?.unitKey);
  });
});
