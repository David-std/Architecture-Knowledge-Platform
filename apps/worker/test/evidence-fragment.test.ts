import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DocumentArtifact } from "@akp/contracts";
import { selectEvidenceFragment } from "../src/evidence-fragment.js";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_HASH = "a".repeat(64);

function artifact() {
  return DocumentArtifact.parse({
    source_id: SOURCE_ID,
    source_hash: SOURCE_HASH,
    media_type: "text/markdown",
    extractor: "fixture",
    extractor_version: "1",
    headings: [
      {
        id: "h1",
        kind: "heading",
        text: "Cache guidance",
        locator: {
          kind: "heading",
          source_hash: SOURCE_HASH,
          path: `source:${SOURCE_ID}`,
          heading_path: ["Cache guidance"],
        },
      },
    ],
    paragraphs: [
      {
        id: "p1",
        kind: "paragraph",
        text: "Invalidate cached material when the authoritative revision changes.",
        locator: {
          kind: "paragraph",
          source_hash: SOURCE_HASH,
          path: `source:${SOURCE_ID}`,
          paragraph: 1,
          heading_path: ["Cache guidance"],
        },
      },
    ],
    reading_order: ["h1", "p1"],
    locators: [
      {
        kind: "heading",
        source_hash: SOURCE_HASH,
        path: `source:${SOURCE_ID}`,
        heading_path: ["Cache guidance"],
      },
      {
        kind: "paragraph",
        source_hash: SOURCE_HASH,
        path: `source:${SOURCE_ID}`,
        paragraph: 1,
        heading_path: ["Cache guidance"],
      },
    ],
  });
}

describe("evidence fragment selection", () => {
  it("binds structural locator, excerpt and digest to the same item", () => {
    const fragment = selectEvidenceFragment(artifact(), "fallback preview");
    expect(fragment).toMatchObject({
      precision: "STRUCTURAL",
      locator: { kind: "paragraph", paragraph: 1 },
      excerpt:
        "Invalidate cached material when the authoritative revision changes.",
    });
    expect(fragment.excerptHash).toBe(
      createHash("sha256").update(fragment.excerpt).digest("hex"),
    );
  });

  it("uses a broad source locator only when no structured text exists", () => {
    const empty = DocumentArtifact.parse({
      source_id: SOURCE_ID,
      source_hash: SOURCE_HASH,
      media_type: "image/png",
      extractor: "fixture",
      extractor_version: "1",
    });
    const fragment = selectEvidenceFragment(empty, "Bounded source preview");
    expect(fragment).toMatchObject({
      precision: "SOURCE",
      locator: {
        kind: "source",
        source_hash: SOURCE_HASH,
        path: `source:${SOURCE_ID}`,
      },
      excerpt: "Bounded source preview",
    });
    expect(fragment.excerptHash).toBe(
      createHash("sha256").update("Bounded source preview").digest("hex"),
    );
  });
});
