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
    | "example"
    | "evidence"
    | "source";
}

const roughTokens = (text: string): number => Math.ceil(text.length / 4);

const priority: Record<PacketCandidate["kind"], number> = {
  rule: 0,
  workflow: 1,
  profile: 2,
  example: 3,
  concept: 4,
  evidence: 5,
  source: 6,
};

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
      unitId: candidate.hit.unitId,
      retrievalChannels: candidate.hit.reasons,
      revision: candidate.hit.revision,
      score: candidate.hit.score,
      reason: candidate.hit.reasons.join("; "),
    });
  }

  const canonical = JSON.stringify({
    request: input.request,
    intent: input.intent,
    corpusRevision: input.corpusRevision,
    indexRevisions: input.indexRevisions,
    retrievalConfiguration: input.retrievalConfiguration,
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
    query: input.request.query,
    intent: input.intent,
    corpusRevision: input.corpusRevision,
    status:
      sections.length === 0
        ? "INSUFFICIENT_KNOWLEDGE"
        : Object.values(input.indexRevisions ?? {}).some(
              (revision) =>
                revision !== null && revision !== input.corpusRevision,
            )
          ? "DEGRADED"
          : "SUPPORTED",
    indexRevisions: input.indexRevisions,
    retrievalConfiguration: input.retrievalConfiguration,
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
