import { createHash } from "node:crypto";

export type KnowledgeUnitType =
  | "DOCUMENT"
  | "SECTION"
  | "PARAGRAPH"
  | "LIST"
  | "TABLE"
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

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function semanticType(
  headingPath: readonly string[],
  body: string,
  fallback: KnowledgeUnitType,
): KnowledgeUnitType {
  const value = `${headingPath.join(" ")} ${body.slice(0, 240)}`.toLowerCase();
  if (/\bcounterexample|contraejemplo|anti-pattern|antipatr[oó]n\b/.test(value))
    return "COUNTEREXAMPLE";
  if (/\bprecondition|precondici[oó]n|given|dado que\b/.test(value))
    return "PRECONDITION";
  if (/\bexample|ejemplo\b/.test(value)) return "EXAMPLE";
  if (/\bevidence|evidencia|locator|localizador|citation|cita\b/.test(value))
    return "EVIDENCE";
  if (/\bsource excerpt|extracto de fuente|verbatim\b/.test(value))
    return "SOURCE_EXCERPT";
  if (/\brule|regla|must|must not|debe|no debe\b/.test(value)) return "RULE";
  if (/\bstep|paso|workflow|flujo|then|cuando\b/.test(value))
    return "WORKFLOW_STEP";
  return fallback;
}

function markdownBlocks(lines: readonly string[], offset: number): Block[] {
  const blocks: Block[] = [];
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
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line)) {
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index] ?? ""))
        index += 1;
      if (index < lines.length) index += 1;
      push(start, index - 1, "CODE");
      continue;
    }
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
    if (/^\s*\|.*\|\s*$/.test(line)) {
      index += 1;
      while (index < lines.length && /^\s*\|.*\|\s*$/.test(lines[index] ?? ""))
        index += 1;
      push(start, index - 1, "TABLE");
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
      !/^\s*```|^\s*\$\$|^\s*!\[|^\s*\|.*\|\s*$|^\s*(?:[-*+] |\d+[.)] )/.test(
        lines[index] ?? "",
      )
    )
      index += 1;
    push(start, index - 1, "PARAGRAPH");
  }
  return blocks;
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
  const lines = normalized ? normalized.split("\n") : [];
  const headings: string[] = [];
  let sectionStart = 0;
  let sectionIndex = 0;
  let order = 1;

  const flushSection = (endExclusive: number): void => {
    const sectionLines = lines.slice(sectionStart, endExclusive);
    const firstContent = sectionLines.findIndex(
      (line) => line.trim().length > 0,
    );
    if (firstContent < 0) return;
    const sectionBody = sectionLines.join("\n").trim();
    const hasHeading = headings.length > 0;
    const sectionKey = hasHeading ? `section-${++sectionIndex}` : "document";
    if (hasHeading) {
      const sectionHash = hash(sectionBody);
      units.push({
        unitKey: sectionKey,
        parentUnitKey: "document",
        unitType: "SECTION",
        headingPath: [...headings],
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
    for (const block of markdownBlocks(sectionLines, sectionStart + 1)) {
      const contentHash = hash(block.body);
      const unitType = atomicType(block, headings.length ? headings : [title]);
      units.push({
        unitKey: `${sectionKey}-${unitType.toLowerCase()}-${String(block.startLine).padStart(6, "0")}-${contentHash.slice(0, 10)}`,
        parentUnitKey: sectionKey,
        unitType,
        headingPath: headings.length ? [...headings] : [title],
        body: block.body,
        contentHash,
        tokenEstimate: Math.ceil(block.body.length / 4),
        structuralOrder: order++,
        locator: {
          kind: "markdown",
          startLine: block.startLine,
          endLine: block.endLine,
          contentHash,
        },
        containerOnly: false,
        embeddingEligible: true,
      });
    }
  };

  let inFence = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^(#{1,6})\s+(.+?)\s*$/.exec(line) : null;
    if (!heading) continue;
    flushSection(index);
    const depth = heading[1]?.length ?? 1;
    headings.splice(depth - 1);
    headings[depth - 1] = heading[2]?.trim() ?? "";
    sectionStart = index + 1;
  }
  flushSection(lines.length);
  return units;
}
