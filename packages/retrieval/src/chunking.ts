import { createHash } from "node:crypto";

export type KnowledgeUnitType =
  | "DOCUMENT"
  | "SECTION"
  | "RULE"
  | "WORKFLOW_STEP"
  | "EXAMPLE"
  | "COUNTEREXAMPLE"
  | "EVIDENCE"
  | "SOURCE_EXCERPT"
  | "CODE_EVIDENCE";

export interface ParsedKnowledgeUnit {
  unitKey: string;
  unitType: KnowledgeUnitType;
  headingPath: string[];
  body: string;
  contentHash: string;
  tokenEstimate: number;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function classify(headingPath: string[], body: string): KnowledgeUnitType {
  const value = `${headingPath.join(" ")} ${body.slice(0, 160)}`.toLowerCase();
  if (/\bcounterexample|contraejemplo|anti-pattern|antipatr[oó]n\b/.test(value))
    return "COUNTEREXAMPLE";
  if (/\bexample|ejemplo\b/.test(value)) return "EXAMPLE";
  if (/\bevidence|evidencia|locator|localizador\b/.test(value))
    return "EVIDENCE";
  if (/\brule|regla|must|debe\b/.test(value)) return "RULE";
  if (/\bstep|paso|workflow|flujo\b/.test(value)) return "WORKFLOW_STEP";
  return "SECTION";
}

export function parseKnowledgeUnits(
  title: string,
  body: string,
): ParsedKnowledgeUnit[] {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  const units: ParsedKnowledgeUnit[] = [
    {
      unitKey: "document",
      unitType: "DOCUMENT",
      headingPath: [title],
      body: normalized,
      contentHash: hash(normalized),
      tokenEstimate: Math.ceil(normalized.length / 4),
    },
  ];
  const lines = normalized.split("\n");
  const headings: string[] = [];
  let current: string[] = [];
  let sectionIndex = 0;

  const flush = () => {
    const content = current.join("\n").trim();
    if (!content || headings.length === 0) {
      current = [];
      return;
    }
    sectionIndex += 1;
    units.push({
      unitKey: `section-${sectionIndex}`,
      unitType: classify(headings, content),
      headingPath: [...headings],
      body: content,
      contentHash: hash(content),
      tokenEstimate: Math.ceil(content.length / 4),
    });
    current = [];
  };

  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^(#{1,6})\s+(.+?)\s*$/.exec(line) : null;
    if (!heading) {
      current.push(line);
      continue;
    }
    flush();
    const depth = heading[1]?.length ?? 1;
    headings.splice(depth - 1);
    headings[depth - 1] = heading[2]?.trim() ?? "";
  }
  flush();
  return units;
}
