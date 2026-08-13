import { createHash } from "node:crypto";
import {
  DocumentArtifact as DocumentArtifactSchema,
  type DocumentArtifact,
} from "@akp/contracts";

export const DOCUMENT_ARTIFACT_SCHEMA_VERSION = "1.0";

export interface ExpectedDocumentArtifactIdentity {
  sourceId: string;
  sourceHash: string;
  mediaType?: string;
}

export interface CanonicalExtractionResult {
  artifact: DocumentArtifact;
  extractor: string;
  extractorVersion: string;
  configurationHash: string;
  contentHash: string;
  routing: Record<string, unknown>;
  warnings: string[];
}

const SENSITIVE_METADATA_KEY =
  /(?:token|secret|password|private.?key|object.?key|source.?uri|local.?path|absolute.?path|endpoint|host|base.?url)/i;
const ABSOLUTE_HOST_PATH = /^(?:[a-z]:[\\/]|\\\\|\/)/i;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function sanitizeString(value: string, sourceRef: string): string {
  if (/^(?:file:|https?:)/i.test(value) || ABSOLUTE_HOST_PATH.test(value)) {
    return sourceRef;
  }
  // Parser warnings may embed a host-specific path in otherwise useful
  // text (for example, "read C:\\private\\source.pdf"). Keep the message
  // while replacing the sensitive fragment with a stable source reference.
  return value
    .replaceAll(/file:\/\/[^\s"'`]+/gi, sourceRef)
    .replaceAll(/https?:\/\/[^\s"'`]+/gi, sourceRef)
    .replaceAll(/(?:[a-z]:[\\/]|\\\\)[^\s"'`]+/gi, sourceRef);
}

function sanitizeMetadata(
  value: unknown,
  sourceRef: string,
  key = "",
): unknown {
  if (SENSITIVE_METADATA_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") return sanitizeString(value, sourceRef);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeMetadata(entry, sourceRef));
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(
      ([childKey, child]) => [
        childKey,
        sanitizeMetadata(child, sourceRef, childKey),
      ],
    ),
  );
}

function safeLocator(
  value: DocumentArtifact["locators"][number],
  sourceId: string,
  sourceHash: string,
): DocumentArtifact["locators"][number] {
  return {
    kind: value.kind,
    source_hash: sourceHash,
    path: `source:${sourceId}`,
    ...(value.page == null ? {} : { page: value.page }),
    ...(value.slide == null ? {} : { slide: value.slide }),
    ...(value.paragraph == null ? {} : { paragraph: value.paragraph }),
    ...(value.table == null ? {} : { table: value.table }),
    ...(value.row == null ? {} : { row: value.row }),
    ...(value.column == null ? {} : { column: value.column }),
    ...(value.sheet == null ? {} : { sheet: value.sheet }),
    ...(value.index == null ? {} : { index: value.index }),
    ...(value.start_line == null ? {} : { start_line: value.start_line }),
    ...(value.end_line == null ? {} : { end_line: value.end_line }),
    ...(value.start_char == null ? {} : { start_char: value.start_char }),
    ...(value.end_char == null ? {} : { end_char: value.end_char }),
    heading_path: value.heading_path,
    ...(value.region == null ? {} : { region: value.region }),
    ...(value.timestamp_start == null
      ? {}
      : { timestamp_start: value.timestamp_start }),
    ...(value.timestamp_end == null
      ? {}
      : { timestamp_end: value.timestamp_end }),
  };
}

function sanitizeItem(
  item: DocumentArtifact["blocks"][number],
  sourceId: string,
  sourceHash: string,
): DocumentArtifact["blocks"][number] {
  const sourceRef = `source:${sourceId}`;
  return {
    ...(item.id == null ? {} : { id: item.id }),
    kind: item.kind,
    ...(item.text == null ? {} : { text: item.text }),
    locator: safeLocator(item.locator, sourceId, sourceHash),
    ...(item.parent_id == null ? {} : { parent_id: item.parent_id }),
    metadata: asRecord(sanitizeMetadata(item.metadata, sourceRef)),
    ...(item.page == null ? {} : { page: item.page }),
    ...(item.headers == null ? {} : { headers: item.headers }),
    ...(item.rows == null ? {} : { rows: item.rows }),
    ...(item.caption == null
      ? {}
      : { caption: sanitizeString(item.caption, sourceRef) }),
  };
}

export function sanitizeDocumentArtifact(
  artifact: DocumentArtifact,
  sourceId: string,
): DocumentArtifact {
  const mapItems = (
    items: DocumentArtifact["blocks"],
  ): DocumentArtifact["blocks"] =>
    items.map((item) => sanitizeItem(item, sourceId, artifact.source_hash));
  const sourceRef = `source:${sourceId}`;
  return DocumentArtifactSchema.parse({
    source_id: sourceId,
    source_hash: artifact.source_hash,
    media_type: artifact.media_type,
    extractor: artifact.extractor,
    extractor_version: artifact.extractor_version,
    configuration: asRecord(
      sanitizeMetadata(artifact.configuration, sourceRef),
    ),
    pages: mapItems(artifact.pages),
    blocks: mapItems(artifact.blocks),
    headings: mapItems(artifact.headings),
    paragraphs: mapItems(artifact.paragraphs),
    lists: mapItems(artifact.lists),
    tables: mapItems(artifact.tables),
    figures: mapItems(artifact.figures),
    equations: mapItems(artifact.equations),
    code: mapItems(artifact.code),
    bounding_boxes: artifact.bounding_boxes,
    reading_order: artifact.reading_order,
    locators: artifact.locators.map((locator) =>
      safeLocator(locator, sourceId, artifact.source_hash),
    ),
    warnings: artifact.warnings.map((warning) =>
      sanitizeString(warning, sourceRef),
    ),
    quality: artifact.quality,
    quality_metrics: artifact.quality_metrics,
  });
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function documentArtifactConfigurationHash(
  configuration: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(canonicalJson(configuration))
    .digest("hex");
}

export function parseCanonicalExtractionResponse(
  value: unknown,
  expected: ExpectedDocumentArtifactIdentity,
): CanonicalExtractionResult {
  const response = asRecord(value);
  if (!("document_artifact" in response)) {
    throw new Error("EXTRACTOR_DOCUMENT_ARTIFACT_REQUIRED");
  }
  const parsed = DocumentArtifactSchema.safeParse(response.document_artifact);
  if (!parsed.success) {
    throw new Error(
      `EXTRACTOR_DOCUMENT_ARTIFACT_INVALID:${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}:${issue.message}`)
        .join("|")}`,
    );
  }
  if (parsed.data.source_id !== expected.sourceId) {
    throw new Error("EXTRACTOR_SOURCE_ID_MISMATCH");
  }
  if (parsed.data.source_hash !== expected.sourceHash.toLowerCase()) {
    throw new Error("EXTRACTOR_SOURCE_HASH_MISMATCH");
  }
  if (
    expected.mediaType &&
    parsed.data.media_type.toLowerCase() !== expected.mediaType.toLowerCase()
  ) {
    throw new Error("EXTRACTOR_MEDIA_TYPE_MISMATCH");
  }
  const outerExtractor = String(response.extractor ?? "");
  const outerVersion = String(response.extractor_version ?? "");
  if (
    outerExtractor !== parsed.data.extractor ||
    outerVersion !== parsed.data.extractor_version
  ) {
    throw new Error("EXTRACTOR_IDENTITY_MISMATCH");
  }
  const artifact = sanitizeDocumentArtifact(parsed.data, expected.sourceId);
  const serialized = canonicalJson(artifact);
  return {
    artifact,
    extractor: artifact.extractor,
    extractorVersion: artifact.extractor_version,
    configurationHash: documentArtifactConfigurationHash(
      artifact.configuration,
    ),
    contentHash: createHash("sha256").update(serialized).digest("hex"),
    routing: asRecord(
      sanitizeMetadata(response.routing, `source:${expected.sourceId}`),
    ),
    warnings: Array.isArray(response.warnings)
      ? response.warnings
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) => sanitizeString(entry, `source:${expected.sourceId}`))
      : [],
  };
}

function artifactItems(artifact: DocumentArtifact): DocumentArtifact["blocks"] {
  const candidates = artifact.blocks.length
    ? artifact.blocks
    : [
        ...artifact.headings,
        ...artifact.paragraphs,
        ...artifact.lists,
        ...artifact.tables,
        ...artifact.figures,
        ...artifact.equations,
        ...artifact.code,
      ];
  const byId = new Map(
    candidates
      .filter((item) => item.id)
      .map((item) => [String(item.id), item] as const),
  );
  const ordered = artifact.reading_order
    .map((id) => byId.get(id))
    .filter((item): item is DocumentArtifact["blocks"][number] =>
      Boolean(item),
    );
  const seen = new Set(ordered.map((item) => item.id).filter(Boolean));
  return [
    ...ordered,
    ...candidates.filter((item) => !item.id || !seen.has(item.id)),
  ];
}

function escapeTableCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll(/\r?\n/g, " ").trim();
}

function locatorComment(locator: DocumentArtifact["locators"][number]): string {
  const fields = [
    locator.page == null ? null : `page=${locator.page}`,
    locator.slide == null ? null : `slide=${locator.slide}`,
    locator.sheet == null ? null : `sheet=${locator.sheet}`,
    locator.row == null ? null : `row=${locator.row}`,
    locator.start_line == null ? null : `line=${locator.start_line}`,
    locator.heading_path.length
      ? `heading=${locator.heading_path.join(" / ")}`
      : null,
  ].filter((entry): entry is string => Boolean(entry));
  return fields.length ? `<!-- akp-locator: ${fields.join("; ")} -->\n` : "";
}

function renderItem(item: DocumentArtifact["blocks"][number]): string {
  const text = item.text?.trim() ?? "";
  const locator = locatorComment(item.locator);
  if (item.kind === "heading") {
    const rawLevel = Number(item.metadata.level ?? 2);
    const level = Math.min(6, Math.max(2, rawLevel + 1));
    return text ? `${locator}${"#".repeat(level)} ${text}` : "";
  }
  if (item.kind === "list" || item.kind === "list-item") {
    return text ? `${locator}- ${text}` : "";
  }
  if (item.kind === "table" && item.headers?.length) {
    const headers = item.headers.map(escapeTableCell);
    const rows = (item.rows ?? []).map(
      (row) => `| ${row.map(escapeTableCell).join(" | ")} |`,
    );
    return `${locator}| ${headers.join(" | ")} |\n| ${headers
      .map(() => "---")
      .join(" | ")} |${rows.length ? `\n${rows.join("\n")}` : ""}`;
  }
  if (item.kind === "code") {
    const language = String(item.metadata.language ?? "")
      .replaceAll(/[^a-zA-Z0-9_+#.-]/g, "")
      .slice(0, 32);
    return text ? `${locator}\`\`\`${language}\n${text}\n\`\`\`` : "";
  }
  if (item.kind === "equation") {
    return text ? `${locator}$$\n${text}\n$$` : "";
  }
  if (item.kind === "figure") {
    return `${locator}> Figure${text ? `: ${text}` : " (no caption extracted)"}`;
  }
  return text ? `${locator}${text}` : "";
}

export function renderDocumentArtifactPreview(
  artifact: DocumentArtifact,
  maximumCharacters = 12_000,
): { markdown: string; truncated: boolean } {
  if (!Number.isInteger(maximumCharacters) || maximumCharacters < 1_000) {
    throw new Error("DOCUMENT_ARTIFACT_PREVIEW_LIMIT_INVALID");
  }
  const rendered = artifactItems(artifact)
    .map(renderItem)
    .filter(Boolean)
    .join("\n\n");
  if (rendered.length <= maximumCharacters) {
    return { markdown: rendered, truncated: false };
  }
  return {
    markdown: `${rendered.slice(0, maximumCharacters).trimEnd()}\n\n> Preview truncated; the canonical DocumentArtifact remains available by source artifact ID.`,
    truncated: true,
  };
}

export interface DocumentArtifactDraftInput {
  externalId: string;
  title: string;
  sourceId: string;
  sourceArtifactId: string;
  sha256: string;
  mediaType: string;
  extractor: string;
  extractorVersion: string;
  artifact: DocumentArtifact;
}

/**
 * Render an inspectable machine draft from the canonical artifact.  The
 * draft intentionally exposes only a stable source reference; host paths,
 * object keys and source URIs remain outside the compiled knowledge tree.
 */
export function renderDocumentArtifactDraft(
  input: DocumentArtifactDraftInput,
): string {
  const preview = renderDocumentArtifactPreview(input.artifact, 6_000);
  const yamlString = (value: string): string =>
    `'${value.replaceAll("'", "''")}'`;
  return `---
id: ${input.externalId}
type: source-summary
title: ${yamlString(input.title)}
status: draft
knowledge_layer: source
trust_tier: machine-supported
source_id: ${input.sourceId}
source_artifact_id: ${input.sourceArtifactId}
source_ref: ${yamlString(`source:${input.sourceId}`)}
source_sha256: ${input.sha256}
media_type: ${input.mediaType}
extractor: ${yamlString(input.extractor)}
extractor_version: ${yamlString(input.extractorVersion)}
document_artifact_schema_version: ${yamlString(DOCUMENT_ARTIFACT_SCHEMA_VERSION)}
---

# ${input.title}

## Provenance

- Immutable raw object SHA-256: \`${input.sha256}\`
- Stable source reference: \`source:${input.sourceId}\`
- Canonical source artifact ID: \`${input.sourceArtifactId}\`
- Extraction status: machine-generated; human review required

## Machine extract

${preview.markdown.trim() || "_No textual material was extracted._"}

## Uncertainty

This draft preserves extracted material and provenance. It does not promote the text to a verified claim or architectural rule.
`;
}
