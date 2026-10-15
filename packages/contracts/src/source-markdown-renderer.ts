import type { DocumentArtifact } from "./index.js";

export const SOURCE_MARKDOWN_RENDERER_VERSION = "1.0";

/** One deterministic source renderer shared by ingest and authorized source reads. */
function artifactItems(artifact: DocumentArtifact): DocumentArtifact["blocks"] {
  const specialized = [
    ...artifact.headings,
    ...artifact.paragraphs,
    ...artifact.lists,
    ...artifact.tables,
    ...artifact.figures,
    ...artifact.equations,
    ...artifact.code,
  ];
  const specializedById = new Map(
    specialized
      .filter((item) => item.id)
      .map((item) => [String(item.id), item] as const),
  );
  const candidates = artifact.blocks.length
    ? artifact.blocks.map((item) =>
        item.id ? (specializedById.get(String(item.id)) ?? item) : item,
      )
    : specialized;
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
    locator.table == null ? null : `table=${locator.table}`,
    locator.row == null ? null : `row=${locator.row}`,
    locator.column == null ? null : `column=${locator.column}`,
    locator.start_line == null ? null : `line=${locator.start_line}`,
    locator.heading_path.length
      ? `heading=${locator.heading_path.join(" / ")}`
      : null,
  ].filter((entry): entry is string => Boolean(entry));
  return fields.length ? `<!-- akp-locator: ${fields.join("; ")} -->\n` : "";
}

function renderedCaption(
  item: DocumentArtifact["blocks"][number],
  locator: string,
): string {
  const caption = item.caption ?? "";
  return caption.trim() ? `${locator}${caption}` : "";
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
  if (item.kind === "table") {
    const caption = renderedCaption(item, locator);
    const sourceHeaders = item.headers ?? [];
    const sourceRows = item.rows ?? [];
    const width = sourceRows.reduce(
      (maximum, row) => Math.max(maximum, row.length),
      sourceHeaders.length,
    );
    if (width > 0) {
      // A missing header is not evidence that the first data row is a header.
      // Neutral positional labels retain every cell without inventing semantics.
      const headers = Array.from({ length: width }, (_, column) =>
        escapeTableCell(sourceHeaders[column] || `Column ${column + 1}`),
      );
      const rows = sourceRows.map(
        (row) =>
          `| ${Array.from({ length: width }, (_, column) => escapeTableCell(row[column] ?? "")).join(" | ")} |`,
      );
      const table = `${locator}| ${headers.join(" | ")} |\n| ${headers.map(() => "---").join(" | ")} |${rows.length ? `\n${rows.join("\n")}` : ""}`;
      return caption ? `${caption}\n\n${table}` : table;
    }
    const fallbackText = text ? `${locator}${text}` : "";
    if (caption && text && (item.caption ?? "").trim() !== text) {
      return `${caption}\n\n${fallbackText}`;
    }
    return caption || fallbackText;
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
    const caption = item.caption ?? "";
    const captionText = caption.trim();
    if (captionText && (!text || captionText === text)) {
      return `${locator}> Figure: ${caption}`;
    }
    if (captionText) {
      const figure = `${locator}> Figure${text ? `: ${text}` : " (no caption extracted)"}`;
      return `${renderedCaption(item, locator)}\n\n${figure}`;
    }
    return `${locator}> Figure${text ? `: ${text}` : " (no caption extracted)"}`;
  }
  return text ? `${locator}${text}` : "";
}

/** Complete extraction material; presentation limits must never define indexed content. */
export function renderSourceArtifactMarkdown(
  artifact: DocumentArtifact,
): string {
  return artifactItems(artifact).map(renderItem).filter(Boolean).join("\n\n");
}
