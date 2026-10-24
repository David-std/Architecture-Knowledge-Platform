import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseKnowledgeUnits } from "../src/chunking.js";
import { markdownTableEvidence } from "../src/markdown-table-evidence.js";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeProjection(value: string): string {
  return value.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").trim();
}

function persistedUnits(
  units: ReturnType<typeof parseKnowledgeUnits>,
): Array<Record<string, unknown>> {
  return units.map((unit) => ({
    unitKey: unit.unitKey,
    parentUnitKey: unit.parentUnitKey,
    unitType: unit.unitType,
    headingPath: unit.headingPath,
    body: unit.body,
    contentHash: unit.contentHash,
    tokenEstimate: unit.tokenEstimate,
    structuralOrder: unit.structuralOrder,
    containerOnly: unit.containerOnly,
    embeddingEligible: unit.embeddingEligible,
  }));
}

describe("Markdown unit source-span provenance", () => {
  it("maps table, row and cell spans to raw CRLF body_cache text", () => {
    const source = [
      "📚 Source",
      "",
      "| Name | Value | Empty |",
      "| --- | --- | --- |",
      "| repeated | A\\|B | |",
      "| repeated | A\\|B | actual |",
    ].join("\r\n");
    const rawBody = ` \t${source}\r\n \t`;
    const bodyCacheHash = sha256(rawBody);
    const units = parseKnowledgeUnits("Source", rawBody);
    const normalizedUnits = parseKnowledgeUnits(
      "Source",
      source.replace(/\r\n/gu, "\n"),
    );
    const tableUnit = units.find((unit) => unit.unitType === "TABLE");
    const rowUnits = units.filter((unit) => unit.unitType === "TABLE_ROW");
    const cellUnits = units.filter((unit) => unit.unitType === "TABLE_CELL");

    expect(tableUnit).toBeDefined();
    expect(tableUnit!.locator.startChar).toBe(rawBody.indexOf("| Name"));
    expect(tableUnit!.locator.sourceFrame).toBe("markdown-body-cache-raw-v1");
    expect(tableUnit!.locator.sourceEncoding).toBe("utf-16-code-units");
    expect(tableUnit!.locator.sourceBodyHash).toBe(bodyCacheHash);
    expect(tableUnit!.locator.sourceTextProjection).toBe(
      "visible-markdown-lf-trim-v1",
    );
    expect(tableUnit!.locator.sourceTextMasked).toBe(false);
    const tableRaw = rawBody.slice(
      tableUnit!.locator.startChar,
      tableUnit!.locator.endChar,
    );
    expect(tableRaw).not.toBe(tableUnit!.body);
    expect(normalizeProjection(tableRaw)).toBe(tableUnit!.body);
    expect(tableUnit?.contentHash).toBe(sha256(tableUnit!.body));

    const table = markdownTableEvidence(tableUnit!.body)[0]!;
    expect(table.rows).toHaveLength(2);
    expect(table.rows[0]!.cells[2]!.source).toBe("");
    expect(table.rows[0]!.cells[2]!.span.startOffset).toBe(
      table.rows[0]!.cells[2]!.span.endOffset,
    );

    expect(rowUnits).toHaveLength(2);
    const expectedRows = [
      "| repeated | A\\|B | |",
      "| repeated | A\\|B | actual |",
    ];
    for (const [index, row] of table.rows.entries()) {
      const unit = rowUnits[index]!;
      expect(unit.body).toBe(row.source);
      expect(rawBody.slice(unit.locator.startChar, unit.locator.endChar)).toBe(
        expectedRows[index],
      );
      expect(unit.locator.sourceBodyHash).toBe(bodyCacheHash);
      expect(unit.locator.sourceTextMasked).toBe(false);
      expect(unit.contentHash).toBe(sha256(unit.body));
    }

    const expectedCells = new Map([
      ["1:1", "repeated"],
      ["1:2", "A\\|B"],
      ["2:1", "repeated"],
      ["2:2", "A\\|B"],
      ["2:3", "actual"],
    ]);
    expect(cellUnits).toHaveLength(expectedCells.size);
    for (const unit of cellUnits) {
      const key = `${unit.locator.row}:${unit.locator.column}`;
      const expected = expectedCells.get(key);
      expect(expected).toBeDefined();
      expect(unit.body).toBe(expected);
      expect(rawBody.slice(unit.locator.startChar, unit.locator.endChar)).toBe(
        expected,
      );
      expect(unit.locator.sourceBodyHash).toBe(bodyCacheHash);
      expect(unit.locator.sourceTextMasked).toBe(false);
      expect(unit.contentHash).toBe(sha256(unit.body));
    }

    const repeatedValueCells = cellUnits.filter(
      (unit) => unit.body === "repeated",
    );
    expect(repeatedValueCells).toHaveLength(2);
    expect(repeatedValueCells[0]!.locator.startChar).not.toBe(
      repeatedValueCells[1]!.locator.startChar,
    );
    expect(
      cellUnits.some(
        (unit) => unit.body === "A\\|B" && unit.locator.column === 2,
      ),
    ).toBe(true);

    // Provenance metadata is the only changed projection: unit bodies, keys,
    // content hashes and embedding eligibility remain stable across frames.
    expect(persistedUnits(units)).toEqual(persistedUnits(normalizedUnits));

    const persistedLocator = JSON.parse(
      JSON.stringify(
        rowUnits.map((unit) => ({
          locator: unit.locator,
          body: unit.body,
          contentHash: unit.contentHash,
        })),
      ),
    ) as Array<{
      locator: { startChar: number; endChar: number };
      body: string;
      contentHash: string;
    }>;
    expect(persistedLocator).toEqual(
      rowUnits.map((unit) => ({
        locator: unit.locator,
        body: unit.body,
        contentHash: unit.contentHash,
      })),
    );
  });

  it("counts astral characters as UTF-16 units in the raw frame", () => {
    const source = "🧭\r\n\r\n| Key | Value |\r\n| --- | --- |\r\n| A | B |";
    const rawBody = `\t${source}\r\n `;
    const table = parseKnowledgeUnits("Compass", rawBody).find(
      (unit) => unit.unitType === "TABLE",
    );
    expect(table).toBeDefined();
    expect(table!.locator.startChar).toBe(rawBody.indexOf("| Key"));
    const rawTable = rawBody.slice(
      table!.locator.startChar,
      table!.locator.endChar,
    );
    expect(rawTable).not.toBe(table!.body);
    expect(normalizeProjection(rawTable)).toBe(table!.body);
    expect(table!.locator.endChar - table!.locator.startChar).toBe(
      rawTable.length,
    );
    expect(table!.locator.sourceBodyHash).toBe(sha256(rawBody));
  });

  it("marks hidden-comment spans as masked instead of claiming an exact quote", () => {
    const rawBody =
      "\r\n  Visible before <!-- hidden detail --> visible after\r\n";
    const units = parseKnowledgeUnits("Hidden", rawBody);
    const paragraph = units.find((unit) => unit.unitType === "PARAGRAPH");
    expect(paragraph).toBeDefined();
    const rawSlice = rawBody.slice(
      paragraph!.locator.startChar,
      paragraph!.locator.endChar,
    );
    expect(rawSlice).toContain("<!-- hidden detail -->");
    expect(rawSlice).not.toBe(paragraph!.body);
    expect(paragraph!.locator.sourceTextMasked).toBe(true);
    expect(paragraph!.locator.sourceTextProjection).toBe(
      "visible-markdown-lf-trim-v1",
    );
    expect(paragraph!.locator.sourceBodyHash).toBe(sha256(rawBody));
  });

  it("keeps legacy normalized lines explicit and maps sections, paragraphs and fragments", () => {
    const longText = "terminal marker ".repeat(110);
    const rawBody = [
      "",
      "",
      "# Retrieval section",
      "",
      "Short paragraph before the comment.",
      "",
      "<!-- comment between blocks -->",
      "",
      longText,
    ].join("\r\n");
    const units = parseKnowledgeUnits("Document", rawBody);
    const section = units.find((unit) => unit.unitType === "SECTION");
    const paragraphs = units.filter((unit) => unit.unitType === "PARAGRAPH");
    const fragments = units.filter(
      (unit) => unit.unitType === "PARAGRAPH" && unit.locator.fragment,
    );

    expect(section).toBeDefined();
    expect(paragraphs.length).toBeGreaterThanOrEqual(2);
    expect(fragments.length).toBeGreaterThan(1);
    expect(section!.locator.lineFrame).toBe("normalized-lf-trim-v1");
    expect(section!.locator.sourceStartLine).toBeGreaterThan(
      section!.locator.startLine,
    );

    const rawLineAt = (offset: number): number =>
      rawBody.slice(0, offset).split(/\r\n|\r|\n/gu).length;
    for (const unit of [section, ...paragraphs]) {
      const rawStart = unit!.locator.startChar;
      const rawEnd = unit!.locator.endChar;
      expect(rawStart).toBeGreaterThanOrEqual(0);
      expect(rawEnd).toBeLessThanOrEqual(rawBody.length);
      expect(rawEnd).toBeGreaterThanOrEqual(rawStart);
      expect(unit!.locator.lineFrame).toBe("normalized-lf-trim-v1");
      expect(unit!.locator.sourceStartLine).toBe(rawLineAt(rawStart));
      expect(unit!.locator.sourceEndLine).toBe(
        rawLineAt(Math.max(rawStart, rawEnd - 1)),
      );
      const rawSlice = rawBody.slice(rawStart, rawEnd);
      if (unit!.locator.sourceTextMasked) {
        expect(rawSlice).toContain("<!-- comment between blocks -->");
        expect(rawSlice).not.toBe(unit!.body);
      } else {
        expect(normalizeProjection(rawSlice)).toBe(unit!.body);
      }
      expect(unit!.locator.sourceBodyHash).toBe(sha256(rawBody));
    }
    expect(paragraphs.some((unit) => unit.locator.sourceTextMasked)).toBe(
      false,
    );
    expect(section!.locator.sourceTextMasked).toBe(true);
    expect(fragments.every((unit) => unit.locator.fragment)).toBe(true);
  });

  it("handles EOF without a newline and whitespace-only or empty bodies", () => {
    const tail = "  tail without a final newline";
    const tailParagraph = parseKnowledgeUnits("Tail", tail).find(
      (unit) => unit.unitType === "PARAGRAPH",
    );
    expect(tailParagraph).toBeDefined();
    expect(
      tail.slice(
        tailParagraph!.locator.startChar,
        tailParagraph!.locator.endChar,
      ),
    ).toBe("tail without a final newline");
    expect(tailParagraph!.locator.sourceStartLine).toBe(1);
    expect(tailParagraph!.locator.sourceEndLine).toBe(1);

    const whitespace = "\r\n \t";
    const whitespaceUnits = parseKnowledgeUnits("Whitespace", whitespace);
    expect(whitespaceUnits).toHaveLength(1);
    expect(whitespaceUnits[0]!.body).toBe("");
    expect(whitespaceUnits[0]!.locator.startChar).toBe(whitespace.length);
    expect(whitespaceUnits[0]!.locator.endChar).toBe(whitespace.length);
    expect(whitespaceUnits[0]!.locator.sourceBodyHash).toBe(sha256(whitespace));

    const emptyUnits = parseKnowledgeUnits("Empty", "");
    expect(emptyUnits).toHaveLength(1);
    expect(emptyUnits[0]!.locator.startChar).toBe(0);
    expect(emptyUnits[0]!.locator.endChar).toBe(0);
    expect(emptyUnits[0]!.locator.sourceStartLine).toBe(1);
    expect(emptyUnits[0]!.locator.sourceEndLine).toBe(1);
  });
});
