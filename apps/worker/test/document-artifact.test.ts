import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  documentArtifactConfigurationHash,
  parseCanonicalExtractionResponse,
  renderDocumentArtifactDraft,
  renderDocumentArtifactPreview,
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
    locator: { ...locator, start_line: 3, end_line: 5 },
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
