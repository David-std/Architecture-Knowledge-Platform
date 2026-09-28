import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  retrievalAnswerabilityCandidateKey,
} from "@akp/retrieval";
import { partitionSearchHitsByAnswerability } from "../src/routes/search.js";

function hit(id: string, unitId?: string): SearchHit {
  return {
    ...(unitId ? { unitId } : {}),
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
  it("moves unsupported candidates to exploratoryHits without treating them as evidence", () => {
    const candidate = hit("11111111-1111-4111-8111-111111111111");
    expect(partitionSearchHitsByAnswerability([candidate], [])).toEqual({
      hits: [],
      exploratoryHits: [candidate],
      retrievalOutcome: "EXPLORATORY_ONLY",
    });
  });

  it("keeps only passage-supported candidates in hits", () => {
    const supported = hit("11111111-1111-4111-8111-111111111112");
    const exploratory = hit("11111111-1111-4111-8111-111111111113");
    expect(
      partitionSearchHitsByAnswerability(
        [supported, exploratory],
        [retrievalAnswerabilityCandidateKey(supported)],
      ),
    ).toEqual({
      hits: [supported],
      exploratoryHits: [exploratory],
      retrievalOutcome: "SUPPORTED",
    });
  });

  it("does not let a supported unit admit an unsupported sibling from the same document", () => {
    const documentId = "11111111-1111-4111-8111-111111111114";
    const supported = hit(documentId, "22222222-2222-4222-8222-222222222221");
    const sibling = hit(documentId, "22222222-2222-4222-8222-222222222222");

    expect(
      partitionSearchHitsByAnswerability(
        [supported, sibling],
        [retrievalAnswerabilityCandidateKey(supported)],
      ),
    ).toEqual({
      hits: [supported],
      exploratoryHits: [sibling],
      retrievalOutcome: "SUPPORTED",
    });
  });

  it("presents the condition-bearing unit and leaves a topical definition exploratory", () => {
    const documentId = "11111111-1111-4111-8111-111111111115";
    const definition: SearchHit = {
      ...hit(documentId, "22222222-2222-4222-8222-222222222223"),
      excerpt:
        "Immutable change logs record every domain change and retain a complete operational history for later reconstruction.",
      fusionContributions: [
        {
          channel: "exact",
          rank: 1,
          channelWeight: 1,
          reason: "exact:test",
        },
        {
          channel: "vector",
          rank: 1,
          channelWeight: 1,
          rawScore: 0.91,
          reason: "vector:test",
        },
      ],
    };
    const condition: SearchHit = {
      ...hit(documentId, "22222222-2222-4222-8222-222222222224"),
      excerpt:
        "Immutable change logs are a poor fit for simple mutable records because operational overhead outweighs the audit requirement.",
      fusionContributions: [
        {
          channel: "vector",
          rank: 2,
          channelWeight: 1,
          rawScore: 0.89,
          reason: "vector:test",
        },
      ],
    };
    const candidates = [definition, condition];
    const assessment = assessRetrievalAnswerability(
      candidates,
      "When should immutable change logs be avoided because operational overhead is high?",
    );

    expect(
      partitionSearchHitsByAnswerability(
        candidates,
        assessment.supportedCandidateKeys,
      ),
    ).toEqual({
      hits: [condition],
      exploratoryHits: [definition],
      retrievalOutcome: "SUPPORTED",
    });
  });

  it("distinguishes a true empty retrieval from an answerability rejection", () => {
    expect(partitionSearchHitsByAnswerability([], [])).toEqual({
      hits: [],
      exploratoryHits: [],
      retrievalOutcome: "NO_CANDIDATES",
    });
  });
});
