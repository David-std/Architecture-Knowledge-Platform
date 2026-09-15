import { describe, expect, it } from "vitest";
import { normalizeReviewManifest } from "./review-manifest";

const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";
const DOCUMENT_ID = "44444444-4444-4444-8444-444444444444";

describe("normalizeReviewManifest", () => {
  it("prefers the durable compiler review context", () => {
    const normalized = normalizeReviewManifest(
      {
        impactedDocumentIds: [DOCUMENT_ID],
        proposedChanges: [
          {
            path: "20-knowledge/generated/rule/cache.md",
            operation: "CREATE",
            reasons: ["Grounded in evidence"],
          },
        ],
        reviewContext: {
          identity: {
            classification: "DISTINCT",
            candidates: [DOCUMENT_ID],
            reason: "Distinct operational rule",
          },
          evidence: [
            {
              id: EVIDENCE_ID,
              sourceArtifactId: "22222222-2222-4222-8222-222222222222",
              excerptHash: "b".repeat(64),
              locator: { kind: "paragraph", paragraph: 1 },
            },
          ],
          existingCandidates: [
            {
              documentId: DOCUMENT_ID,
              title: "Cache behavior",
              path: "20-knowledge/concept/cache.md",
            },
          ],
          knowledgeCandidates: [
            {
              candidateId: "candidate-1",
              kind: "rule",
              statement: "Invalidate stale cached material.",
              proposedAction: "CREATE",
              evidenceIds: [EVIDENCE_ID],
              confidence: 0.92,
            },
          ],
          contradictions: [
            {
              candidateId: "candidate-1",
              existingDocumentId: DOCUMENT_ID,
              explanation: "Existing guidance conflicts.",
              severity: "HIGH",
              evidenceIds: [EVIDENCE_ID],
            },
          ],
          warnings: ["HUMAN_REVIEW_REQUIRED"],
        },
      },
      { probeResults: [{ question: "Grounded?", passed: true }] },
    );

    expect(normalized.identity.classification).toBe("DISTINCT");
    expect(normalized.evidenceIds).toEqual([EVIDENCE_ID]);
    expect(normalized.candidates[0]?.candidateId).toBe("candidate-1");
    expect(normalized.contradictions[0]?.existingDocumentId).toBe(DOCUMENT_ID);
    expect(normalized.existingCandidates[0]?.documentId).toBe(DOCUMENT_ID);
    expect(normalized.probes[0]?.passed).toBe(true);
    expect(normalized.warnings).toEqual(["HUMAN_REVIEW_REQUIRED"]);
  });

  it("keeps legacy review manifests inspectable without inventing compiler context", () => {
    const normalized = normalizeReviewManifest(
      {
        evidenceIds: [EVIDENCE_ID],
        candidates: [{ candidate_id: "legacy-candidate" }],
        conflicts: [{ explanation: "Legacy conflict" }],
      },
      {},
    );

    expect(normalized.reviewContext).toEqual({});
    expect(normalized.evidenceIds).toEqual([EVIDENCE_ID]);
    expect(normalized.candidates[0]?.candidate_id).toBe("legacy-candidate");
    expect(normalized.contradictions[0]?.explanation).toBe("Legacy conflict");
    expect(normalized.identity).toEqual({});
  });
});
