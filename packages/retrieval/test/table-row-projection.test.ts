import { describe, expect, it } from "vitest";
import { parseKnowledgeUnits } from "../src/chunking.js";
import { projectTableRows } from "../src/table-row-projection.js";

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
});
