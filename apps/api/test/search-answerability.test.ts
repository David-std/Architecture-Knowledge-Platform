import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import { partitionSearchHitsByAnswerability } from "../src/routes/search.js";

function hit(id: string): SearchHit {
  return {
    documentId: id,
    vaultId: "22222222-2222-4222-8222-222222222222",
    document: {
      externalId: `doc-${id.slice(-4)}`,
      path: `docs/${id.slice(-4)}.md`,
      title: "Candidate",
    },
    revision: "revision-1",
    title: "Candidate",
    type: "concept",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["test"],
    excerpt: "Authorized candidate.",
    citations: [],
  };
}

describe("search answerability presentation", () => {
  it("moves rejected candidates to exploratoryHits without treating them as evidence", () => {
    const candidate = hit("11111111-1111-4111-8111-111111111111");
    expect(partitionSearchHitsByAnswerability([candidate], false)).toEqual({
      hits: [],
      exploratoryHits: [candidate],
      retrievalOutcome: "EXPLORATORY_ONLY",
    });
  });

  it("keeps supported candidates in hits", () => {
    const candidate = hit("11111111-1111-4111-8111-111111111112");
    expect(partitionSearchHitsByAnswerability([candidate], true)).toEqual({
      hits: [candidate],
      exploratoryHits: [],
      retrievalOutcome: "SUPPORTED",
    });
  });

  it("distinguishes a true empty retrieval from an answerability rejection", () => {
    expect(partitionSearchHitsByAnswerability([], false)).toEqual({
      hits: [],
      exploratoryHits: [],
      retrievalOutcome: "NO_CANDIDATES",
    });
  });
});
