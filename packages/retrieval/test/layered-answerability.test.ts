import { randomUUID } from "node:crypto";
import type { SearchHit } from "@akp/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  assessRetrievalAnswerability,
  retrievalAnswerabilityCandidateKey,
  type QueryConditionedEvidenceVerifier,
} from "../src/answerability.js";
import {
  LayeredEvidenceAdmissionPipeline,
  QueryConditionedSemanticEvidenceReader,
  type EvidenceAdmissionDecision,
  type SemanticEvidenceReader,
} from "../src/evidence-admission.js";
import { assessRetrievalAnswerabilityWithLayeredAdmission } from "../src/layered-answerability.js";

const QUERY = "What is the retry budget?";

function hit(excerpt: string, overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    documentId: randomUUID(),
    vaultId: randomUUID(),
    unitId: randomUUID(),
    unitType: "PARAGRAPH",
    document: {
      externalId: `doc-${randomUUID().slice(0, 8)}`,
      path: "architecture/retry.md",
      title: "Retry policy",
    },
    revision: "layered-test",
    title: "Retry policy",
    type: "decision-rule",
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["test"],
    excerpt,
    citations: [],
    ...overrides,
  };
}

/** Answers with the whole trimmed excerpt for the listed excerpts only. */
function semanticReader(answering: readonly string[]): SemanticEvidenceReader {
  const decide = (passage: string): EvidenceAdmissionDecision => {
    const start = passage.length - passage.trimStart().length;
    return answering.includes(passage.trim())
      ? {
          layer: "SEMANTIC_READER",
          verdict: {
            kind: "ANSWERS",
            quote: {
              startOffset: start,
              endOffset: start + passage.trim().length,
            },
          },
          reason: "READER_QUOTED_ANSWER",
          readerId: "fake-reader",
        }
      : {
          layer: "SEMANTIC_READER",
          verdict: { kind: "RELATED_NOT_ANSWERING" },
          reason: "READER_FOUND_NO_ANSWER",
          readerId: "fake-reader",
        };
  };
  return {
    id: "fake-reader",
    read: async (input) => decide(input.passage),
    readBatch: async (inputs) => inputs.map((input) => decide(input.passage)),
  };
}

describe("layered production admission", () => {
  it("admits only source-bound pipeline answers and withdraws lexical passage authority", async () => {
    const lexical = hit("The retry budget is reviewed by the platform team.");
    const answering = hit("The retry budget is 3 attempts per request.");
    const pool = [lexical, answering];
    const legacy = assessRetrievalAnswerability(pool, QUERY);
    expect(legacy.supportedCandidateKeys).toContain(
      retrievalAnswerabilityCandidateKey(lexical),
    );

    const assessment = await assessRetrievalAnswerabilityWithLayeredAdmission(
      pool,
      QUERY,
      new LayeredEvidenceAdmissionPipeline({
        semanticReader: semanticReader([answering.excerpt]),
      }),
    );

    expect(assessment.supported).toBe(true);
    expect(assessment.reason).toBe("QUERY_CONDITIONED_SUPPORT");
    expect(assessment.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(answering),
    ]);
    const bySignal = new Map(
      assessment.candidateSignals.map((signal) => [
        signal.candidateKey,
        signal,
      ]),
    );
    expect(
      bySignal.get(retrievalAnswerabilityCandidateKey(lexical))?.passageSupport,
    ).toMatchObject({
      supported: false,
      reason: "QUERY_CONDITIONED_INSUFFICIENT",
    });
    expect(
      bySignal.get(retrievalAnswerabilityCandidateKey(answering))
        ?.queryConditionedEvidence,
    ).toEqual({
      verifierId: "fake-reader",
      mode: "LAYERED",
      decision: "SUPPORTS",
      score: null,
      reason: "READER_QUOTED_ANSWER",
      evidenceSpan: { startOffset: 0, endOffset: answering.excerpt.length },
    });
  });

  it("reports spans against the trimmed excerpt", async () => {
    const padded = hit("  The retry budget is 3 attempts per request.\n");
    const assessment = await assessRetrievalAnswerabilityWithLayeredAdmission(
      [padded],
      QUERY,
      new LayeredEvidenceAdmissionPipeline({
        semanticReader: semanticReader([padded.excerpt.trim()]),
      }),
    );
    expect(assessment.supported).toBe(true);
    expect(
      assessment.candidateSignals[0]?.queryConditionedEvidence?.evidenceSpan,
    ).toEqual({ startOffset: 0, endOffset: padded.excerpt.trim().length });
  });

  it("keeps contradictions and related passages out of admission", async () => {
    const contradicting = hit("The retry budget is not 5 attempts.");
    const pipeline = {
      evaluateBatch: vi.fn(async () => [
        {
          layer: "SEMANTIC_READER" as const,
          verdict: {
            kind: "CONTRADICTS" as const,
            quote: { startOffset: 0, endOffset: contradicting.excerpt.length },
          },
          reason: "READER_QUOTED_CONTRADICTION",
        },
      ]),
    };
    const assessment = await assessRetrievalAnswerabilityWithLayeredAdmission(
      [contradicting],
      QUERY,
      pipeline,
    );
    expect(assessment).toMatchObject({
      supported: false,
      reason: "SUPPORT_NOT_DEMONSTRATED",
      supportedCandidateKeys: [],
    });
    expect(assessment.candidateSignals[0]?.passageSupport.reason).toBe(
      "QUERY_CONDITIONED_CONTRADICTION",
    );
  });

  it("never admits candidates outside the bounded window", async () => {
    const pool = [
      hit("The retry budget is 3 attempts per request."),
      hit("The retry budget is 3 attempts per batch."),
      hit("The retry budget is 3 attempts per job."),
    ];
    const reader = semanticReader(pool.map((entry) => entry.excerpt));
    const readBatch = vi.spyOn(reader, "readBatch");
    const assessment = await assessRetrievalAnswerabilityWithLayeredAdmission(
      pool,
      QUERY,
      new LayeredEvidenceAdmissionPipeline({ semanticReader: reader }),
      { maxCandidates: 1 },
    );
    expect(readBatch).toHaveBeenCalledTimes(1);
    expect(readBatch.mock.calls[0]?.[0]).toHaveLength(1);
    expect(assessment.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(pool[0]!),
    ]);
    for (const signal of assessment.candidateSignals.slice(1)) {
      expect(signal.passageSupport.supported).toBe(false);
      expect(signal.queryConditionedEvidence).toMatchObject({
        decision: "NOT_VERIFIED",
        reason: "LAYERED_ADMISSION_OUTSIDE_BOUNDED_WINDOW",
      });
    }
  });

  it("fails closed and reports degradation when the reader fails", async () => {
    const candidate = hit("The retry budget is 3 attempts per request.");
    const failingVerifier: QueryConditionedEvidenceVerifier = {
      id: "failing-verifier",
      verify: async () => {
        throw new Error("provider unavailable");
      },
    };
    const assessment = await assessRetrievalAnswerabilityWithLayeredAdmission(
      [candidate],
      QUERY,
      new LayeredEvidenceAdmissionPipeline({
        semanticReader: new QueryConditionedSemanticEvidenceReader({
          verifier: failingVerifier,
        }),
      }),
    );
    expect(assessment.supported).toBe(false);
    expect(assessment.candidateSignals[0]?.passageSupport.reason).toBe(
      "QUERY_CONDITIONED_VERIFIER_ERROR",
    );
    expect(
      assessment.candidateSignals[0]?.queryConditionedEvidence?.decision,
    ).toBe("VERIFIER_ERROR");
  });

  it("fails closed on a rejected or malformed pipeline batch", async () => {
    const pool = [hit("The retry budget is 3 attempts per request.")];
    for (const pipeline of [
      { evaluateBatch: async () => Promise.reject(new Error("down")) },
      { evaluateBatch: async () => [] as EvidenceAdmissionDecision[] },
    ]) {
      const assessment = await assessRetrievalAnswerabilityWithLayeredAdmission(
        pool,
        QUERY,
        pipeline,
      );
      expect(assessment.supported).toBe(false);
      expect(
        assessment.candidateSignals[0]?.queryConditionedEvidence,
      ).toMatchObject({ mode: "LAYERED", decision: "VERIFIER_ERROR" });
    }
  });

  it("returns the empty-pool assessment and validates its window", async () => {
    const pipeline = { evaluateBatch: vi.fn(async () => []) };
    await expect(
      assessRetrievalAnswerabilityWithLayeredAdmission([], QUERY, pipeline),
    ).resolves.toMatchObject({ supported: false, reason: "NO_CANDIDATES" });
    expect(pipeline.evaluateBatch).not.toHaveBeenCalled();
    await expect(
      assessRetrievalAnswerabilityWithLayeredAdmission([], QUERY, pipeline, {
        maxCandidates: 0,
      }),
    ).rejects.toThrow(/maxCandidates/);
  });
});
