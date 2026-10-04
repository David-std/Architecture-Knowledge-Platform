import { describe, expect, it } from "vitest";
import { parseKnowledgeUnits } from "../../../packages/retrieval/src/chunking.js";
import {
  canonicalJson,
  documentArtifactConfigurationHash,
  parseCanonicalExtractionResponse,
  renderDocumentArtifactDraft,
  renderDocumentArtifactPreview,
  renderDocumentArtifactMarkdown,
} from "../src/document-artifact.js";

const sourceId = "00000000-0000-0000-0000-000000000123";
const sourceHash = "a".repeat(64);

function response(): Record<string, unknown> {
  const locator = {
    kind: "markdown",
    source_hash: sourceHash,
    path: "C:\\private\\evidence.md",
    start_line: 1,
    end_line: 1,
    heading_path: ["Rule"],
  };
  const heading = {
    id: "heading-1",
    kind: "heading",
    text: "Rule",
    locator,
    metadata: { level: 1, localPath: "C:\\private\\evidence.md" },
  };
  const list = {
    id: "list-2",
    kind: "list-item",
    text: "Preserve evidence",
    locator: { ...locator, start_line: 2, end_line: 2 },
    metadata: {},
  };
  const table = {
    id: "table-3",
    kind: "table",
    text: "key | value",
    locator: { ...locator, table: 3, start_line: 3, end_line: 5 },
    metadata: {},
    headers: ["key", "value"],
    rows: [["mode", "local"]],
  };
  const code = {
    id: "code-4",
    kind: "code",
    text: "print(1)",
    locator: { ...locator, start_line: 6, end_line: 8 },
    metadata: { language: "python" },
  };
  return {
    extractor: "deterministic-text",
    extractor_version: "1.0.0",
    routing: {
      endpoint: "http://private-extractor:8090",
      selected: "deterministic",
    },
    warnings: ["read C:\\private\\evidence.md"],
    document_artifact: {
      source_id: sourceId,
      source_hash: sourceHash,
      media_type: "text/markdown",
      extractor: "deterministic-text",
      extractor_version: "1.0.0",
      configuration: {
        alpha: 1,
        nested: { token: "do-not-store", mode: "local" },
      },
      pages: [],
      blocks: [heading, list, table, code],
      headings: [heading],
      paragraphs: [],
      lists: [list],
      tables: [table],
      figures: [],
      equations: [],
      code: [code],
      bounding_boxes: [],
      reading_order: ["heading-1", "list-2", "table-3", "code-4"],
      locators: [locator],
      warnings: [],
      quality: "DETERMINISTIC",
      quality_metrics: { blocks: 4 },
    },
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("canonical document artifact consumption", () => {
  it("verifies identity and removes host paths and secrets", () => {
    const parsed = parseCanonicalExtractionResponse(response(), {
      sourceId,
      sourceHash,
      mediaType: "text/markdown",
    });
    expect(parsed.artifact.source_id).toBe(sourceId);
    expect(parsed.artifact.blocks[0]?.locator.path).toBe(`source:${sourceId}`);
    expect(parsed.artifact.blocks[0]?.metadata.localPath).toBe("[REDACTED]");
    expect(
      (parsed.artifact.configuration.nested as Record<string, unknown>).token,
    ).toBe("[REDACTED]");
    expect(parsed.routing.endpoint).toBe("[REDACTED]");
    expect(canonicalJson(parsed.artifact)).not.toContain("C:\\\\private");
    expect(parsed.configurationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a missing artifact and identity mismatches", () => {
    expect(() =>
      parseCanonicalExtractionResponse({}, { sourceId, sourceHash }),
    ).toThrow("EXTRACTOR_DOCUMENT_ARTIFACT_REQUIRED");
    expect(() =>
      parseCanonicalExtractionResponse(response(), {
        sourceId: "other-source",
        sourceHash,
      }),
    ).toThrow("EXTRACTOR_SOURCE_ID_MISMATCH");
    expect(() =>
      parseCanonicalExtractionResponse(response(), {
        sourceId,
        sourceHash: "b".repeat(64),
      }),
    ).toThrow("EXTRACTOR_SOURCE_HASH_MISMATCH");
  });

  it("renders structural Markdown rather than flattening the artifact", () => {
    const parsed = parseCanonicalExtractionResponse(response(), {
      sourceId,
      sourceHash,
    });
    const preview = renderDocumentArtifactPreview(parsed.artifact);
    expect(preview.truncated).toBe(false);
    expect(preview.markdown).toContain("## Rule");
    expect(preview.markdown).toContain("- Preserve evidence");
    expect(preview.markdown).toContain("| key | value |");
    expect(preview.markdown).toContain("```python");
    expect(preview.markdown).toContain("akp-locator");
    expect(preview.markdown).toContain("table=3");
  });

  it("enriches generic block entries from specialized artifact arrays", () => {
    const parsed = parseCanonicalExtractionResponse(response(), {
      sourceId,
      sourceHash,
    });
    const richTable = parsed.artifact.tables[0]!;
    const genericTable = {
      ...richTable,
      headers: undefined,
      rows: undefined,
    };
    const artifact = {
      ...parsed.artifact,
      blocks: parsed.artifact.blocks.map((item) =>
        item.id === richTable.id ? genericTable : item,
      ),
      tables: [richTable],
    };

    const markdown = renderDocumentArtifactMarkdown(artifact);
    expect(markdown).toContain("| key | value |");
    expect(markdown).toContain("| mode | local |");
  });

  it("hashes configuration independently of object key order", () => {
    expect(documentArtifactConfigurationHash({ beta: 2, alpha: 1 })).toBe(
      documentArtifactConfigurationHash({ alpha: 1, beta: 2 }),
    );
  });

  it("renders a source draft with a structural artifact reference and no host URI", () => {
    const parsed = parseCanonicalExtractionResponse(response(), {
      sourceId,
      sourceHash,
    });
    const draft = renderDocumentArtifactDraft({
      externalId: "SRC-INGEST-AAAA",
      title: "Evidence",
      sourceId,
      sourceArtifactId: "00000000-0000-0000-0000-000000000456",
      sha256: sourceHash,
      mediaType: "text/markdown",
      extractor: parsed.extractor,
      extractorVersion: parsed.extractorVersion,
      artifact: parsed.artifact,
    });
    expect(draft).toContain(`source_id: ${sourceId}`);
    expect(draft).toContain(
      "source_artifact_id: 00000000-0000-0000-0000-000000000456",
    );
    expect(draft).toContain("## Rule");
    expect(draft).toContain("## Uncertainty");
    expect(draft).not.toContain("file:///captured");
    expect(draft).not.toContain("C:\\\\private");
  });
});

describe("complete extraction material", () => {
  it("carries English and Spanish captions through Markdown and parser units", () => {
    const parsed = parseCanonicalExtractionResponse(response(), {
      sourceId,
      sourceHash,
    });
    const table = {
      ...parsed.artifact.tables[0]!,
      id: "caption-table",
      text: null,
      caption: "Compatibility matrix",
      locator: {
        ...parsed.artifact.tables[0]!.locator,
        page: 4,
        table: 7,
        start_line: 10,
        end_line: 12,
      },
    };
    const figure = {
      ...parsed.artifact.blocks[0]!,
      id: "caption-figure",
      kind: "figure" as const,
      text: null,
      caption: "Flujo de recuperación",
      locator: {
        ...parsed.artifact.blocks[0]!.locator,
        page: 5,
        start_line: 20,
        end_line: 20,
      },
    };
    const artifact = {
      ...parsed.artifact,
      blocks: [table, figure],
      tables: [table],
      figures: [figure],
      reading_order: [table.id, figure.id],
    };

    const markdown = renderDocumentArtifactMarkdown(artifact);
    expect(markdown).toContain("Compatibility matrix");
    expect(markdown).toContain("Flujo de recuperación");
    expect(markdown.indexOf("Compatibility matrix")).toBeLessThan(
      markdown.indexOf("Flujo de recuperación"),
    );
    expect(countOccurrences(markdown, "Compatibility matrix")).toBe(1);
    expect(countOccurrences(markdown, "Flujo de recuperación")).toBe(1);
    expect(countOccurrences(markdown, "akp-locator")).toBe(3);

    const units = parseKnowledgeUnits("Caption source", markdown);
    const tableCaptionUnit = units.find(
      (unit) => unit.body === "Compatibility matrix",
    );
    expect(tableCaptionUnit).toBeDefined();
    expect(
      markdown.slice(
        tableCaptionUnit!.locator.startChar,
        tableCaptionUnit!.locator.endChar,
      ),
    ).toBe("Compatibility matrix");
    expect(tableCaptionUnit!.locator.page).toBe(4);
    expect(tableCaptionUnit!.locator.table).toBe(7);
    expect(
      units.some(
        (unit) =>
          unit.unitType === "PARAGRAPH" && unit.body === "Compatibility matrix",
      ),
    ).toBe(true);
    expect(
      units.some(
        (unit) =>
          unit.unitType === "TABLE" &&
          unit.locator.table === 7 &&
          unit.body.includes("| key | value |"),
      ),
    ).toBe(true);
    const tableUnit = units.find((unit) => unit.unitType === "TABLE");
    expect(tableUnit).toBeDefined();
    expect(tableUnit!.locator.page).toBe(4);
    expect(tableUnit!.locator.table).toBe(7);
    const tableRowUnit = units.find((unit) => unit.unitType === "TABLE_ROW");
    expect(tableRowUnit).toBeDefined();
    expect(tableRowUnit!.locator.page).toBe(4);
    expect(tableRowUnit!.locator.table).toBe(7);
    const figureCaptionUnit = units.find(
      (unit) =>
        !unit.containerOnly && unit.body.includes("Flujo de recuperación"),
    );
    expect(figureCaptionUnit).toBeDefined();
    expect(figureCaptionUnit!.locator.page).toBe(5);
    const figureCaptionStart = markdown.indexOf("Flujo de recuperación");
    expect(
      markdown.slice(
        figureCaptionStart,
        figureCaptionStart + "Flujo de recuperación".length,
      ),
    ).toBe("Flujo de recuperación");
    expect(
      units.some(
        (unit) =>
          !unit.containerOnly && unit.body.includes("Flujo de recuperación"),
      ),
    ).toBe(true);
  });

  it("keeps distinct text and caption values once, and avoids duplicate equal values", () => {
    const parsed = parseCanonicalExtractionResponse(response(), {
      sourceId,
      sourceHash,
    });
    const distinct = {
      ...parsed.artifact.blocks[0]!,
      id: "distinct-figure",
      kind: "figure" as const,
      text: "OCR description",
      caption: "Caption from source",
    };
    const equal = {
      ...distinct,
      id: "equal-figure",
      text: "Same caption",
      caption: "Same caption",
    };
    const equalTable = {
      ...parsed.artifact.tables[0]!,
      id: "equal-table",
      text: "Same table caption",
      caption: "Same table caption",
    };
    const artifact = {
      ...parsed.artifact,
      blocks: [distinct, equal, equalTable],
      tables: [equalTable],
      figures: [distinct, equal],
      reading_order: [distinct.id, equal.id, equalTable.id],
    };
    const markdown = renderDocumentArtifactMarkdown(artifact);
    expect(markdown).toContain("> Figure: OCR description");
    expect(markdown).toContain("Caption from source");
    expect(countOccurrences(markdown, "Caption from source")).toBe(1);
    expect(markdown).toContain("> Figure: Same caption");
    expect(countOccurrences(markdown, "Same caption")).toBe(1);
    expect(markdown).toContain("Same table caption");
    expect(countOccurrences(markdown, "Same table caption")).toBe(1);
  });

  it("retains missing captions and escaped table cells without inventing a caption", () => {
    const parsed = parseCanonicalExtractionResponse(response(), {
      sourceId,
      sourceHash,
    });
    const table = {
      ...parsed.artifact.tables[0]!,
      id: "escaped-table",
      caption: undefined,
      headers: ["Name | mode", "Value"],
      rows: [["local | default", "yes"]],
    };
    const figure = {
      ...parsed.artifact.blocks[0]!,
      id: "missing-caption-figure",
      kind: "figure" as const,
      text: null,
      caption: null,
    };
    const artifact = {
      ...parsed.artifact,
      blocks: [table, figure],
      tables: [table],
      figures: [figure],
      reading_order: [table.id, figure.id],
    };
    const markdown = renderDocumentArtifactMarkdown(artifact);
    expect(markdown).toContain("| Name \\| mode | Value |");
    expect(markdown).toContain("| local \\| default | yes |");
    expect(markdown).toContain("> Figure (no caption extracted)");
    expect(markdown).not.toContain("undefined");
    expect(markdown).not.toContain("null");
  });

  it("keeps the exact no-grid text fallback while adding distinct or equal captions", () => {
    const parsed = parseCanonicalExtractionResponse(response(), {
      sourceId,
      sourceHash,
    });
    const baseLocator = {
      ...parsed.artifact.tables[0]!.locator,
      page: 4,
      table: 11,
      start_line: 3,
      end_line: 3,
    };
    const locator =
      "<!-- akp-locator: page=4; table=11; line=3; heading=Rule -->\n";
    const noCaption = {
      ...parsed.artifact.tables[0]!,
      id: "no-grid-no-caption",
      text: "Legacy table extraction",
      caption: undefined,
      headers: [],
      rows: [],
      locator: baseLocator,
    };
    const distinctCaption = {
      ...noCaption,
      id: "no-grid-distinct-caption",
      text: "Legacy table extraction",
      caption: "Source table caption",
    };
    const equalCaption = {
      ...noCaption,
      id: "no-grid-equal-caption",
      text: "Same table text",
      caption: "Same table text",
    };

    expect(
      renderDocumentArtifactMarkdown({
        ...parsed.artifact,
        blocks: [noCaption],
        tables: [noCaption],
        reading_order: [noCaption.id],
      }),
    ).toBe(`${locator}Legacy table extraction`);
    expect(
      renderDocumentArtifactMarkdown({
        ...parsed.artifact,
        blocks: [distinctCaption],
        tables: [distinctCaption],
        reading_order: [distinctCaption.id],
      }),
    ).toBe(
      `${locator}Source table caption\n\n${locator}Legacy table extraction`,
    );
    expect(
      renderDocumentArtifactMarkdown({
        ...parsed.artifact,
        blocks: [equalCaption],
        tables: [equalCaption],
        reading_order: [equalCaption.id],
      }),
    ).toBe(`${locator}Same table text`);
  });

  it("preserves all table rows when the provider detected no headers", () => {
    const parsed = parseCanonicalExtractionResponse(response(), {
      sourceId,
      sourceHash,
    });
    const table = {
      ...parsed.artifact.tables[0]!,
      headers: [],
      rows: [
        ["alpha", "12"],
        ["beta", "36", "days"],
      ],
    };
    const artifact = {
      ...parsed.artifact,
      blocks: [table],
      tables: [table],
      reading_order: [table.id!],
    };
    const markdown = renderDocumentArtifactMarkdown(artifact);
    expect(markdown).toContain("| Column 1 | Column 2 | Column 3 |");
    expect(markdown).toContain("| alpha | 12 |  |");
    expect(markdown).toContain("| beta | 36 | days |");
    const units = parseKnowledgeUnits("Extracted table", markdown);
    const tableUnit = units.find((unit) => unit.unitType === "TABLE");
    const rows = units.filter((unit) => unit.unitType === "TABLE_ROW");
    const cells = units.filter((unit) => unit.unitType === "TABLE_CELL");
    expect(tableUnit).toMatchObject({
      containerOnly: true,
      embeddingEligible: false,
      locator: { table: 3 },
    });
    expect(tableUnit?.locator.sourceCommentSpans).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(rows.map((unit) => unit.body)).toEqual([
      "| alpha | 12 |  |",
      "| beta | 36 | days |",
    ]);
    expect(rows.map((unit) => unit.locator)).toEqual([
      expect.objectContaining({ table: 3, row: 1 }),
      expect.objectContaining({ table: 3, row: 2 }),
    ]);
    expect(rows.every((unit) => unit.embeddingEligible)).toBe(true);
    expect(cells).toHaveLength(5);
    expect(cells.find((unit) => unit.body === "days")?.locator).toEqual(
      expect.objectContaining({ table: 3, row: 2, column: 3 }),
    );
    expect(rows.every((unit) => !unit.body.includes("akp-locator"))).toBe(true);
  });

  it("limits only the preview while retaining a later answer in the review draft", () => {
    const parsed = parseCanonicalExtractionResponse(response(), {
      sourceId,
      sourceHash,
    });
    const block = {
      ...parsed.artifact.blocks[0]!,
      id: "long-material",
      kind: "paragraph",
      text:
        "Neutral extracted material. ".repeat(300) +
        "\n\nThe recovery window is 47 minutes.",
    };
    const artifact = {
      ...parsed.artifact,
      blocks: [block],
      paragraphs: [block],
      reading_order: [block.id],
    };
    expect(renderDocumentArtifactPreview(artifact, 6000).truncated).toBe(true);
    const draft = renderDocumentArtifactDraft({
      externalId: "SRC-LONG",
      title: "Long material",
      sourceId,
      sourceArtifactId: "00000000-0000-4000-8000-000000000456",
      sha256: sourceHash,
      mediaType: "text/plain",
      extractor: parsed.extractor,
      extractorVersion: parsed.extractorVersion,
      artifact,
    });
    expect(draft).toContain("The recovery window is 47 minutes.");
    expect(draft).not.toContain("Preview truncated");
    // Only the body enters chunking after the normal Markdown front-matter parser.
    const body = draft.replace(/^---\n[\s\S]*?\n---\n/u, "");
    const units = parseKnowledgeUnits("Long material", body);
    const answer = units.find(
      (unit) =>
        !unit.containerOnly &&
        unit.body.includes("The recovery window is 47 minutes."),
    );
    expect(answer?.embeddingEligible).toBe(true);
    expect(answer?.body.length).toBeLessThanOrEqual(1_200);
    expect(
      units
        .filter((unit) => !unit.containerOnly)
        .some((unit) => unit.body.includes("akp-locator")),
    ).toBe(false);
  });
});
