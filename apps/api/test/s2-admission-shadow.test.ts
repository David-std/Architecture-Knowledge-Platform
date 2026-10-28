import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  retrievalAnswerabilityCandidateKey,
} from "@akp/retrieval";
import {
  buildS2AdmissionShadowObservation,
  notifyS2AdmissionShadow,
} from "../src/s2-admission-shadow.js";

const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");

const excerpt = "🔋 M-7 battery measured 63%.";
const hit = {
  documentId: "document-1",
  vaultId: "authorized-vault",
  unitId: "unit-1",
  unitType: "PARAGRAPH",
  excerpt,
  revision: "revision-1",
  document: {
    externalId: "synthetic-public-fixture",
    path: "synthetic.md",
    title: "Synthetic",
  },
  title: "Synthetic",
  type: "concept",
  trust: "HUMAN_REVIEWED",
  lifecycle: "ACTIVE",
  refreshStatus: "CURRENT",
  score: 1,
  reasons: ["test"],
  fusionContributions: [
    { channel: "vector", rank: 1, channelWeight: 1, reason: "test" },
  ],
  citations: [],
} as SearchHit;

const input = () => {
  const baseline = assessRetrievalAnswerability([hit], "What is M-7 battery?");
  const quoteStart = excerpt.indexOf("63%");
  return {
    surface: "search" as const,
    mode: "LAYERED" as const,
    query: "What is M-7 battery?",
    authorizedVaultIds: [hit.vaultId],
    pool: [hit],
    admissionElapsedMs: 12.5,
    assessment: {
      ...baseline,
      supported: true,
      supportedCandidateKeys: [retrievalAnswerabilityCandidateKey(hit)],
      candidateSignals: baseline.candidateSignals.map((signal) => ({
        ...signal,
        queryConditionedEvidence: {
          verifierId: "test:semantic-reader",
          mode: "LAYERED" as const,
          decision: "SUPPORTS" as const,
          score: null,
          reason: "SOURCE_SPAN_SUPPORTED",
          evidenceSpan: {
            startOffset: quoteStart,
            endOffset: quoteStart + "63%".length,
          },
        },
      })),
    },
  };
};

describe("S2 redacted actual-admission shadow", () => {
  it("records the admitted reader span without exposing source or question bytes", () => {
    const recorded = buildS2AdmissionShadowObservation(input());
    expect(recorded).toMatchObject({
      status: "ACTUAL_APPLICATION_ADMISSION_DECISION_NOT_GOLD_SCORED",
      admissionMode: "LAYERED",
      supported: true,
      abstained: false,
      candidateCount: 1,
      admittedCandidateCount: 1,
      gateAccepted: false,
    });
    expect(recorded.candidates[0]).toMatchObject({
      excerptSha256: sha256(excerpt),
      admittedByApplication: true,
      readerDecision: "SUPPORTS",
      readerIdSha256: sha256("test:semantic-reader"),
      readerReasonCode: "SOURCE_SPAN_SUPPORTED",
      evidenceSpanStatus: "VALID_EXCERPT",
      evidenceSpan: { quoteSha256: sha256("63%") },
    });
    const serialized = JSON.stringify(recorded);
    expect(serialized).not.toContain(excerpt);
    expect(serialized).not.toContain("What is M-7 battery?");
    expect(serialized).not.toContain("authorized-vault");
  });

  it("records bounded vector/lexical candidate origin without leaking provider reasons or changing admission", () => {
    const base = input();
    const enriched = {
      ...hit,
      fusionContributions: [
        {
          channel: "vector",
          rank: 5,
          channelWeight: 1,
          rawScore: 0.841987,
          reason: "PRIVATE_VECTOR_REASON",
        },
        {
          channel: "vector",
          rank: 2,
          channelWeight: 1,
          rawScore: 0.842987,
          reason: "PRIVATE_VECTOR_REASON",
        },
        {
          channel: "lexical",
          rank: 3,
          channelWeight: 1,
          reason: "PRIVATE_LEXICAL_REASON",
        },
        {
          channel: "unknown-secret-provider",
          rank: 1,
          channelWeight: 1,
          reason: "PRIVATE_PROVIDER",
        },
        {
          channel: "exact",
          rank: -3,
          channelWeight: 1,
          reason: "PRIVATE_BAD_RANK",
        },
      ],
    } as SearchHit;
    const assessment = assessRetrievalAnswerability(
      [enriched],
      "What is M-7 battery?",
    );
    const record = buildS2AdmissionShadowObservation({
      ...base,
      pool: [enriched],
      assessment,
    });
    expect(record.candidates[0]?.retrievalChannelRanks).toEqual([
      { channel: "lexical", rank: 3 },
      { channel: "vector", rank: 2 },
    ]);
    expect(record.admittedCandidateCount).toBe(
      assessment.supportedCandidateKeys.length,
    );
    for (const text of [
      "PRIVATE_VECTOR_REASON",
      "PRIVATE_LEXICAL_REASON",
      "PRIVATE_PROVIDER",
      "unknown-secret-provider",
      "0.841987",
    ])
      expect(JSON.stringify(record)).not.toContain(text);
  });

  it("keeps a shadow verifier verdict separate from actual admission", () => {
    const recorded = buildS2AdmissionShadowObservation({
      ...input(),
      mode: "VERIFIER_SHADOW",
      assessment: {
        ...input().assessment,
        candidateSignals: input().assessment.candidateSignals.map((signal) => ({
          ...signal,
          queryConditionedEvidence: {
            verifierId: "test:shadow",
            mode: "SHADOW" as const,
            decision: "INSUFFICIENT" as const,
            score: null,
            reason: "VERIFIER_ABSTAINS",
            evidenceSpan: null,
          },
        })),
      },
    });
    expect(recorded.admittedCandidateCount).toBe(1);
    expect(recorded.candidates[0]?.readerDecision).toBe("INSUFFICIENT");
    expect(recorded.candidates[0]?.evidenceSpanStatus).toBe("NOT_PROVIDED");
  });

  it("rejects a UTF-16 surrogate split and never invents a quote", () => {
    const current = input();
    const invalid = buildS2AdmissionShadowObservation({
      ...current,
      assessment: {
        ...current.assessment,
        candidateSignals: current.assessment.candidateSignals.map((signal) => ({
          ...signal,
          queryConditionedEvidence: {
            ...signal.queryConditionedEvidence!,
            evidenceSpan: { startOffset: 1, endOffset: 2 },
          },
        })),
      },
    });
    expect(invalid.candidates[0]?.evidenceSpanStatus).toBe("INVALID_EXCERPT");
    expect(invalid.candidates[0]?.evidenceSpan).toBeNull();
  });

  it("redacts free-form reader reason text", () => {
    const current = input();
    const recorded = buildS2AdmissionShadowObservation({
      ...current,
      assessment: {
        ...current.assessment,
        candidateSignals: current.assessment.candidateSignals.map((signal) => ({
          ...signal,
          queryConditionedEvidence: {
            ...signal.queryConditionedEvidence!,
            reason: `Reader copied private passage: ${excerpt}`,
          },
        })),
      },
    });
    expect(recorded.candidates[0]?.readerReasonCode).toBe(
      "REDACTED_NON_CODE_REASON",
    );
    expect(JSON.stringify(recorded)).not.toContain(excerpt);
  });

  it("fails closed on foreign candidates and isolates observer failures", () => {
    expect(() =>
      buildS2AdmissionShadowObservation({
        ...input(),
        authorizedVaultIds: ["other-vault"],
      }),
    ).toThrow("S2_ADMISSION_SHADOW_SCOPE_OR_CANDIDATE_MISMATCH");
    expect(() =>
      notifyS2AdmissionShadow(() => {
        throw new Error("observer broken");
      }, input()),
    ).not.toThrow();
  });
});
