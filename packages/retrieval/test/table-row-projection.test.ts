import { describe, expect, it } from "vitest";
import { parseKnowledgeUnits } from "../src/chunking.js";
import { projectTableRows } from "../src/table-row-projection.js";

function locatedCaptionSource(
  captionLocator: string,
  tableLocator: string,
  caption: string,
  firstCell: string,
): string {
  return [
    "# Scope matrix",
    `<!-- akp-locator: ${captionLocator} -->`,
    caption,
    "",
    `<!-- akp-locator: ${tableLocator} -->`,
    "| Key | Value |",
    "| --- | --- |",
    `| ${firstCell} | retained |`,
  ].join("\n");
}

describe("table row projection", () => {
  it("derives explicit header-value pairs while preserving exact source spans", () => {
    const source = [
      "# Performance",
      "Context that is not a caption.",
      "",
      "| Class | Quarter | Accuracy |",
      "| --- | --- | --- |",
      "| 3 | Q2 | 97.2% |",
    ].join("\n");

    const projections = projectTableRows("Reliability report", source);
    const parsedRow = parseKnowledgeUnits("Reliability report", source).find(
      (unit) => unit.unitType === "TABLE_ROW",
    );

    expect(projections).toHaveLength(1);
    expect(projections[0]?.unitKey).toBe(parsedRow?.unitKey);
    expect(projections[0]).toMatchObject({
      kind: "TABLE_ROW",
      derivation: "DETERMINISTIC_PARSED",
      tableIndex: 1,
      rowIndex: 1,
      title: "Reliability report",
      headingPath: ["Performance"],
      cells: [
        {
          columnIndex: 1,
          header: "Class",
          normalizedHeader: "Class",
          rawValue: "3",
          normalizedValue: "3",
        },
        {
          columnIndex: 2,
          header: "Quarter",
          normalizedHeader: "Quarter",
          rawValue: "Q2",
          normalizedValue: "Q2",
        },
        {
          columnIndex: 3,
          header: "Accuracy",
          normalizedHeader: "Accuracy",
          rawValue: "97.2%",
          normalizedValue: "97.2%",
        },
      ],
    });
    expect(projections[0]?.caption).toBeUndefined();
    expect(projections[0]?.lexicalText).toContain("Quarter = Q2");
    expect(projections[0]?.embeddingText).toContain("Accuracy = 97.2%");

    for (const cell of projections[0]?.cells ?? []) {
      expect(
        source.slice(cell.sourceSpan.startOffset, cell.sourceSpan.endOffset),
      ).toBe(cell.rawValue);
    }
    const row = projections[0]!;
    expect(
      source.slice(row.sourceSpan.startOffset, row.sourceSpan.endOffset),
    ).toBe("| 3 | Q2 | 97.2% |");
  });

  it("attaches only an explicitly located table caption", () => {
    const source = [
      "# Extract",
      "<!-- akp-locator: page=4; table=7 -->",
      "Compatibility matrix",
      "",
      "<!-- akp-locator: page=4; table=7 -->",
      "| Mode | Value |",
      "| --- | --- |",
      "| local | enabled |",
    ].join("\n");

    const [projection] = projectTableRows("Extracted source", source);

    expect(projection).toMatchObject({
      tableIndex: 7,
      rowIndex: 1,
      caption: "Compatibility matrix",
      cells: [
        { header: "Mode", rawValue: "local" },
        { header: "Value", rawValue: "enabled" },
      ],
    });
    expect(projection?.lexicalText).toContain("Compatibility matrix");
    expect(projection?.embeddingText).toContain(
      "Caption: Compatibility matrix",
    );
  });

  it("keeps raw source bytes separate from normalized matching values", () => {
    const source = [
      "# Datos",
      "| Región | Responsable |",
      "| --- | --- |",
      "| Lima | José   Pérez |",
    ].join("\r\n");

    const [projection] = projectTableRows("Operación", source);
    const owner = projection?.cells[1];

    expect(owner).toMatchObject({
      header: "Responsable",
      rawValue: "José   Pérez",
      normalizedValue: "José Pérez",
    });
    expect(
      source.slice(owner!.sourceSpan.startOffset, owner!.sourceSpan.endOffset),
    ).toBe("José   Pérez");
    expect(projection?.sourceBodyHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(projection?.tableId).toBe(`${projection?.sourceBodyHash}:table:1`);
  });

  it.each([
    ["same page", "page=4; table=7", "page=4; table=7", true],
    ["same slide", "slide=2; table=7", "slide=2; table=7", true],
    ["same sheet", "sheet=Orders; table=7", "sheet=Orders; table=7", true],
    ["both absent", "table=7", "table=7", true],
    ["different page", "page=4; table=7", "page=5; table=7", false],
    ["different slide", "slide=2; table=7", "slide=3; table=7", false],
    [
      "different sheet",
      "sheet=Orders; table=7",
      "sheet=Archive; table=7",
      false,
    ],
    ["caption scoped and table absent", "page=4; table=7", "table=7", false],
    ["caption absent and table scoped", "table=7", "page=4; table=7", false],
  ] as const)(
    "matches captions only for equal portable scope: %s",
    (_label, captionLocator, tableLocator, shouldAttach) => {
      const source = locatedCaptionSource(
        captionLocator,
        tableLocator,
        "Scoped caption",
        "row-value",
      );
      const [projection] = projectTableRows("Scope fixture", source);

      expect(projection?.caption).toBe(
        shouldAttach ? "Scoped caption" : undefined,
      );
      expect(projection?.tableIndex).toBe(7);
      expect(projection?.rowIndex).toBe(1);
      expect(
        source.slice(
          projection!.sourceSpan.startOffset,
          projection!.sourceSpan.endOffset,
        ),
      ).toBe("| row-value | retained |");
      for (const cell of projection?.cells ?? []) {
        expect(
          source.slice(cell.sourceSpan.startOffset, cell.sourceSpan.endOffset),
        ).toBe(cell.rawValue);
      }
    },
  );

  it("excludes hidden HTML comments while retaining visible projection and exact spans", () => {
    const source = [
      "# Hidden scope",
      "<!-- akp-locator: page=4; table=7 -->",
      "Caption visible <!-- HIDDEN_CAPTION -->",
      "",
      "<!-- akp-locator: page=4; table=7 -->",
      "| <!-- HIDDEN_HEADER --> Public header | Value |",
      "| --- | --- |",
      "| Public value | 42 |",
    ].join("\n");

    const [projection] = projectTableRows("Hidden scope fixture", source);

    expect(projection).toMatchObject({
      tableIndex: 7,
      rowIndex: 1,
      caption: "Caption visible",
      cells: [
        { header: "Public header", rawValue: "Public value" },
        { header: "Value", rawValue: "42" },
      ],
    });
    expect(projection?.lexicalText).not.toContain("HIDDEN_");
    expect(projection?.embeddingText).not.toContain("HIDDEN_");
    expect(
      source.slice(
        projection!.sourceSpan.startOffset,
        projection!.sourceSpan.endOffset,
      ),
    ).toBe("| Public value | 42 |");
    for (const cell of projection?.cells ?? []) {
      expect(
        source.slice(cell.sourceSpan.startOffset, cell.sourceSpan.endOffset),
      ).toBe(cell.rawValue);
    }
  });
});
