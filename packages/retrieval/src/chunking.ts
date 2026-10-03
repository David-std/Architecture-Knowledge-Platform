import { createHash } from "node:crypto";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmTableFromMarkdown } from "mdast-util-gfm-table";
import { gfmTable } from "micromark-extension-gfm-table";
import { markdownTableEvidence } from "./markdown-table-evidence.js";
import { markdownVisibleSource } from "./markdown-visible-source.js";

export const MAX_EMBEDDING_UNIT_CHARACTERS = 1_200;

export type KnowledgeUnitType =
  | "DOCUMENT"
  | "SECTION"
  | "PARAGRAPH"
  | "LIST"
  | "TABLE"
  | "TABLE_ROW"
  | "TABLE_CELL"
  | "FIGURE"
  | "EQUATION"
  | "PRECONDITION"
  | "RULE"
  | "WORKFLOW_STEP"
  | "EXAMPLE"
  | "COUNTEREXAMPLE"
  | "EVIDENCE"
  | "SOURCE_EXCERPT"
  | "CODE_EVIDENCE";

export interface ParsedKnowledgeUnit {
  unitKey: string;
  parentUnitKey: string | null;
  unitType: KnowledgeUnitType;
  headingPath: string[];
  body: string;
  contentHash: string;
  tokenEstimate: number;
  structuralOrder: number;
  locator: {
    kind: "markdown";
    startLine: number;
    endLine: number;
    contentHash: string;
    /** Source comment positions are provenance hints, never assertions. */
    sourceCommentSpans?: ReadonlyArray<{ startLine: number; endLine: number }>;
    /** Portable source coordinates inherited from an akp-locator provenance hint. */
    page?: number;
    slide?: number;
    sheet?: string;
    /** One-based structural table coordinates when this unit comes from a table. */
    table?: number;
    row?: number;
    column?: number;
    fragment?: number;
  };
  containerOnly: boolean;
  embeddingEligible: boolean;
}

interface Block {
  startLine: number;
  endLine: number;
  body: string;
  structuralType:
    "PARAGRAPH" | "LIST" | "TABLE" | "FIGURE" | "EQUATION" | "CODE";
}

interface MarkdownPosition {
  start: { line: number; offset?: number | undefined };
  end: { line: number; offset?: number | undefined };
}

interface MarkdownNode {
  type: string;
  depth?: number | undefined;
  value?: string | undefined;
  alt?: string | null | undefined;
  children?: readonly MarkdownNode[] | undefined;
  position?: MarkdownPosition | undefined;
}

interface MarkdownRoot {
  children: readonly MarkdownNode[];
}

interface HeadingEntry {
  depth: number;
  label: string;
}

function markdownTree(source: string): MarkdownRoot {
  return fromMarkdown(source, {
    extensions: [gfmTable()],
    mdastExtensions: [gfmTableFromMarkdown()],
  }) as unknown as MarkdownRoot;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function semanticType(
  headingPath: readonly string[],
  body: string,
  fallback: KnowledgeUnitType,
): KnowledgeUnitType {
  const value = `${headingPath.join(" ")} ${body.slice(0, 240)}`.toLowerCase();
  if (
    /\b(?:counterexample|contraejemplo|anti-pattern|antipatr[oó]n)\b/.test(
      value,
    )
  )
    return "COUNTEREXAMPLE";
  if (/\b(?:precondition|precondici[oó]n|given|dado que)\b/.test(value))
    return "PRECONDITION";
  if (/\b(?:example|ejemplo)\b/.test(value)) return "EXAMPLE";
  if (
    /\b(?:evidence|evidencia|locator|localizador|citation|cita)\b/.test(value)
  )
    return "EVIDENCE";
  if (/\b(?:source excerpt|extracto de fuente|verbatim)\b/.test(value))
    return "SOURCE_EXCERPT";
  if (/\b(?:rule|regla|must|must not|debe|no debe)\b/.test(value))
    return "RULE";
  if (/\b(?:step|paso|workflow|flujo|then|cuando)\b/.test(value))
    return "WORKFLOW_STEP";
  return fallback;
}

function markdownBlocks(lines: readonly string[], offset: number): Block[] {
  const blocks: Block[] = [];

  const source = lines.join("\n");
  const tree = markdownTree(source);
  const tableBounds = new Map(
    markdownTableEvidence(source).map((table) => [
      table.startLine - 1,
      table.endLine - 1,
    ]),
  );
  const codeBounds = new Map<number, number>();
  for (const node of tree.children) {
    const position = node.position;
    if (node.type !== "code" || !position) continue;
    codeBounds.set(position.start.line - 1, position.end.line - 1);
  }
  let index = 0;
  const push = (
    start: number,
    end: number,
    structuralType: Block["structuralType"],
  ): void => {
    const body = lines
      .slice(start, end + 1)
      .join("\n")
      .trim();
    if (!body) return;
    blocks.push({
      startLine: offset + start,
      endLine: offset + end,
      body,
      structuralType,
    });
  };

  while (index < lines.length) {
    if (!lines[index]?.trim()) {
      index += 1;
      continue;
    }
    const start = index;
    const codeEnd = codeBounds.get(index);
    if (codeEnd !== undefined) {
      push(start, codeEnd, "CODE");
      index = codeEnd + 1;
      continue;
    }
    const line = lines[index] ?? "";
    if (/^\s*\$\$/.test(line)) {
      index += 1;
      while (index < lines.length && !/^\s*\$\$\s*$/.test(lines[index] ?? ""))
        index += 1;
      if (index < lines.length) index += 1;
      push(start, index - 1, "EQUATION");
      continue;
    }
    if (/^\s*!\[[^\]]*\]\([^)]*\)/.test(line)) {
      push(start, start, "FIGURE");
      index += 1;
      continue;
    }
    const tableEnd = tableBounds.get(index);
    if (tableEnd !== undefined) {
      index = tableEnd + 1;
      push(start, tableEnd, "TABLE");
      continue;
    }
    if (/^\s*(?:[-*+] |\d+[.)] )/.test(line)) {
      index += 1;
      while (
        index < lines.length &&
        (/^\s*(?:[-*+] |\d+[.)] )/.test(lines[index] ?? "") ||
          /^\s{2,}\S/.test(lines[index] ?? ""))
      )
        index += 1;
      push(start, index - 1, "LIST");
      continue;
    }
    index += 1;
    while (
      index < lines.length &&
      Boolean(lines[index]?.trim()) &&
      !codeBounds.has(index) &&
      !tableBounds.has(index) &&
      !/^\s*\$\$|^\s*!\[|^\s*(?:[-*+] |\d+[.)] )/.test(lines[index] ?? "")
    )
      index += 1;
    push(start, index - 1, "PARAGRAPH");
  }
  return blocks;
}

function headingLabel(node: MarkdownNode): string {
  const text = (child: MarkdownNode): string => {
    if (child.type === "text" || child.type === "inlineCode")
      return child.value ?? "";
    if (child.type === "break") return "\n";
    if (child.type === "html") return "";
    if (child.type === "image") return child.alt ?? "";
    return child.children?.map(text).join("") ?? "";
  };
  return node.children?.map(text).join("").trim() ?? "";
}

function atomicType(
  block: Block,
  headingPath: readonly string[],
): KnowledgeUnitType {
  const structural: KnowledgeUnitType =
    block.structuralType === "CODE" ? "CODE_EVIDENCE" : block.structuralType;
  return ["PARAGRAPH", "LIST"].includes(structural)
    ? semanticType(headingPath, block.body, structural)
    : structural;
}

interface StructuredLocatorHint {
  page?: number;
  slide?: number;
  sheet?: string;
  table?: number;
  row?: number;
  column?: number;
}

function lineOffsetAt(source: string, offset: number): number {
  let lines = 0;
  const bounded = Math.max(0, Math.min(offset, source.length));
  for (let index = 0; index < bounded; index++) {
    if (source.charCodeAt(index) === 10) lines += 1;
  }
  return lines;
}

function parseAkpLocatorHint(comment: string): StructuredLocatorHint | null {
  const match = /^<!--\s*akp-locator:\s*([\s\S]*?)\s*-->$/u.exec(comment);
  if (!match) return null;
  const fields = new Map(
    (match[1] ?? "")
      .split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .flatMap((entry) => {
        const separator = entry.indexOf("=");
        if (separator <= 0) return [];
        return [
          [
            entry.slice(0, separator).trim().toLowerCase(),
            entry.slice(separator + 1).trim(),
          ] as const,
        ];
      }),
  );
  const positiveInteger = (key: string): number | undefined => {
    const raw = fields.get(key);
    if (!raw || !/^\d+$/u.test(raw)) return undefined;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  };
  const sheet = fields.get("sheet");
  return {
    ...(positiveInteger("page") === undefined
      ? {}
      : { page: positiveInteger("page")! }),
    ...(positiveInteger("slide") === undefined
      ? {}
      : { slide: positiveInteger("slide")! }),
    ...(sheet && sheet.length <= 256 ? { sheet } : {}),
    ...(positiveInteger("table") === undefined
      ? {}
      : { table: positiveInteger("table")! }),
    ...(positiveInteger("row") === undefined
      ? {}
      : { row: positiveInteger("row")! }),
    ...(positiveInteger("column") === undefined
      ? {}
      : { column: positiveInteger("column")! }),
  };
}

function inheritedLocatorCoordinates(
  hint: StructuredLocatorHint | undefined,
): StructuredLocatorHint {
  if (!hint) return {};
  return {
    ...(hint.page === undefined ? {} : { page: hint.page }),
    ...(hint.slide === undefined ? {} : { slide: hint.slide }),
    ...(hint.sheet === undefined ? {} : { sheet: hint.sheet }),
    ...(hint.table === undefined ? {} : { table: hint.table }),
  };
}

interface EmbeddingFragment {
  body: string;
  startOffset: number;
  endOffset: number;
}

function safeSplitBoundary(text: string, index: number): number {
  if (index <= 0 || index >= text.length) return index;
  const previous = text.charCodeAt(index - 1);
  const current = text.charCodeAt(index);
  return previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
    ? index - 1
    : index;
}

function splitEmbeddingBody(
  body: string,
  maxCharacters = MAX_EMBEDDING_UNIT_CHARACTERS,
): EmbeddingFragment[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 128) {
    throw new Error("EMBEDDING_UNIT_CHARACTER_BUDGET_INVALID");
  }
  if (body.length <= maxCharacters) {
    return [{ body, startOffset: 0, endOffset: body.length }];
  }

  const fragments: EmbeddingFragment[] = [];
  let start = 0;
  while (start < body.length) {
    while (start < body.length && /\s/u.test(body[start]!)) start += 1;
    if (start >= body.length) break;

    let hardEnd = safeSplitBoundary(
      body,
      Math.min(body.length, start + maxCharacters),
    );
    let end = hardEnd;
    if (hardEnd < body.length) {
      const minimumBoundary = Math.min(
        hardEnd,
        start + Math.floor(maxCharacters * 0.6),
      );
      const window = body.slice(minimumBoundary, hardEnd);
      let preferred = -1;
      for (const match of window.matchAll(/(?:\n|[.!?;:]\s)/gu)) {
        preferred = match.index + match[0].length;
      }
      if (preferred > 0) {
        end = safeSplitBoundary(body, minimumBoundary + preferred);
      }
    }

    let trimmedEnd = end;
    while (trimmedEnd > start && /\s/u.test(body[trimmedEnd - 1]!)) {
      trimmedEnd -= 1;
    }
    if (trimmedEnd <= start) {
      trimmedEnd = hardEnd;
    }
    fragments.push({
      body: body.slice(start, trimmedEnd),
      startOffset: start,
      endOffset: trimmedEnd,
    });
    start = Math.max(end, trimmedEnd);
  }
  return fragments;
}

function hasIndependentText(body: string): boolean {
  const text = body.replace(/\[\[[^\]]*\]\]/gu, "");
  const tree = fromMarkdown(text);
  type Node = {
    type: string;
    value?: string | undefined;
    children?: readonly Node[];
  };
  const collect = (node: Node): string => {
    if (["link", "image", "html"].includes(node.type)) return "";
    return (
      (node.type === "text" || node.type === "inlineCode"
        ? (node.value ?? "")
        : "") + (node.children?.map(collect).join(" ") ?? "")
    );
  };
  return /[\p{L}\p{N}]/u.test(collect(tree));
}

/**
 * Parses Markdown into a document container, section containers and atomic
 * structural children. Containers are retained for parent rehydration but are
 * deliberately ineligible for vector embedding.
 */
export function parseKnowledgeUnits(
  title: string,
  body: string,
): ParsedKnowledgeUnit[] {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const documentHash = hash(normalized);
  const units: ParsedKnowledgeUnit[] = [
    {
      unitKey: "document",
      parentUnitKey: null,
      unitType: "DOCUMENT",
      headingPath: [title],
      body: normalized,
      contentHash: documentHash,
      tokenEstimate: Math.ceil(normalized.length / 4),
      structuralOrder: 0,
      locator: {
        kind: "markdown",
        startLine: 1,
        endLine: Math.max(normalized.split("\n").length, 1),
        contentHash: documentHash,
      },
      containerOnly: true,
      embeddingEligible: false,
    },
  ];
  const clean = markdownVisibleSource(normalized);
  const lines = normalized ? clean.text.split("\n") : [];
  const nextContentLine = new Array<number>(lines.length + 1).fill(
    lines.length + 1,
  );
  for (let index = lines.length - 1; index >= 0; index--) {
    nextContentLine[index] = lines[index]!.trim()
      ? index + 1
      : nextContentLine[index + 1]!;
  }
  const commentsByContentLine = new Map<
    number,
    Array<{ startLine: number; endLine: number }>
  >();
  const locatorHintsByContentLine = new Map<number, StructuredLocatorHint>();
  for (const comment of clean.comments) {
    const { startLine, endLine } = comment;
    const target = nextContentLine[endLine] ?? lines.length + 1;
    const existing = commentsByContentLine.get(target) ?? [];
    existing.push({ startLine, endLine });
    commentsByContentLine.set(target, existing);
    const hint = parseAkpLocatorHint(
      normalized.slice(comment.startOffset, comment.endOffset),
    );
    if (hint) locatorHintsByContentLine.set(target, hint);
  }
  const tree = markdownTree(clean.text);
  const headingNodes = tree.children.filter(
    (node) => node.type === "heading" && node.position,
  );
  const headings: HeadingEntry[] = [];
  let sectionStart = 0;
  let sectionIndex = 0;
  let tableIndex = 0;
  let order = 1;

  const flushSection = (endExclusive: number): void => {
    const sectionLines = lines.slice(sectionStart, endExclusive);
    const firstContent = sectionLines.findIndex(
      (line) => line.trim().length > 0,
    );
    if (firstContent < 0) return;
    const sectionBody = sectionLines.join("\n").trim();
    const hasHeading = headings.length > 0;
    const path = hasHeading ? headings.map(({ label }) => label) : [title];
    const blocks = markdownBlocks(sectionLines, sectionStart + 1);
    const keepSectionContainer = hasHeading && blocks.length > 1;
    const sectionKey = keepSectionContainer
      ? `section-${++sectionIndex}`
      : "document";
    if (keepSectionContainer) {
      const sectionHash = hash(sectionBody);
      units.push({
        unitKey: sectionKey,
        parentUnitKey: "document",
        unitType: "SECTION",
        headingPath: [...path],
        body: sectionBody,
        contentHash: sectionHash,
        tokenEstimate: Math.ceil(sectionBody.length / 4),
        structuralOrder: order++,
        locator: {
          kind: "markdown",
          startLine: sectionStart + firstContent + 1,
          endLine: Math.max(endExclusive, sectionStart + firstContent + 1),
          contentHash: sectionHash,
        },
        containerOnly: true,
        embeddingEligible: false,
      });
    }
    for (const block of blocks) {
      const contentHash = hash(block.body);
      const unitType = atomicType(block, path);
      const table =
        block.structuralType === "TABLE"
          ? markdownTableEvidence(block.body)[0]
          : undefined;
      const structuredTable =
        table && table.rows.length > 0 ? table : undefined;
      const locatorHint = locatorHintsByContentLine.get(block.startLine);
      const localTableOrdinal = structuredTable ? ++tableIndex : undefined;
      const tableOrdinal =
        structuredTable === undefined
          ? undefined
          : (locatorHint?.table ?? localTableOrdinal);
      const inheritedCoordinates = inheritedLocatorCoordinates(locatorHint);
      const baseEmbeddingEligible =
        structuredTable === undefined &&
        (!["PARAGRAPH", "LIST"].includes(block.structuralType) ||
          hasIndependentText(block.body));
      const embeddingFragments =
        baseEmbeddingEligible &&
        ["PARAGRAPH", "LIST", "CODE"].includes(block.structuralType)
          ? splitEmbeddingBody(block.body)
          : [];
      const splitForEmbedding = embeddingFragments.length > 1;
      const unitKey = `${sectionKey}-${unitType.toLowerCase()}-${String(block.startLine).padStart(6, "0")}-${contentHash.slice(0, 10)}`;
      units.push({
        unitKey,
        parentUnitKey: sectionKey,
        unitType,
        headingPath: [...path],
        body: block.body,
        contentHash,
        tokenEstimate: Math.ceil(block.body.length / 4),
        structuralOrder: order++,
        locator: {
          kind: "markdown",
          startLine: block.startLine,
          endLine: block.endLine,
          contentHash,
          ...inheritedCoordinates,
          ...(tableOrdinal !== undefined ? { table: tableOrdinal } : {}),
          ...(locatorHint?.row === undefined ? {} : { row: locatorHint.row }),
          ...(locatorHint?.column === undefined
            ? {}
            : { column: locatorHint.column }),
          ...(commentsByContentLine.has(block.startLine)
            ? {
                sourceCommentSpans: commentsByContentLine.get(block.startLine)!,
              }
            : {}),
        },
        containerOnly: structuredTable !== undefined || splitForEmbedding,
        embeddingEligible: baseEmbeddingEligible && !splitForEmbedding,
      });

      if (splitForEmbedding) {
        for (const [fragmentIndex, fragment] of embeddingFragments.entries()) {
          const fragmentHash = hash(fragment.body);
          const fragmentStartLine =
            block.startLine + lineOffsetAt(block.body, fragment.startOffset);
          const fragmentEndLine =
            block.startLine +
            lineOffsetAt(
              block.body,
              Math.max(fragment.startOffset, fragment.endOffset - 1),
            );
          units.push({
            unitKey: `${unitKey}-fragment-${String(fragmentIndex + 1).padStart(4, "0")}-${fragmentHash.slice(0, 10)}`,
            parentUnitKey: unitKey,
            unitType,
            headingPath: [...path],
            body: fragment.body,
            contentHash: fragmentHash,
            tokenEstimate: Math.ceil(fragment.body.length / 4),
            structuralOrder: order++,
            locator: {
              kind: "markdown",
              startLine: fragmentStartLine,
              endLine: fragmentEndLine,
              contentHash: fragmentHash,
              ...inheritedCoordinates,
              fragment: fragmentIndex + 1,
              ...(commentsByContentLine.has(block.startLine)
                ? {
                    sourceCommentSpans: commentsByContentLine.get(
                      block.startLine,
                    )!,
                  }
                : {}),
            },
            containerOnly: false,
            embeddingEligible: true,
          });
        }
      }

      if (!structuredTable || tableOrdinal === undefined) continue;
      const tableHeader = structuredTable.header.cells
        .map((cell) => cell.source.trim())
        .filter(Boolean)
        .join(" | ");
      const rowHeadingPath = tableHeader
        ? [...path, `Table columns: ${tableHeader}`]
        : [...path];

      for (const [rowIndex, row] of structuredTable.rows.entries()) {
        const rowNumber = rowIndex + 1;
        const rowHash = hash(row.source);
        const rowKey = `${unitKey}-row-${String(rowNumber).padStart(4, "0")}-${rowHash.slice(0, 10)}`;
        const rowStartLine =
          block.startLine + lineOffsetAt(block.body, row.span.startOffset);
        const rowEndLine =
          block.startLine +
          lineOffsetAt(
            block.body,
            Math.max(row.span.startOffset, row.span.endOffset - 1),
          );
        const rowHasContent = row.cells.some((cell) => cell.source.trim());
        units.push({
          unitKey: rowKey,
          parentUnitKey: unitKey,
          unitType: "TABLE_ROW",
          headingPath: rowHeadingPath,
          body: row.source,
          contentHash: rowHash,
          tokenEstimate: Math.ceil(row.source.length / 4),
          structuralOrder: order++,
          locator: {
            kind: "markdown",
            startLine: rowStartLine,
            endLine: rowEndLine,
            contentHash: rowHash,
            ...inheritedCoordinates,
            table: tableOrdinal,
            row: rowNumber,
          },
          containerOnly: !rowHasContent,
          embeddingEligible: rowHasContent,
        });

        for (const cell of row.cells) {
          if (!cell.source.trim()) continue;
          const cellHash = hash(cell.source);
          const columnNumber = cell.columnIndex + 1;
          const header =
            structuredTable.header.cells[cell.columnIndex]?.source.trim();
          const cellStartLine =
            block.startLine + lineOffsetAt(block.body, cell.span.startOffset);
          const cellEndLine =
            block.startLine +
            lineOffsetAt(
              block.body,
              Math.max(cell.span.startOffset, cell.span.endOffset - 1),
            );
          units.push({
            unitKey: `${rowKey}-cell-${String(columnNumber).padStart(3, "0")}-${cellHash.slice(0, 10)}`,
            parentUnitKey: rowKey,
            unitType: "TABLE_CELL",
            headingPath: header
              ? [...rowHeadingPath, `Column: ${header}`]
              : rowHeadingPath,
            body: cell.source,
            contentHash: cellHash,
            tokenEstimate: Math.ceil(cell.source.length / 4),
            structuralOrder: order++,
            locator: {
              kind: "markdown",
              startLine: cellStartLine,
              endLine: cellEndLine,
              contentHash: cellHash,
              ...inheritedCoordinates,
              table: tableOrdinal,
              row: rowNumber,
              column: columnNumber,
            },
            // Cell units preserve exact source identity for evidence binding.
            // Row units own retrieval because a scalar cell lacks row context.
            containerOnly: true,
            embeddingEligible: false,
          });
        }
      }
    }
  };

  for (const node of headingNodes) {
    const position = node.position;
    if (!position) continue;
    const index = position.start.line - 1;
    flushSection(index);
    const depth = Math.max(node.depth ?? 1, 1);
    while (headings.length > 0 && headings[headings.length - 1]!.depth >= depth)
      headings.pop();
    headings.push({ depth, label: headingLabel(node) });
    sectionStart = position.end.line;
  }
  flushSection(lines.length);
  return units;
}
