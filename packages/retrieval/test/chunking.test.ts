import { describe, expect, it } from "vitest";
import {
  MAX_EMBEDDING_UNIT_CHARACTERS,
  parseKnowledgeUnits,
} from "../src/chunking.js";

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

  it("projects table rows and cells without losing exact source locators", () => {
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
    const table = units.find((unit) => unit.unitType === "TABLE");
    const row = units.find((unit) => unit.unitType === "TABLE_ROW");
    const cells = units.filter((unit) => unit.unitType === "TABLE_CELL");
    const retrievable = units.filter((unit) => unit.embeddingEligible);

    expect(table).toMatchObject({
      parentUnitKey: "section-1",
      containerOnly: true,
      embeddingEligible: false,
      locator: { startLine: 2, endLine: 4, table: 1 },
    });
    expect(row).toMatchObject({
      parentUnitKey: table?.unitKey,
      body: "| A | B |",
      headingPath: ["Evidence", "Table columns: Rule | Result"],
      containerOnly: false,
      embeddingEligible: true,
      locator: { startLine: 4, endLine: 4, table: 1, row: 1 },
    });
    expect(cells.map((unit) => unit.body)).toEqual(["A", "B"]);
    expect(cells.map((unit) => unit.parentUnitKey)).toEqual([
      row?.unitKey,
      row?.unitKey,
    ]);
    expect(cells.map((unit) => unit.locator.column)).toEqual([1, 2]);
    expect(cells.every((unit) => !unit.embeddingEligible)).toBe(true);
    expect(retrievable.map((unit) => unit.unitType)).toEqual([
      "TABLE_ROW",
      "FIGURE",
      "EQUATION",
    ]);
  });

  it("splits oversized prose into bounded retrievable fragments", () => {
    const decisive =
      "The final recovery marker remains discoverable after splitting.";
    const longBody = `${"Neutral architectural context. ".repeat(70)}${decisive}`;
    const units = parseKnowledgeUnits(
      "Long evidence",
      `# Long evidence\n${longBody}`,
    );
    const container = units.find(
      (unit) =>
        unit.unitType === "PARAGRAPH" &&
        unit.containerOnly &&
        unit.body === longBody,
    );
    expect(container?.embeddingEligible).toBe(false);
    const fragments = units.filter(
      (unit) =>
        unit.parentUnitKey === container?.unitKey && unit.embeddingEligible,
    );
    expect(fragments.length).toBeGreaterThan(1);
    expect(
      fragments.every(
        (unit) => unit.body.length <= MAX_EMBEDDING_UNIT_CHARACTERS,
      ),
    ).toBe(true);
    expect(fragments.some((unit) => unit.body.includes(decisive))).toBe(true);
    expect(fragments.map((unit) => unit.locator.fragment)).toEqual(
      fragments.map((_, index) => index + 1),
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

  it("uses Markdown fence and indented-code grammar for literal headings", () => {
    const source = [
      "# Outer",
      "~~~markdown",
      "# Tilde literal",
      "~~~",
      "",
      "````markdown",
      "# Long-fence literal",
      "```",
      "# Still literal",
      "````",
      "",
      "    # Indented literal",
      "    source line",
      "",
      "~~~markdown",
      "# Unclosed literal",
    ].join("\n");

    const units = parseKnowledgeUnits("Document", source);
    const code = units.filter((unit) => unit.unitType === "CODE_EVIDENCE");

    expect(code.map((unit) => unit.body)).toEqual([
      "~~~markdown\n# Tilde literal\n~~~",
      "````markdown\n# Long-fence literal\n```\n# Still literal\n````",
      "# Indented literal\n    source line",
      "~~~markdown\n# Unclosed literal",
    ]);
    expect(code.map((unit) => unit.locator.startLine)).toEqual([2, 6, 12, 15]);
    expect(code.map((unit) => unit.locator.endLine)).toEqual([4, 10, 13, 16]);
    expect(code.map((unit) => unit.headingPath)).toEqual([
      ["Outer"],
      ["Outer"],
      ["Outer"],
      ["Outer"],
    ]);
    expect(
      units
        .filter((unit) => unit.unitType === "SECTION")
        .map((unit) => unit.headingPath),
    ).toEqual([["Outer"]]);
  });

  it("recognizes setext headings and keeps skipped heading depths contiguous", () => {
    const units = parseKnowledgeUnits(
      "Document",
      [
        "Overview",
        "========",
        "Introductory text.",
        "",
        "### Deep heading",
        "Deep text.",
        "#### Nested heading",
        "Nested text.",
      ].join("\n"),
    );
    const sections = units.filter((unit) => unit.unitType === "SECTION");

    expect(sections.map((unit) => unit.headingPath)).toEqual([
      ["Overview"],
      ["Overview", "Deep heading"],
      ["Overview", "Deep heading", "Nested heading"],
    ]);
    expect(sections.map((unit) => unit.locator)).toEqual([
      expect.objectContaining({ startLine: 3, endLine: 4 }),
      expect.objectContaining({ startLine: 6, endLine: 6 }),
      expect.objectContaining({ startLine: 8, endLine: 8 }),
    ]);
  });

  it("keeps actual-depth siblings and removes deeper ancestors on descent", () => {
    const siblings = parseKnowledgeUnits(
      "Document",
      ["# Root", "Root text.", "### A", "A text.", "### B", "B text."].join(
        "\n",
      ),
    ).filter((unit) => unit.unitType === "SECTION");
    expect(siblings.map((unit) => unit.headingPath)).toEqual([
      ["Root"],
      ["Root", "A"],
      ["Root", "B"],
    ]);

    const descent = parseKnowledgeUnits(
      "Document",
      ["# Root", "Root text.", "#### A", "A text.", "## B", "B text."].join(
        "\n",
      ),
    ).filter((unit) => unit.unitType === "SECTION");
    expect(descent.map((unit) => unit.headingPath)).toEqual([
      ["Root"],
      ["Root", "A"],
      ["Root", "B"],
    ]);

    const retreat = parseKnowledgeUnits(
      "Document",
      ["## Child", "Child text.", "# Root", "Root text."].join("\n"),
    ).filter((unit) => unit.unitType === "SECTION");
    expect(retreat.map((unit) => unit.headingPath)).toEqual([
      ["Child"],
      ["Root"],
    ]);
  });

  it("uses parsed text for closing ATX heading syntax", () => {
    const sections = parseKnowledgeUnits(
      "Document",
      ["# Root #", "Root text.", "## Child ##", "Child text."].join("\n"),
    ).filter((unit) => unit.unitType === "SECTION");

    expect(sections.map((unit) => unit.headingPath)).toEqual([
      ["Root"],
      ["Root", "Child"],
    ]);
  });

  it("preserves adjacent figure, loose-list and equation boundaries", () => {
    const atomic = parseKnowledgeUnits(
      "Document",
      [
        "# Content",
        "![diagram](diagram.png)",
        "caption immediately after figure",
        "",
        "- first item",
        "",
        "- second item",
        "",
        "$$",
        "E = mc^2",
        "$$",
        "After equation",
      ].join("\n"),
    ).filter((unit) => !unit.containerOnly);

    expect(
      atomic.map(({ unitType, body, locator }) => ({
        unitType,
        body,
        startLine: locator.startLine,
        endLine: locator.endLine,
      })),
    ).toEqual([
      {
        unitType: "FIGURE",
        body: "![diagram](diagram.png)",
        startLine: 2,
        endLine: 2,
      },
      {
        unitType: "PARAGRAPH",
        body: "caption immediately after figure",
        startLine: 3,
        endLine: 3,
      },
      {
        unitType: "LIST",
        body: "- first item",
        startLine: 5,
        endLine: 5,
      },
      {
        unitType: "LIST",
        body: "- second item",
        startLine: 7,
        endLine: 7,
      },
      {
        unitType: "EQUATION",
        body: "$$\nE = mc^2\n$$",
        startLine: 9,
        endLine: 11,
      },
      {
        unitType: "PARAGRAPH",
        body: "After equation",
        startLine: 12,
        endLine: 12,
      },
    ]);
  });
});

describe("visible Markdown content", () => {
  it("keeps provenance comments out of evidence and preserves original line positions", () => {
    const source =
      "# Extract\n\n<!-- akp-locator: page=2; heading=Operational source -->\n\nThe lock is released after recovery.\n\n<!-- internal note -->\n\nThe receipt expires at midnight.";
    const units = parseKnowledgeUnits("Extract", source).filter(
      (unit) => !unit.containerOnly,
    );
    expect(units).toHaveLength(2);
    expect(units[0]?.unitType).toBe("PARAGRAPH");
    expect(units[0]?.body).not.toContain("akp-locator");
    expect(units[0]?.locator).toMatchObject({
      startLine: 5,
      endLine: 5,
      sourceCommentSpans: [{ startLine: 3, endLine: 3 }],
    });
    expect(units[1]?.locator.startLine).toBe(9);
  });

  it("preserves literals in fenced and inline code while masking actual comments", () => {
    const units = parseKnowledgeUnits(
      "Syntax",
      "# Syntax\n```html\n<!-- code example -->\n```\n\nUse `<!-- inline example -->` as syntax.\n\n<!-- ignored -->\nAfter the comment.",
    );
    expect(
      units.find((unit) => unit.unitType === "CODE_EVIDENCE")?.body,
    ).toContain("<!-- code example -->");
    expect(
      units.some(
        (unit) => !unit.containerOnly && unit.body.includes("inline example"),
      ),
    ).toBe(true);
    expect(
      units.some(
        (unit) => !unit.containerOnly && unit.body.includes("ignored"),
      ),
    ).toBe(false);
  });

  it("does not delete visible text between inline comments", () => {
    const units = parseKnowledgeUnits(
      "Statement",
      "# Statement\n<!-- first -->The receipt remains valid.<!-- last -->",
    );
    expect(
      units.filter((unit) => !unit.containerOnly).map((unit) => unit.body),
    ).toEqual(["The receipt remains valid."]);
  });

  it("retains link units but excludes links alone from vector embeddings", () => {
    const units = parseKnowledgeUnits(
      "Links",
      "# Links\n[Remote reference](https://example.org)\n\n[[Local reference]]\n\nConsult [the reference](https://example.org) before publishing.",
    ).filter((unit) => !unit.containerOnly);
    expect(units.map((unit) => unit.embeddingEligible)).toEqual([
      false,
      false,
      true,
    ]);
    expect(units[0]?.body).toContain("https://example.org");
  });

  it("does not interpret semantic type vocabulary as substrings of other words", () => {
    const units = parseKnowledgeUnits(
      "Record",
      "# Record\nEl medicamento funciona correctamente.\n\nLa convocatoria permanece abierta.",
    );
    expect(
      units.filter((unit) => !unit.containerOnly).map((unit) => unit.unitType),
    ).toEqual(["PARAGRAPH", "PARAGRAPH"]);
  });
});
