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
      "RULE",
      "COUNTEREXAMPLE",
    ]);
    expect(units[1]?.body).toContain("const value");
  });
});
