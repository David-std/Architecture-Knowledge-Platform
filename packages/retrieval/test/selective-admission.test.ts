import { randomUUID } from "node:crypto";
import type { SearchHit } from "@akp/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ReaderEvidenceVerifier,
  type EvidenceReader,
} from "../src/evidence-reader.js";
import { assessRetrievalAnswerabilityWithLayeredAdmission } from "../src/layered-answerability.js";
import {
  evaluateOwnerEvidencePrecision,
  evaluateSelectiveQueryOutcomes,
} from "../src/selective-evaluation.js";

function candidate(document: string, unit: number, text: string) {
  return {
    query: "When does the rover sleep?",
    candidateKey: `${document}:${unit}`,
    title: "Rover",
    passage: text,
    unitType: "PARAGRAPH",
    parentUnitType: null,
    documentType: "rule",
  };
}

function hit(text: string, documentId: string): SearchHit {
  return {
    documentId,
    vaultId: randomUUID(),
    unitId: randomUUID(),
    unitType: "PARAGRAPH",
    document: {
      externalId: `doc-${randomUUID()}`,
      title: "Retry budget",
      path: "retry.md",
    },
    title: "Retry budget",
    type: "rule",
    revision: "synthetic",
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["synthetic"],
    excerpt: text,
    citations: [],
  };
}

describe("opt-in evidence admission mechanisms", () => {
  it("covers different documents without increasing the reader budget", async () => {
    const calls: string[] = [];
    const reader: EvidenceReader = {
      id: "fake",
      judge: async ({ body }) => {
        calls.push(body);
        return { answers: false, quote: "" };
      },
    };
    const scorer = {
      id: "fake-score",
      scoreBatch: async () => [0.99, 0.98, 0.97, 0.1],
    };
    const inputs = [
      candidate("alpha", 1, "First alpha unit."),
      candidate("alpha", 2, "Second alpha unit."),
      candidate("beta", 1, "First beta unit."),
      candidate("gamma", 1, "First gamma unit."),
    ];
    const verifier = new ReaderEvidenceVerifier({
      reader,
      shortlist: scorer,
      shortlistSize: 2,
      shortlistStrategy: "document-diverse",
    });
    const result = await verifier.verifyBatch(inputs);
    expect(
      result.filter((row) => row.reason === "READER_FOUND_NO_ANSWER"),
    ).toHaveLength(2);
    expect(calls).toEqual(["First alpha unit.", "First beta unit."]);
  });

  it("abstains if quote-only rereading cannot establish the answer", async () => {
    const statement = "Rover Echo sleeps after three dust alarms.";
    const judge = vi.fn(async ({ body }: { body: string }) => ({
      answers: body === statement && judge.mock.calls.length === 1,
      quote: statement,
    }));
    const verifier = new ReaderEvidenceVerifier({
      reader: { id: "fake", judge },
      confirmQuoteSufficiency: true,
    });
    const result = await verifier.verify(candidate("alpha", 1, statement));
    expect(result).toMatchObject({
      decision: "INSUFFICIENT",
      reason: "READER_QUOTE_SUFFICIENCY_NOT_DEMONSTRATED",
    });
    expect(judge).toHaveBeenCalledTimes(2);
    expect(judge.mock.calls[1]?.[0]).toEqual({
      query: "When does the rover sleep?",
      scope: "",
      body: statement.replace(/\.$/u, ""),
    });
  });

  it("fails closed if a second quote-only reader call throws", async () => {
    const reader: EvidenceReader = {
      id: "fake",
      judge: vi
        .fn()
        .mockResolvedValueOnce({
          answers: true,
          quote: "Rover Echo sleeps after three dust alarms.",
        })
        .mockRejectedValueOnce(new Error("offline")),
    };
    const verifier = new ReaderEvidenceVerifier({
      reader,
      confirmQuoteSufficiency: true,
    });
    expect(
      await verifier.verify(
        candidate("alpha", 1, "Rover Echo sleeps after three dust alarms."),
      ),
    ).toMatchObject({
      decision: "INSUFFICIENT",
      reason: "READER_QUOTE_SUFFICIENCY_ERROR",
    });
  });

  it("requires corroboration from distinct documents, not repeated units", async () => {
    const documentId = randomUUID();
    const pool = [
      hit("The retry budget is 3 attempts.", documentId),
      hit("The retry budget is 3 attempts per request.", documentId),
    ];
    const pipeline = {
      evaluateBatch: async (inputs: readonly { hit: SearchHit }[]) =>
        inputs.map(({ hit: item }) => ({
          layer: "SEMANTIC_READER" as const,
          verdict: {
            kind: "ANSWERS" as const,
            quote: { startOffset: 0, endOffset: item.excerpt.length },
          },
          readerId: "fake",
          reason: "READER_QUOTED_ANSWER",
        })),
    };
    const assessment = await assessRetrievalAnswerabilityWithLayeredAdmission(
      pool,
      "What is the retry budget?",
      pipeline,
      { minimumDistinctDocuments: 2 },
    );
    expect(assessment.supported).toBe(false);
    expect(assessment.supportedCandidateKeys).toEqual([]);
    expect(
      assessment.candidateSignals[0]?.queryConditionedEvidence?.decision,
    ).toBe("SUPPORTS");
  });

  it("abstains on conflicting admitted source-bound passages only when enabled", async () => {
    const pool = [
      hit("The retry budget is 3 attempts.", randomUUID()),
      hit("The retry budget is not 3 attempts.", randomUUID()),
    ];
    const pipeline = {
      evaluateBatch: async () => [
        {
          layer: "SEMANTIC_READER" as const,
          verdict: {
            kind: "ANSWERS" as const,
            quote: { startOffset: 0, endOffset: pool[0]!.excerpt.length },
          },
          reason: "READER_QUOTED_ANSWER",
        },
        {
          layer: "SEMANTIC_READER" as const,
          verdict: {
            kind: "CONTRADICTS" as const,
            quote: { startOffset: 0, endOffset: pool[1]!.excerpt.length },
          },
          reason: "SOURCE_CONTRADICTION",
        },
      ],
    };
    const baseline = await assessRetrievalAnswerabilityWithLayeredAdmission(
      pool,
      "What is the retry budget?",
      pipeline,
    );
    const strict = await assessRetrievalAnswerabilityWithLayeredAdmission(
      pool,
      "What is the retry budget?",
      pipeline,
      { abstainOnSourceConflict: true },
    );
    expect(baseline.supported).toBe(true);
    expect(strict.supported).toBe(false);
    expect(strict.supportedCandidateKeys).toEqual([]);
  });
});

describe("owner-grounded precision and risk/coverage accounting", () => {
  it("never reports evidence precision while a label is missing", () => {
    const result = evaluateOwnerEvidencePrecision([
      { evidenceId: "a", verdict: "ANSWERS" },
      { evidenceId: "b" },
    ]);
    expect(result.pending).toBe(1);
    expect(result.precision).toBeNull();
  });

  it("separates false admissions, coverage, and graded precision", () => {
    const partial = evaluateSelectiveQueryOutcomes([
      { queryId: "a", answerable: true, emitted: true },
      { queryId: "b", answerable: false, emitted: true },
      { queryId: "c", answerable: false, emitted: false },
    ]);
    expect(partial.coverage.rate).toBeCloseTo(2 / 3);
    expect(partial.negativeFalseAdmissionRate.rate).toBe(0.5);
    expect(partial.emittedAnswerPrecision).toBeNull();

    const graded = evaluateSelectiveQueryOutcomes([
      { queryId: "a", answerable: true, emitted: true, correct: true },
      { queryId: "b", answerable: false, emitted: true, correct: false },
      { queryId: "c", answerable: false, emitted: false },
    ]);
    expect(graded.emittedAnswerPrecision?.rate).toBe(0.5);
    expect(graded.emittedAnswerPrecision?.wilson95Lower).toBeLessThan(0.5);
  });
});

describe("bounded adaptive evidence reading", () => {
  function adaptiveInputs() {
    return [
      candidate("a", 1, "Related alert policy."),
      candidate("b", 1, "Related operational note."),
      candidate("c", 1, "Rover Echo sleeps after three dust alarms."),
      candidate("d", 1, "Another unrelated monitoring note."),
    ];
  }

  it("does not increase model calls once the first shortlist found a source answer", async () => {
    const calls: string[] = [];
    const reader: EvidenceReader = {
      id: "adaptive-fake",
      judge: async ({ body }) => {
        calls.push(body);
        return {
          answers: body === "Related alert policy.",
          quote: body,
        };
      },
    };
    const verifier = new ReaderEvidenceVerifier({
      reader,
      shortlist: {
        id: "ordered",
        scoreBatch: async () => [0.9, 0.8, 0.7, 0.6],
      },
      shortlistSize: 2,
      adaptiveMaxCandidates: 4,
    });
    const results = await verifier.verifyBatch(adaptiveInputs());
    expect(calls).toHaveLength(2);
    expect(results[0]?.decision).toBe("SUPPORTS");
    expect(results[2]?.reason).toBe("NOT_SHORTLISTED_FOR_READING");
  });

  it("reads additional candidates only when the initial shortlist is insufficient", async () => {
    const calls: string[] = [];
    const reader: EvidenceReader = {
      id: "adaptive-fake",
      judge: async ({ body }) => {
        calls.push(body);
        return {
          answers: body === "Rover Echo sleeps after three dust alarms.",
          quote: body,
        };
      },
    };
    const verifier = new ReaderEvidenceVerifier({
      reader,
      shortlist: {
        id: "ordered",
        scoreBatch: async () => [0.9, 0.8, 0.7, 0.6],
      },
      shortlistSize: 2,
      adaptiveMaxCandidates: 4,
    });
    const results = await verifier.verifyBatch(adaptiveInputs());
    expect(calls).toHaveLength(4);
    expect(results[2]?.decision).toBe("SUPPORTS");
  });

  it("does not amplify a reader outage into more calls", async () => {
    const judge = vi.fn(async () => {
      throw new Error("upstream unavailable");
    });
    const verifier = new ReaderEvidenceVerifier({
      reader: { id: "broken", judge },
      shortlistSize: 2,
      adaptiveMaxCandidates: 4,
    });
    const results = await verifier.verifyBatch(adaptiveInputs());
    expect(judge).toHaveBeenCalledTimes(2);
    expect(results[2]?.reason).toBe("NOT_SHORTLISTED_FOR_READING");
  });

  it("rejects invalid adaptive budgets at construction", () => {
    expect(
      () =>
        new ReaderEvidenceVerifier({
          reader: {
            id: "fake",
            judge: async () => ({ answers: false, quote: "" }),
          },
          shortlistSize: 4,
          adaptiveMaxCandidates: 3,
        }),
    ).toThrow("Reader adaptiveMaxCandidates");
  });
});

describe("exact quote replay", () => {
  it("checks the cited source bytes rather than a table-row restatement", async () => {
    const passage = "| Class | Deadline |\n|---|---|\n| II | 24 hours |";
    const calls: string[] = [];
    const reader: EvidenceReader = {
      id: "span-grounded",
      judge: async ({ body }) => {
        calls.push(body);
        return calls.length === 1
          ? {
              answers: true,
              quote: "Class: II; Deadline: 24 hours",
            }
          : { answers: false, quote: "" };
      },
    };
    const verifier = new ReaderEvidenceVerifier({
      reader,
      confirmQuoteSufficiency: true,
    });
    const result = await verifier.verify({
      ...candidate("table", 1, passage),
      query: "What is the Class II deadline?",
      title: "Recalls",
      unitType: "TABLE",
    });
    expect(result).toMatchObject({
      decision: "INSUFFICIENT",
      reason: "READER_QUOTE_SUFFICIENCY_NOT_DEMONSTRATED",
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe("II | 24 hours");
  });
});
