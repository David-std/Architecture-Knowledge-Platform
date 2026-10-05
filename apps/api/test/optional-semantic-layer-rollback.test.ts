import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  assessRetrievalAnswerabilityWithVerifier,
  type QueryConditionedEvidenceVerifier,
} from "@akp/retrieval";
import {
  EVIDENCE_VERIFIER_DEGRADED_WARNING,
  evidenceVerifierDegradationWarnings,
} from "../src/routes/search.js";

function supportedNaturalLanguageHit(): SearchHit {
  return {
    documentId: "11111111-1111-4111-8111-000000000001",
    vaultId: "22222222-2222-4222-8222-000000000001",
    unitId: "33333333-3333-4333-8333-000000000001",
    unitType: "PARAGRAPH",
    document: {
      externalId: "nexo-integration",
      path: "docs/nexo-integration.md",
      title: "NEXO integration",
    },
    revision: "revision-1",
    title: "NEXO integration",
    type: "claim",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 0.91,
    reasons: ["vector:test"],
    fusionContributions: [
      {
        channel: "vector",
        rank: 1,
        channelWeight: 1,
        rawScore: 0.91,
        reason: "vector:test",
      },
    ],
    excerpt: "NEXO can use QARO for delivery.",
    citations: [],
  };
}

describe("optional semantic-layer degradation and rollback", () => {
  it("preserves SHADOW baseline, fails closed in ENFORCE, and rolls back exactly", async () => {
    const hit = supportedNaturalLanguageHit();
    const query = "Can NEXO use QARO?";
    const baseline = assessRetrievalAnswerability([hit], query);

    expect(baseline.supported).toBe(true);
    expect(baseline.supportedCandidateKeys).toHaveLength(1);
    expect(evidenceVerifierDegradationWarnings(baseline)).toEqual([]);

    let verifierCalls = 0;
    const unavailable: QueryConditionedEvidenceVerifier = {
      id: "synthetic-unavailable-verifier",
      async verify() {
        verifierCalls += 1;
        throw new Error(
          "https://secret-verifier.local/api timeout token=do-not-leak",
        );
      },
    };

    const shadow = await assessRetrievalAnswerabilityWithVerifier(
      [hit],
      query,
      unavailable,
      { mode: "SHADOW", maxCandidates: 1, maxConcurrency: 1 },
    );

    expect(shadow.supported).toBe(baseline.supported);
    expect(shadow.reason).toBe(baseline.reason);
    expect(shadow.supportedCandidateKeys).toEqual(
      baseline.supportedCandidateKeys,
    );
    expect(evidenceVerifierDegradationWarnings(shadow)).toEqual([
      EVIDENCE_VERIFIER_DEGRADED_WARNING,
    ]);
    expect(shadow.candidateSignals[0]?.queryConditionedEvidence).toMatchObject({
      mode: "SHADOW",
      decision: "VERIFIER_ERROR",
    });
    expect(JSON.stringify(shadow)).not.toContain("secret-verifier");
    expect(JSON.stringify(shadow)).not.toContain("do-not-leak");

    const enforced = await assessRetrievalAnswerabilityWithVerifier(
      [hit],
      query,
      unavailable,
      { mode: "ENFORCE", maxCandidates: 1, maxConcurrency: 1 },
    );

    expect(enforced.supported).toBe(false);
    expect(enforced.reason).toBe("SUPPORT_NOT_DEMONSTRATED");
    expect(enforced.supportedCandidateKeys).toEqual([]);
    expect(
      enforced.candidateSignals[0]?.passageSupport.reason,
    ).toBe("QUERY_CONDITIONED_VERIFIER_ERROR");
    expect(evidenceVerifierDegradationWarnings(enforced)).toEqual([
      EVIDENCE_VERIFIER_DEGRADED_WARNING,
    ]);

    const rolledBack = assessRetrievalAnswerability([hit], query);
    expect({
      supported: rolledBack.supported,
      reason: rolledBack.reason,
      supportedDocumentIds: rolledBack.supportedDocumentIds,
      supportedCandidateKeys: rolledBack.supportedCandidateKeys,
    }).toEqual({
      supported: baseline.supported,
      reason: baseline.reason,
      supportedDocumentIds: baseline.supportedDocumentIds,
      supportedCandidateKeys: baseline.supportedCandidateKeys,
    });
    expect(evidenceVerifierDegradationWarnings(rolledBack)).toEqual([]);
    expect(verifierCalls).toBe(2);
  });
});
