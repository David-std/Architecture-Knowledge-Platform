import { createHash, randomUUID } from "node:crypto";
import type { ContextPacket, SearchHit, SearchRequest } from "@akp/contracts";

export interface PacketCandidate {
  hit: SearchHit;
  content: string;
  kind: "rule" | "workflow" | "concept" | "profile" | "example" | "evidence" | "source";
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
}): ContextPacket {
  const selected = [...input.candidates].sort(
    (a, b) => priority[a.kind] - priority[b.kind] || b.hit.score - a.hit.score,
  );

  let usedTokens = 0;
  const sections: ContextPacket["sections"] = [];
  const citations = new Set<string>();

  for (const candidate of selected) {
    const cost = roughTokens(candidate.content);
    if (usedTokens + cost > input.maxTokens) continue;
    usedTokens += cost;
    candidate.hit.citations.forEach((c) => citations.add(c));
    sections.push({
      kind: candidate.kind,
      title: candidate.hit.title,
      content: candidate.content,
      documentId: candidate.hit.documentId,
      revision: candidate.hit.revision,
      score: candidate.hit.score,
      reason: candidate.hit.reasons.join("; "),
    });
  }

  const canonical = JSON.stringify({
    query: input.request.query,
    corpusRevision: input.corpusRevision,
    sections,
    citations: [...citations].sort(),
  });
  const packetHash = createHash("sha256").update(canonical).digest("hex");

  return {
    packetId: randomUUID(),
    query: input.request.query,
    intent: input.intent,
    corpusRevision: input.corpusRevision,
    generatedAt: new Date().toISOString(),
    budget: { maxTokens: input.maxTokens, usedTokens },
    mode: input.request.mode,
    sections,
    citations: [...citations],
    gaps: input.gaps ?? [],
    conflicts: input.conflicts ?? [],
    requiredActions: citations.size === 0 ? ["Do not claim vault authority without evidence."] : [],
    packetHash,
  };
}
