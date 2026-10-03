import { describe, expect, it } from "vitest";
import {
  markdownTableEvidence,
  projectMarkdownTable,
} from "../src/markdown-table-evidence.js";
import { rehydrateStructuralContext } from "../src/structural-context.js";
import { parseKnowledgeUnits } from "../src/chunking.js";

const TABLE =
  "| Situation | Decision |\n| :--- | ---: |\n| Bursty dispatch | Choose partitioned delivery |\n| Steady dispatch | Choose one consumer |";

describe("GFM table evidence source binding", () => {
  it("preserves header, row and cell offsets in original UTF-16 text", () => {
    const passage = `📬\r\n\r\n${TABLE.replace(/\n/g, "\r\n")}`;
    const table = markdownTableEvidence(passage)[0]!;
    expect(table.startLine).toBe(3);
    expect(table.endLine).toBe(6);
    expect(
      passage.slice(table.header.span.startOffset, table.header.span.endOffset),
    ).toBe(table.header.source);
    expect(table.rows).toHaveLength(2);
    for (const row of [table.header, ...table.rows]) {
      expect(passage.slice(row.span.startOffset, row.span.endOffset)).toBe(
        row.source,
      );
      for (const cell of row.cells) {
        expect(passage.slice(cell.span.startOffset, cell.span.endOffset)).toBe(
          cell.source,
        );
      }
    }
    expect(
      passage.slice(table.headerSpan.startOffset, table.headerSpan.endOffset),
    ).toContain(":---");
  });

  it("handles optional borders and escaped pipes using the GFM parser", () => {
    const passage = "Channel | Result\n--- | ---\nA\\|B | `ok`";
    const table = markdownTableEvidence(passage)[0]!;
    expect(table.rows[0]!.cells).toHaveLength(2);
    expect(table.rows[0]!.cells[0]!.source).toBe("A\\|B");
    expect(table.rows[0]!.cells[1]!.source).toBe("`ok`");
    const units = parseKnowledgeUnits("Channels", passage);
    expect(units.find((unit) => unit.unitType === "TABLE")).toMatchObject({
      body: passage,
      containerOnly: true,
      embeddingEligible: false,
    });
    expect(units.filter((unit) => unit.embeddingEligible)).toMatchObject([
      {
        unitType: "TABLE_ROW",
        body: "A\\|B | `ok`",
        headingPath: ["Table columns: Channel | Result"],
      },
    ]);
  });

  it.each([
    `\`\`\`md\n${TABLE}\n\`\`\``,
    "| Header | Value |\n| a | b |",
    "| Header | Value |\n| --- |\n| a | b |",
    "Paragraph with | a | pipe.",
  ])("does not turn code or invalid pipe syntax into a table", (passage) => {
    expect(markdownTableEvidence(passage)).toEqual([]);
    expect(
      parseKnowledgeUnits("Examples", passage).some(
        (unit) => unit.unitType === "TABLE",
      ),
    ).toBe(false);
  });

  it("preserves duplicate headers by column position instead of merging them", () => {
    const table = markdownTableEvidence(
      "| Value | Value |\n| --- | --- |\n| 12 | 24 |",
    )[0]!;
    expect(table.header.cells.map((cell) => cell.columnIndex)).toEqual([0, 1]);
    expect(table.rows[0]!.cells.map((cell) => cell.source)).toEqual([
      "12",
      "24",
    ]);
  });

  it("does not join adjacent tables or borrow another header", () => {
    const tables = markdownTableEvidence(
      `${TABLE}\n\nOther context.\n\n| Metric | Value |\n|---|---|\n| Queue | 50 |`,
    );
    expect(tables).toHaveLength(2);
    expect(tables[0]!.header.source).toContain("Situation");
    expect(tables[1]!.header.source).toContain("Metric");
    expect(tables[0]!.rows.every((row) => !row.source.includes("50"))).toBe(
      true,
    );
  });
});

describe("bounded table projections", () => {
  const longTable =
    "| Key | Action |\n|---|---|\n" +
    Array.from(
      { length: 24 },
      (_, index) =>
        `| item-${index} | ${index === 20 ? "route to isolated recovery" : "record a routine observation"} |`,
    ).join("\n");

  it("retains the original header and a complete late matching row", () => {
    const projected = rehydrateStructuralContext(
      {
        body: longTable,
        unitType: "TABLE",
        focusText: "isolated recovery",
        parentBody: "Unrelated section parent.",
        parentUnitType: "SECTION",
      },
      180,
    );
    expect(projected.length).toBeLessThanOrEqual(180);
    expect(projected).toContain("| Key | Action |");
    expect(projected).toContain("|---|---|");
    expect(projected).toContain("| item-20 | route to isolated recovery |");
    expect(projected).not.toContain("Unrelated section");
    const table = markdownTableEvidence(projected)[0]!;
    expect(table.rows.every((row) => row.source.endsWith("|"))).toBe(true);
  });

  it("records disjoint source spans and marks omitted rows", () => {
    const table = markdownTableEvidence(longTable)[0]!;
    const projection = projectMarkdownTable(longTable, table, 20, 180);
    expect(projection.omittedRows).toBeGreaterThan(0);
    expect(projection.sourceSpans).toHaveLength(2);
    expect(projection.sourceSpans[1]!.startOffset).toBeGreaterThan(
      projection.sourceSpans[0]!.endOffset,
    );
    for (const span of projection.sourceSpans) {
      expect(projection.text).toContain(
        longTable.slice(span.startOffset, span.endOffset).trimEnd(),
      );
    }
    expect(projection.text).toMatch(/^…\n\n/u);
  });

  it("returns no partial header or row when even one row cannot fit", () => {
    const table = markdownTableEvidence(longTable)[0]!;
    expect(projectMarkdownTable(longTable, table, 20, 16)).toEqual({
      text: "…",
      sourceSpans: [],
      omittedRows: 24,
    });
  });

  it("does not change a table that already fits", () => {
    const table = markdownTableEvidence(TABLE)[0]!;
    expect(projectMarkdownTable(TABLE, table, 1, 200)).toEqual({
      text: TABLE,
      sourceSpans: [table.span],
      omittedRows: 0,
    });
  });

  it("rejects invalid projection budgets", () => {
    const table = markdownTableEvidence(TABLE)[0]!;
    expect(() => projectMarkdownTable(TABLE, table, 0, 0)).toThrow(
      /BUDGET_INVALID/,
    );
  });
});
