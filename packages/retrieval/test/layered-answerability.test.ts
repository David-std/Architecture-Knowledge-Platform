import { createHash, randomUUID } from "node:crypto";
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
import {
  assessRetrievalAnswerabilityWithLayeredAdmission,
  type GovernedLayeredPropositionProof,
} from "../src/layered-answerability.js";

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

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

function governedProof(
  candidate: SearchHit,
  originalQuestion: string,
  overrides: Partial<GovernedLayeredPropositionProof> = {},
): GovernedLayeredPropositionProof {
  const originalSourceText =
    "SOURCE HEADER\n" + candidate.excerpt + "\nSOURCE END";
  return {
    originalQuestion,
    originalQuestionSha256: sha256(originalQuestion),
    candidateKey: retrievalAnswerabilityCandidateKey(candidate),
    documentId: candidate.documentId,
    unitId: candidate.unitId ?? null,
    vaultId: candidate.vaultId,
    revision: candidate.revision,
    path: candidate.document.path,
    originalSourceText,
    originalSourceBytes: new TextEncoder().encode(originalSourceText),
    originalSourceSha256: sha256(originalSourceText),
    excerptStartUtf16: "SOURCE HEADER\n".length,
    excerptEndUtf16: "SOURCE HEADER\n".length + candidate.excerpt.length,
    queryProposition: {
      subject: "Lira",
      predicate: "approved",
      object: "the index",
      polarity: "POSITIVE",
      temporalScope: "2026-09-13",
      conditions: ["after inspection"],
    },
    candidateProposition: {
      subject: "Lira",
      predicate: "approved",
      object: "the index",
      polarity: "POSITIVE",
      temporalScope: "2026-09-13",
      conditions: ["after inspection"],
      quote: { startOffset: 0, endOffset: candidate.excerpt.length },
    },
    ...overrides,
  };
}

describe("layered production admission", () => {
  it("uses a pinned original SOURCE proposition and never asks the model to overrule a mismatch", async () => {
    const query = "Did Lira approve the index on 2026-09-13 after inspection?";
    const candidate = hit(
      "Lira approved the index on 2026-09-13 after inspection.",
    );
    const reader = semanticReader([candidate.excerpt]);
    const readBatch = vi.spyOn(reader, "readBatch");
    const pipeline = new LayeredEvidenceAdmissionPipeline({
      semanticReader: reader,
      // Default SEMANTIC_FALLBACK cannot override governed mismatches.
    });
    const exact = governedProof(candidate, query);
    const positive = await assessRetrievalAnswerabilityWithLayeredAdmission(
      [candidate],
      query,
      pipeline,
      { governedPropositionPort: { resolve: async () => exact } },
    );
    expect(positive.supported).toBe(true);
    expect(positive.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(candidate),
    ]);
    expect(
      positive.candidateSignals[0]?.queryConditionedEvidence,
    ).toMatchObject({
      verifierId: "layered-admission:STRUCTURED_PROPOSITION",
      decision: "SUPPORTS",
      evidenceSpan: { startOffset: 0, endOffset: candidate.excerpt.length },
    });
    for (const change of [
      { queryProposition: { ...exact.queryProposition, subject: "Miro" } },
      {
        queryProposition: { ...exact.queryProposition, predicate: "rejected" },
      },
      { queryProposition: { ...exact.queryProposition, object: "Lira" } },
      {
        queryProposition: {
          ...exact.queryProposition,
          polarity: "NEGATIVE" as const,
        },
      },
      {
        queryProposition: {
          ...exact.queryProposition,
          temporalScope: "2026-09-14",
        },
      },
      {
        queryProposition: {
          ...exact.queryProposition,
          conditions: ["without inspection"],
        },
      },
    ]) {
      const withheld = await assessRetrievalAnswerabilityWithLayeredAdmission(
        [candidate],
        query,
        pipeline,
        {
          governedPropositionPort: {
            resolve: async () => ({ ...exact, ...change }),
          },
        },
      );
      expect(withheld.supported).toBe(false);
      expect(withheld.supportedCandidateKeys).toEqual([]);
      expect(
        withheld.candidateSignals[0]?.queryConditionedEvidence?.decision,
      ).not.toBe("SUPPORTS");
    }
    expect(readBatch).not.toHaveBeenCalled();
  });

  it("fails closed when original question, document revision, bytes or quote coordinates change", async () => {
    const query = "Did Lira approve the index on 2026-09-13 after inspection?";
    const candidate = hit(
      "Lira approved the index on 2026-09-13 after inspection.",
    );
    const exact = governedProof(candidate, query);
    const reader = semanticReader([candidate.excerpt]);
    const readBatch = vi.spyOn(reader, "readBatch");
    const pipeline = new LayeredEvidenceAdmissionPipeline({
      semanticReader: reader,
    });
    for (const change of [
      { originalQuestion: "Different question" },
      { originalQuestionSha256: sha256("Different question") },
      { candidateKey: "other-unit" },
      { documentId: randomUUID() },
      { vaultId: randomUUID() },
      { revision: "other-revision" },
      { path: "other-document.md" },
      { originalSourceSha256: sha256("other-source") },
      { originalSourceText: exact.originalSourceText + " tampered" },
      { originalSourceBytes: new TextEncoder().encode("tampered raw bytes") },
      { originalSourceBytes: new Uint8Array([0xff, 0xfe]) },
      { excerptStartUtf16: exact.excerptStartUtf16 + 1 },
      {
        candidateProposition: {
          ...exact.candidateProposition,
          quote: { startOffset: 0, endOffset: candidate.excerpt.length + 1 },
        },
      },
    ]) {
      const assessment = await assessRetrievalAnswerabilityWithLayeredAdmission(
        [candidate],
        query,
        pipeline,
        {
          governedPropositionPort: {
            resolve: async () => ({ ...exact, ...change }),
          },
        },
      );
      expect(assessment.supported).toBe(false);
      expect(
        assessment.candidateSignals[0]?.queryConditionedEvidence,
      ).toMatchObject({
        decision: "INSUFFICIENT",
        reason: "GOVERNED_SOURCE_PROPOSITION_UNAVAILABLE",
      });
    }
    const unavailable = await assessRetrievalAnswerabilityWithLayeredAdmission(
      [candidate],
      query,
      pipeline,
      {
        governedPropositionPort: {
          resolve: async () => {
            throw Error("private provider token must not escape");
          },
        },
      },
    );
    expect(unavailable.supported).toBe(false);
    expect(JSON.stringify(unavailable)).not.toContain("private provider token");
    expect(readBatch).not.toHaveBeenCalled();
  });

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

  it("records the final structural veto rather than the reader proposal", async () => {
    const outdated = hit("The retry budget is 3 attempts in 2025.");
    const assessment = await assessRetrievalAnswerabilityWithLayeredAdmission(
      [outdated],
      "What is the retry budget in 2026?",
      new LayeredEvidenceAdmissionPipeline({
        semanticReader: semanticReader([outdated.excerpt]),
      }),
    );
    expect(assessment.supported).toBe(false);
    expect(assessment.supportedCandidateKeys).toEqual([]);
    expect(
      assessment.candidateSignals[0]?.queryConditionedEvidence,
    ).toMatchObject({
      verifierId: "layered-admission:STRUCTURAL_GUARD",
      decision: "INSUFFICIENT",
      reason: "STRUCTURAL_REQUIRED_FACT_MISSING",
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

  it("does not borrow an admitted quote across colliding unit identities or outside the read window", async () => {
    const original = hit("The retry budget is 3 attempts.");
    const stale = hit("The retry budget is 9 attempts.", {
      documentId: original.documentId,
      unitId: original.unitId,
      vaultId: original.vaultId,
      revision: "older-source-revision",
    });
    const separate = hit("The platform team documents deployment procedures.");
    const reader = semanticReader([original.excerpt]);
    const readBatch = vi.spyOn(reader, "readBatch");
    const assessment = await assessRetrievalAnswerabilityWithLayeredAdmission(
      [original, stale, separate],
      QUERY,
      new LayeredEvidenceAdmissionPipeline({ semanticReader: reader }),
      { maxCandidates: 1 },
    );
    expect(assessment.supported).toBe(false);
    expect(assessment.supportedCandidateKeys).toEqual([]);
    expect(assessment.candidateSignals.slice(0, 2)).toHaveLength(2);
    expect(
      assessment.candidateSignals
        .slice(0, 2)
        .map((signal) => signal.queryConditionedEvidence?.reason),
    ).toEqual([
      "LAYERED_CANDIDATE_KEY_COLLISION",
      "LAYERED_CANDIDATE_KEY_COLLISION",
    ]);
    expect(readBatch).not.toHaveBeenCalled();
    expect(
      assessment.candidateSignals[2]?.queryConditionedEvidence,
    ).toMatchObject({
      decision: "NOT_VERIFIED",
      reason: "LAYERED_ADMISSION_OUTSIDE_BOUNDED_WINDOW",
    });
  });

  it("still evaluates unrelated bounded candidates when another unit identity collides", async () => {
    const first = hit("The retry budget is 3 attempts.");
    const conflict = hit("The retry budget is 9 attempts.", {
      documentId: first.documentId,
      unitId: first.unitId,
      revision: "other-revision",
    });
    const clean = hit("The retry budget is 4 attempts.");
    const reader = semanticReader([first.excerpt, clean.excerpt]);
    const readBatch = vi.spyOn(reader, "readBatch");
    const result = await assessRetrievalAnswerabilityWithLayeredAdmission(
      [first, conflict, clean],
      QUERY,
      new LayeredEvidenceAdmissionPipeline({ semanticReader: reader }),
      { maxCandidates: 3 },
    );
    expect(result.supportedCandidateKeys).toEqual([
      retrievalAnswerabilityCandidateKey(clean),
    ]);
    expect(
      result.candidateSignals
        .slice(0, 2)
        .every(
          (signal) =>
            signal.queryConditionedEvidence?.reason ===
            "LAYERED_CANDIDATE_KEY_COLLISION",
        ),
    ).toBe(true);
    expect(readBatch).toHaveBeenCalledTimes(1);
    expect(readBatch.mock.calls[0]?.[0]).toHaveLength(1);
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
