import type { CompilationPlan } from "@akp/compiler";
import type { Postgres } from "@akp/postgres";

interface EvidenceRow {
  id: string;
  excerpt: string | null;
}

export interface CompilationProbeResult {
  question: string;
  criticality: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  evidenceIds: string[];
  passed: boolean;
  method: "DRAFT_EVIDENCE_RETRIEVAL";
  supportScore: number;
  matchedEvidenceIds: string[];
}

const TOKEN_PATTERN = /[\p{L}\p{N}]{4,}/gu;
const NEGATION_PATTERN =
  /\b(?:no|not|never|without|cannot|mustn['’]?t|nunca|sin|jam[aá]s)\b/iu;
const MIN_EVIDENCE_COVERAGE = 0.45;
const MIN_SHARED_TOKENS = 3;
const PRESENTATION_TOKENS = new Set([
  "draft",
  "status",
  "title",
  "type",
  "claim",
  "rule",
  "concept",
  "knowledge",
]);

function tokens(value: string): Set<string> {
  return new Set(
    (value.toLocaleLowerCase().match(TOKEN_PATTERN) ?? []).filter(
      (token) => token.length >= 4,
    ),
  );
}

function overlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0;
  let count = 0;
  for (const token of left) if (right.has(token)) count += 1;
  return count;
}

function paragraphs(value: string): string[] {
  return value
    .split(/\n\s*\n/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function semanticDraftText(value: string): string {
  return value
    .replace(/^---[\s\S]*?---\s*/u, "")
    .split(/\r?\n/u)
    .filter((line) => !/^\s*#{1,6}\s/u.test(line))
    .join("\n");
}

function evidenceSupportScore(
  question: string,
  excerpt: string,
  draftFragments: string[],
): number {
  const questionTokens = tokens(question);
  const evidenceTokens = tokens(excerpt);
  let best = 0;
  for (const fragment of draftFragments) {
    const fragmentTokens = tokens(fragment);
    const evidenceOverlap = overlap(evidenceTokens, fragmentTokens);
    const questionOverlap = overlap(questionTokens, fragmentTokens);
    const evidenceDenominator = Math.max(1, Math.min(evidenceTokens.size, 12));
    const questionDenominator = Math.max(1, Math.min(questionTokens.size, 8));
    const score =
      0.8 * Math.min(1, evidenceOverlap / evidenceDenominator) +
      0.2 * Math.min(1, questionOverlap / questionDenominator);
    best = Math.max(best, score);
  }
  return best;
}

function hasNegation(value: string): boolean {
  return NEGATION_PATTERN.test(value.toLocaleLowerCase());
}

/**
 * Evaluate compiler probes against the candidate draft without trusting model
 * self-assessment. Evidence is reloaded from the same space/vault/source scope;
 * only changes explicitly linked to a probe's evidence IDs are searchable.
 */
export async function evaluateCompilationProbes(
  db: Postgres,
  input: {
    plan: CompilationPlan;
    spaceId: string;
    vaultId: string;
    sourceId: string;
  },
): Promise<CompilationProbeResult[]> {
  const evidenceIds = [
    ...new Set(input.plan.probes.flatMap((probe) => probe.evidenceIds)),
  ];
  if (!evidenceIds.length) return [];

  const evidence = await db.pool.query<EvidenceRow>(
    `
    select id,excerpt
      from evidence
     where space_id=$1 and vault_id=$2 and source_id=$3
       and id=any($4::uuid[])
    `,
    [input.spaceId, input.vaultId, input.sourceId, evidenceIds],
  );
  const excerptById = new Map(
    evidence.rows
      .filter((row) => row.excerpt?.trim())
      .map((row) => [row.id, String(row.excerpt)]),
  );

  return input.plan.probes.map((probe) => {
    const linkedChanges = input.plan.proposedChanges.filter((change) =>
      probe.evidenceIds.some((evidenceId) =>
        change.evidenceIds.includes(evidenceId),
      ),
    );
    const linkedFragments = linkedChanges.flatMap((change) =>
      paragraphs(change.content),
    );
    const matchedEvidenceIds: string[] = [];
    let supportScore = 0;
    for (const evidenceId of probe.evidenceIds) {
      const excerpt = excerptById.get(evidenceId);
      if (!excerpt) continue;
      const linkedForEvidence = linkedChanges.filter((change) =>
        change.evidenceIds.includes(evidenceId),
      );
      if (!linkedForEvidence.length) continue;
      const score = evidenceSupportScore(
        probe.question,
        excerpt,
        linkedForEvidence.flatMap((change) => paragraphs(change.content)),
      );
      const evidenceTokens = tokens(excerpt);
      const draftText = linkedForEvidence
        .map((change) => semanticDraftText(change.content))
        .join("\n");
      const draftTokens = tokens(draftText);
      const sharedTokens = overlap(evidenceTokens, draftTokens);
      const allowedTokens = new Set([
        ...evidenceTokens,
        ...tokens(probe.question),
      ]);
      const unsupportedTokens = [...draftTokens].filter(
        (token) => !allowedTokens.has(token) && !PRESENTATION_TOKENS.has(token),
      );
      const polarityMatches = hasNegation(excerpt) === hasNegation(draftText);
      supportScore = Math.max(supportScore, score);
      if (
        sharedTokens >= Math.min(MIN_SHARED_TOKENS, evidenceTokens.size) &&
        score >= MIN_EVIDENCE_COVERAGE &&
        polarityMatches &&
        unsupportedTokens.length === 0
      ) {
        matchedEvidenceIds.push(evidenceId);
      }
    }
    const passed =
      linkedFragments.length > 0 &&
      probe.evidenceIds.length > 0 &&
      matchedEvidenceIds.length === probe.evidenceIds.length;
    return {
      question: probe.question,
      criticality: probe.criticality,
      evidenceIds: probe.evidenceIds,
      passed,
      method: "DRAFT_EVIDENCE_RETRIEVAL",
      supportScore,
      matchedEvidenceIds,
    };
  });
}
