import { parseKnowledgeUnits, type ParsedKnowledgeUnit } from "./chunking.js";
import { markdownTableEvidence } from "./markdown-table-evidence.js";

export interface TableProjectionSourceSpan {
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface TableCellProjection {
  /** One-based column index from the structural Markdown table. */
  readonly columnIndex: number;
  /** Exact parsed header text when present. */
  readonly header: string | null;
  /** NFKC/whitespace-normalized header for deterministic matching. */
  readonly normalizedHeader: string | null;
  /** Exact visible cell bytes represented by the atomic TABLE_CELL unit. */
  readonly rawValue: string;
  /** NFKC/whitespace-normalized value. This is not a semantic rewrite. */
  readonly normalizedValue: string;
  /** Exact UTF-16 offsets into the original source body. */
  readonly sourceSpan: TableProjectionSourceSpan;
}

export interface TableRowProjection {
  readonly kind: "TABLE_ROW";
  readonly derivation: "DETERMINISTIC_PARSED";
  /** Canonical parsed unit key used to persist this projection without locator heuristics. */
  readonly unitKey: string;
  /** Stable within one exact source-body revision. */
  readonly tableId: string;
  readonly tableIndex: number;
  readonly rowIndex: number;
  readonly title: string;
  readonly headingPath: readonly string[];
  readonly caption?: string;
  readonly cells: readonly TableCellProjection[];
  /** Exact UTF-16 offsets for the original row in the source body. */
  readonly sourceSpan: TableProjectionSourceSpan;
  readonly sourceBodyHash: string;
  readonly lexicalText: string;
  readonly embeddingText: string;
}

function normalizedProjectionValue(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function samePortableScope(
  left: ParsedKnowledgeUnit,
  right: ParsedKnowledgeUnit,
): boolean {
  const keys = ["page", "slide", "sheet"] as const;
  return keys.every((key) => {
    const leftValue = left.locator[key];
    const rightValue = right.locator[key];
    return (
      leftValue === undefined ||
      rightValue === undefined ||
      leftValue === rightValue
    );
  });
}

function captionForTable(
  units: readonly ParsedKnowledgeUnit[],
  table: ParsedKnowledgeUnit,
): string | undefined {
  const tableIndex = table.locator.table;
  if (tableIndex === undefined) return undefined;
  return units
    .filter(
      (unit) =>
        unit.unitType === "PARAGRAPH" &&
        !unit.containerOnly &&
        unit.locator.table === tableIndex &&
        unit.locator.row === undefined &&
        unit.locator.column === undefined &&
        unit.structuralOrder < table.structuralOrder &&
        unit.locator.endLine <= table.locator.startLine &&
        samePortableScope(unit, table),
    )
    .sort((left, right) => right.structuralOrder - left.structuralOrder)[0]
    ?.body;
}

function rowText(
  title: string,
  headingPath: readonly string[],
  caption: string | undefined,
  cells: readonly TableCellProjection[],
): { lexicalText: string; embeddingText: string } {
  const facts = cells.map((cell) =>
    cell.header
      ? `${cell.header} = ${cell.rawValue}`
      : `Column ${cell.columnIndex} = ${cell.rawValue}`,
  );
  const lexicalText = [title, headingPath.join(" > "), caption ?? "", ...facts]
    .filter((value) => value.trim().length > 0)
    .join("\n");
  const embeddingText = [
    `Document: ${title}`,
    ...(headingPath.length > 0 ? [`Section: ${headingPath.join(" > ")}`] : []),
    ...(caption?.trim() ? [`Caption: ${caption}`] : []),
    "Table row:",
    ...facts,
  ].join("\n");
  return { lexicalText, embeddingText };
}

/**
 * Builds source-bound table-row projections from the same structural units
 * used by retrieval. The projection never changes canonical unit bodies,
 * invents headers, or infers query semantics.
 *
 * Captions are attached only when ingestion supplied the same explicit table
 * locator. Native Markdown prose that merely precedes a table is not guessed
 * to be its caption.
 */
export function projectTableRows(
  title: string,
  sourceBody: string,
): TableRowProjection[] {
  const units = parseKnowledgeUnits(title, sourceBody);
  const byKey = new Map(units.map((unit) => [unit.unitKey, unit] as const));
  const children = new Map<string, ParsedKnowledgeUnit[]>();
  for (const unit of units) {
    if (!unit.parentUnitKey) continue;
    children.set(unit.parentUnitKey, [
      ...(children.get(unit.parentUnitKey) ?? []),
      unit,
    ]);
  }

  return units.flatMap((row): TableRowProjection[] => {
    if (row.unitType !== "TABLE_ROW" || !row.parentUnitKey) return [];
    const table = byKey.get(row.parentUnitKey);
    if (!table || table.unitType !== "TABLE") return [];
    const tableIndex = row.locator.table;
    const rowIndex = row.locator.row;
    if (tableIndex === undefined || rowIndex === undefined) return [];

    const parsedTable = markdownTableEvidence(table.body)[0];
    if (!parsedTable) return [];
    const headerByColumn = new Map(
      parsedTable.header.cells.map((cell) => [
        cell.columnIndex + 1,
        cell.source.trim(),
      ]),
    );
    const cells = (children.get(row.unitKey) ?? [])
      .filter(
        (unit) =>
          unit.unitType === "TABLE_CELL" &&
          unit.locator.column !== undefined &&
          unit.locator.startChar >= row.locator.startChar &&
          unit.locator.endChar <= row.locator.endChar,
      )
      .sort(
        (left, right) =>
          (left.locator.column ?? 0) - (right.locator.column ?? 0),
      )
      .map((unit): TableCellProjection => {
        const columnIndex = unit.locator.column!;
        const header = headerByColumn.get(columnIndex) || null;
        return {
          columnIndex,
          header,
          normalizedHeader:
            header === null ? null : normalizedProjectionValue(header),
          rawValue: unit.body,
          normalizedValue: normalizedProjectionValue(unit.body),
          sourceSpan: {
            startOffset: unit.locator.startChar,
            endOffset: unit.locator.endChar,
          },
        };
      });
    if (cells.length === 0) return [];

    const caption = captionForTable(units, table);
    const text = rowText(title, table.headingPath, caption, cells);
    return [
      {
        kind: "TABLE_ROW",
        derivation: "DETERMINISTIC_PARSED",
        unitKey: row.unitKey,
        tableId: `${row.locator.sourceBodyHash}:table:${tableIndex}`,
        tableIndex,
        rowIndex,
        title,
        headingPath: [...table.headingPath],
        ...(caption ? { caption } : {}),
        cells,
        sourceSpan: {
          startOffset: row.locator.startChar,
          endOffset: row.locator.endChar,
        },
        sourceBodyHash: row.locator.sourceBodyHash,
        ...text,
      },
    ];
  });
}
