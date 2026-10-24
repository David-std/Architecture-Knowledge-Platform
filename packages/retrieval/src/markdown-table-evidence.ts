import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";

export interface MarkdownSourceSpan {
  readonly startOffset: number;
  readonly endOffset: number;
}

export interface MarkdownTableCell {
  readonly columnIndex: number;
  readonly source: string;
  readonly span: MarkdownSourceSpan;
}

export interface MarkdownTableRow {
  readonly source: string;
  readonly span: MarkdownSourceSpan;
  readonly cells: readonly MarkdownTableCell[];
}

export interface MarkdownTableEvidence {
  readonly startLine: number;
  readonly endLine: number;
  readonly span: MarkdownSourceSpan;
  readonly header: MarkdownTableRow;
  /** Header plus the original alignment/delimiter line. */
  readonly headerSpan: MarkdownSourceSpan;
  readonly rows: readonly MarkdownTableRow[];
}

export interface MarkdownTableProjection {
  readonly text: string;
  /** Original UTF-16 spans; copied rows are never relabelled as contiguous. */
  readonly sourceSpans: readonly MarkdownSourceSpan[];
  readonly omittedRows: number;
}

type TableNode = Extract<
  ReturnType<typeof fromMarkdown>["children"][number],
  { type: "table" }
>;
type TableRowNode = TableNode["children"][number];

function spanFor(
  position: TableRowNode["position"],
  size: number,
): MarkdownSourceSpan | null {
  const start = position?.start.offset;
  const end = position?.end.offset;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start === undefined ||
    end === undefined ||
    start < 0 ||
    end <= start ||
    end > size
  )
    return null;
  return { startOffset: start, endOffset: end };
}

function sourceRow(
  passage: string,
  row: TableRowNode,
): MarkdownTableRow | null {
  const span = spanFor(row.position, passage.length);
  if (!span) return null;
  const cells = row.children.flatMap((cell, columnIndex) => {
    const outerSpan = spanFor(cell.position, passage.length);
    const first = cell.children[0]?.position;
    const last = cell.children.at(-1)?.position;
    const cellSpan =
      first && last
        ? spanFor({ start: first.start, end: last.end }, passage.length)
        : outerSpan && {
            startOffset: outerSpan.startOffset,
            endOffset: outerSpan.startOffset,
          };
    return cellSpan
      ? [
          {
            columnIndex,
            source: passage.slice(cellSpan.startOffset, cellSpan.endOffset),
            span: cellSpan,
          },
        ]
      : [];
  });
  return {
    source: passage.slice(span.startOffset, span.endOffset),
    span,
    cells,
  };
}

/**
 * Parse top-level GFM tables with the same parser used by remark. Fenced code,
 * escaped pipes, alignment syntax and optional border pipes follow that
 * grammar; no header vocabulary is used to infer what a table asserts.
 */
export function markdownTableEvidence(
  passage: string,
): MarkdownTableEvidence[] {
  if (!passage.includes("|")) return [];
  const tree = fromMarkdown(passage, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  });
  return tree.children.flatMap((node) => {
    if (node.type !== "table") return [];
    const span = spanFor(node.position, passage.length);
    const header = node.children[0] && sourceRow(passage, node.children[0]);
    if (!span || !header) return [];
    const rows = node.children.slice(1).flatMap((row) => {
      const value = sourceRow(passage, row);
      return value ? [value] : [];
    });
    return [
      {
        span,
        startLine: node.position!.start.line,
        endLine: node.position!.end.line,
        header,
        headerSpan: {
          startOffset: span.startOffset,
          endOffset: rows[0]?.span.startOffset ?? span.endOffset,
        },
        rows,
      },
    ];
  });
}

/**
 * Copy the original header and complete adjacent rows around a selected row.
 * Omission markers sit outside the table. No partial cell, synthetic row,
 * reordered column or invented proposition can enter the projection.
 */
export function projectMarkdownTable(
  passage: string,
  table: MarkdownTableEvidence,
  preferredRow: number,
  maxChars: number,
): MarkdownTableProjection {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1) {
    throw new Error("MARKDOWN_TABLE_PROJECTION_BUDGET_INVALID");
  }
  const complete = passage.slice(table.span.startOffset, table.span.endOffset);
  if (complete.length <= maxChars) {
    return { text: complete, sourceSpans: [table.span], omittedRows: 0 };
  }
  const header = passage
    .slice(table.headerSpan.startOffset, table.headerSpan.endOffset)
    .trimEnd();
  const preferred = Number.isSafeInteger(preferredRow)
    ? Math.max(0, Math.min(preferredRow, table.rows.length - 1))
    : 0;
  const project = (first: number, last: number): MarkdownTableProjection => {
    const rows = table.rows.slice(first, last + 1);
    const rowStart = rows[0]?.span.startOffset;
    const rowEnd = rows.at(-1)?.span.endOffset;
    const prefix = first > 0 ? "…\n\n" : "";
    const suffix = last < table.rows.length - 1 ? "\n\n…" : "";
    const body =
      rowStart === undefined || rowEnd === undefined
        ? ""
        : passage.slice(rowStart, rowEnd);
    return {
      text: `${prefix}${header}\n${body}${suffix}`,
      sourceSpans: [
        table.headerSpan,
        ...(rowStart === undefined || rowEnd === undefined
          ? []
          : [{ startOffset: rowStart, endOffset: rowEnd }]),
      ],
      omittedRows: table.rows.length - rows.length,
    };
  };
  let first = preferred;
  let last = preferred;
  let result = project(first, last);
  if (table.rows.length === 0 || result.text.length > maxChars) {
    return { text: "…", sourceSpans: [], omittedRows: table.rows.length };
  }
  while (first > 0 || last < table.rows.length - 1) {
    let changed = false;
    if (first > 0) {
      const next = project(first - 1, last);
      if (next.text.length <= maxChars) {
        first -= 1;
        result = next;
        changed = true;
      }
    }
    if (last < table.rows.length - 1) {
      const next = project(first, last + 1);
      if (next.text.length <= maxChars) {
        last += 1;
        result = next;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return result;
}
