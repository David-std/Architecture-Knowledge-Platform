import { createHash } from "node:crypto";
import type { DocumentArtifact, StructuralLocator } from "@akp/contracts";

type DocumentArtifactItem = DocumentArtifact["paragraphs"][number];

export interface EvidenceFragment {
  locator: StructuralLocator;
  excerpt: string;
  excerptHash: string;
  precision: "STRUCTURAL" | "SOURCE";
}

function normalizedExcerpt(value: string, maxCharacters: number): string {
  return value.replaceAll(/\r\n/g, "\n").trim().slice(0, maxCharacters).trim();
}

function itemText(item: DocumentArtifactItem): string {
  const text = item.text?.trim();
  if (text) return text;
  if (item.rows?.length) {
    const lines: string[] = [];
    if (item.headers?.length) lines.push(item.headers.join(" | "));
    lines.push(...item.rows.map((row) => row.join(" | ")));
    return lines.join("\n").trim();
  }
  return item.caption?.trim() ?? "";
}

function structuralItems(artifact: DocumentArtifact): DocumentArtifactItem[] {
  return [
    ...artifact.paragraphs,
    ...artifact.lists,
    ...artifact.tables,
    ...artifact.code,
    ...artifact.equations,
    ...artifact.figures,
    ...artifact.blocks,
    ...artifact.headings,
    ...artifact.pages,
  ];
}

function fragmentHash(excerpt: string): string {
  return createHash("sha256").update(excerpt).digest("hex");
}

/**
 * Select one bounded evidence fragment whose locator, excerpt and digest all
 * describe the same material. Structured text wins; a broad source locator is
 * used only when the extractor exposed no substantive item text.
 */
export function selectEvidenceFragment(
  artifact: DocumentArtifact,
  fallbackText: string,
  maxCharacters = 2_000,
): EvidenceFragment {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) {
    throw new Error("EVIDENCE_FRAGMENT_LIMIT_INVALID");
  }
  for (const item of structuralItems(artifact)) {
    const excerpt = normalizedExcerpt(itemText(item), maxCharacters);
    if (!excerpt) continue;
    return {
      locator: item.locator,
      excerpt,
      excerptHash: fragmentHash(excerpt),
      precision: "STRUCTURAL",
    };
  }

  const excerpt = normalizedExcerpt(fallbackText, maxCharacters);
  if (!excerpt) throw new Error("EVIDENCE_FRAGMENT_TEXT_REQUIRED");
  const locator: StructuralLocator = {
    kind: "source",
    source_hash: artifact.source_hash,
    path: `source:${artifact.source_id}`,
    heading_path: [],
  };
  return {
    locator,
    excerpt,
    excerptHash: fragmentHash(excerpt),
    precision: "SOURCE",
  };
}
