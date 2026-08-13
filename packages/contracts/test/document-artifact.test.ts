import { describe, expect, it } from "vitest";
import { DocumentArtifact } from "../src/index.js";

const hash = "a".repeat(64);

describe("DocumentArtifact wire compatibility", () => {
  it("accepts the snake_case payload emitted by FastAPI/Pydantic", () => {
    const parsed = DocumentArtifact.parse({
      source_id: "fixture:structured-document",
      source_hash: hash,
      media_type: "application/pdf",
      extractor: "deterministic",
      extractor_version: "1.0",
      configuration: { backend: "local" },
      pages: [],
      blocks: [
        {
          id: "block-1",
          kind: "paragraph",
          text: "Bounded structured content",
          locator: { kind: "pdf", source_hash: hash, page: 1 },
          metadata: {},
        },
        {
          id: "list-item-1",
          kind: "list-item",
          text: "A structural list item",
          locator: { kind: "text", source_hash: hash, page: 1 },
          metadata: {},
        },
      ],
      reading_order: ["block-1", "list-item-1"],
      quality: "MACHINE_EXTRACTED",
      quality_metrics: { text_recall: 1 },
    });

    expect(parsed.blocks[0]?.locator.page).toBe(1);
    expect(parsed.blocks[1]?.kind).toBe("list-item");
    expect(parsed.reading_order).toEqual(["block-1", "list-item-1"]);
  });

  it("rejects broken locator hashes and reading-order references", () => {
    const result = DocumentArtifact.safeParse({
      source_id: "fixture:broken",
      source_hash: hash,
      media_type: "text/plain",
      extractor: "deterministic",
      extractor_version: "1.0",
      blocks: [
        {
          id: "block-1",
          kind: "paragraph",
          locator: {
            kind: "text",
            path: "fixture",
            source_hash: "b".repeat(64),
          },
        },
      ],
      reading_order: ["missing"],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a mismatched hash on an artifact-level locator", () => {
    const result = DocumentArtifact.safeParse({
      source_id: "fixture:broken-root-locator",
      source_hash: hash,
      media_type: "text/plain",
      extractor: "deterministic",
      extractor_version: "1.0",
      locators: [
        {
          kind: "source",
          path: "fixture",
          source_hash: "b".repeat(64),
        },
      ],
    });

    expect(result.success).toBe(false);
  });
});
