import { createHash, randomUUID } from "node:crypto";
import type { ContextPacket, SearchHit, SearchRequest } from "@akp/contracts";

export interface PacketCandidate {
  hit: SearchHit;
  content: string;
  kind:
    | "rule"
    | "workflow"
    | "concept"
    | "profile"
    | "decision"
    | "example"
    | "counterexample"
    | "evidence"
    | "source";
}

const roughTokens = (text: string): number => Math.ceil(text.length / 4);

const priority: Record<PacketCandidate["kind"], number> = {
  rule: 0,
  workflow: 1,
  profile: 2,
  decision: 3,
  concept: 4,
  example: 5,
  counterexample: 6,
  evidence: 7,
  source: 8,
};

const taskBudgets: Record<string, number> = {
  EXACT_LOOKUP: 3000,
  CONCEPTUAL: 6000,
  COMPARISON: 8000,
  WORKFLOW_EXECUTION: 7000,
  SOURCE_VERIFICATION: 8000,
  PROJECT_CODE: 9000,
  GLOBAL_SYNTHESIS: 12000,
  IMPACT_ANALYSIS: 8000,
  NO_RETRIEVAL_REQUIRED: 1000,
};

export function contextBudgetForIntent(
  intent: string,
  requested?: number,
): number {
  const value = requested ?? taskBudgets[intent] ?? 6000;
  return Math.max(256, Math.min(Math.trunc(value), 32000));
}

export function buildContextPacket(input: {
  request: SearchRequest;
  intent: string;
  corpusRevision: string;
  maxTokens: number;
  candidates: PacketCandidate[];
  gaps?: string[];
  conflicts?: string[];
  indexRevisions?: Record<string, string | null>;
  retrievalConfiguration?: Record<string, unknown>;
}): ContextPacket {
  const indexRevisions = input.indexRevisions ?? {
    corpus: input.corpusRevision,
    lexical: null,
    vector: null,
    graph: null,
    contextPack: null,
  };
  const retrievalConfiguration = input.retrievalConfiguration ?? {
    version: "unspecified",
    channels: [],
    vectorEnabled: false,
  };
  const selected = [...input.candidates].sort(
    (a, b) => priority[a.kind] - priority[b.kind] || b.hit.score - a.hit.score,
  );

  let usedTokens = 0;
  const sections: ContextPacket["sections"] = [];
  const citations = new Set<string>();
  const omitted: PacketCandidate[] = [];

  for (const candidate of selected) {
    const cost = roughTokens(candidate.content);
    if (usedTokens + cost > input.maxTokens) {
      omitted.push(candidate);
      continue;
    }
    usedTokens += cost;
    candidate.hit.citations.forEach((c) => citations.add(c));
    sections.push({
      kind: candidate.kind,
      title: candidate.hit.title,
      content: candidate.content,
      documentId: candidate.hit.documentId,
      vaultId: candidate.hit.vaultId,
      unitId: candidate.hit.unitId,
      parentUnitId: candidate.hit.parentUnitId,
      unitType: candidate.hit.unitType,
      retrievalChannels: candidate.hit.reasons,
      documentRevision: candidate.hit.revision,
      score: candidate.hit.score,
      selectionReason: candidate.hit.reasons.join("; "),
      sourceOrEvidenceIds: candidate.hit.citations,
    });
  }

  const canonical = JSON.stringify({
    request: input.request,
    intent: input.intent,
    corpusRevision: input.corpusRevision,
    indexRevisions,
    retrievalConfiguration,
    maxTokens: input.maxTokens,
    usedTokens,
    sections,
    citations: [...citations].sort(),
    gaps: input.gaps ?? [],
    conflicts: input.conflicts ?? [],
    omittedCandidateIds: omitted.map((candidate) => ({
      documentId: candidate.hit.documentId,
      unitId: candidate.hit.unitId ?? null,
    })),
  });
  const packetHash = createHash("sha256").update(canonical).digest("hex");

  return {
    packetId: randomUUID(),
    ...(input.request.vaultId ? { vaultId: input.request.vaultId } : {}),
    scope: {
      ...(input.request.organizationId
        ? { organizationId: input.request.organizationId }
        : {}),
      spaceId: input.request.spaceId,
      vaultIds: [
        ...new Set([
          ...(input.request.vaultId ? [input.request.vaultId] : []),
          ...(input.request.vaultIds ?? []),
        ]),
      ],
      federated: input.request.federated ?? false,
    },
    query: input.request.query,
    intent: input.intent,
    corpusRevision: input.corpusRevision,
    status:
      sections.length === 0
        ? "INSUFFICIENT_KNOWLEDGE"
        : Object.values(indexRevisions).some(
              (revision) =>
                revision !== null && revision !== input.corpusRevision,
            )
          ? "DEGRADED"
          : "SUPPORTED",
    indexRevisions,
    retrievalConfiguration,
    generatedAt: new Date().toISOString(),
    budget: { maxTokens: input.maxTokens, usedTokens },
    mode: input.request.mode,
    sections,
    citations: [...citations],
    gaps: input.gaps ?? [],
    conflicts: input.conflicts ?? [],
    requiredActions:
      citations.size === 0
        ? ["Do not claim vault authority without evidence."]
        : [],
    continuations:
      omitted.length === 0
        ? []
        : [
            {
              handle: createHash("sha256")
                .update(
                  `${packetHash}:${omitted.map((item) => item.hit.documentId).join(",")}`,
                )
                .digest("hex"),
              reason: `${omitted.length} lower-priority sections exceeded the token budget.`,
              remainingTokens: omitted.reduce(
                (sum, candidate) => sum + roughTokens(candidate.content),
                0,
              ),
            },
          ],
    packetHash,
  };
}
