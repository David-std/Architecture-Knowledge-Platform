import type { SearchHit } from "@akp/contracts";
import { describe, expect, it } from "vitest";
import type {
  QueryConditionedEvidenceVerifier,
  QueryConditionedEvidenceVerification,
} from "../src/answerability.js";
import {
  LayeredEvidenceAdmissionPipeline,
  QueryConditionedSemanticEvidenceReader,
} from "../src/evidence-admission.js";
import { ReaderEvidenceVerifier } from "../src/evidence-reader.js";

const passage = "The retry budget is 3 attempts for each request.";
const question = "How many attempts are in the retry budget?";

function hit(id: string, excerpt = passage): SearchHit {
  return {
    documentId: id,
    vaultId: "11111111-1111-4111-8111-111111111111",
    revision: "snapshot-r1",
    document: {
      externalId: id,
      path: `policy/${id}.md`,
      title: id,
      aliases: [],
    },
    title: id,
    type: "concept",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["unit-test"],
    excerpt,
    citations: [],
  };
}

const supported: QueryConditionedEvidenceVerification = {
  decision: "SUPPORTS",
  evidenceSpan: { startOffset: 0, endOffset: passage.length },
  reason: "READER_QUOTED_ANSWER",
};

describe("bounded semantic batch preserves completed source-bound candidates", () => {
  it("salvages a verified success when a different candidate never completes", async () => {
    const verifier: QueryConditionedEvidenceVerifier = {
      id: "partial-injected",
      async verify() {
        throw new Error("must not retry");
      },
      async verifyBatch(_inputs, options) {
        options?.onCandidateCompleted?.(0, supported);
        return await new Promise<QueryConditionedEvidenceVerification[]>(
          () => {},
        );
      },
    };
    const pipeline = new LayeredEvidenceAdmissionPipeline({
      semanticReader: new QueryConditionedSemanticEvidenceReader({
        verifier,
        timeoutMs: 40,
      }),
    });
    const decisions = await pipeline.evaluateBatch([
      { query: question, hit: hit("first") },
      { query: question, hit: hit("slow", "A different unrelated claim.") },
    ]);
    expect(decisions.map((decision) => decision.verdict.kind)).toEqual([
      "ANSWERS",
      "INSUFFICIENT",
    ]);
    expect(decisions[0]).toMatchObject({
      layer: "SEMANTIC_READER",
      reason: "READER_QUOTED_ANSWER",
      verdict: { quote: { startOffset: 0, endOffset: passage.length } },
    });
    expect(decisions[1]?.reason).toContain("SEMANTIC_READER_TIMEOUT");
  });

  it("cannot salvage a forged span even if signaled before timeout", async () => {
    const verifier: QueryConditionedEvidenceVerifier = {
      id: "malformed-partial",
      async verify() {
        throw new Error("must not retry");
      },
      async verifyBatch(_inputs, options) {
        options?.onCandidateCompleted?.(0, {
          ...supported,
          evidenceSpan: { startOffset: 1000, endOffset: 1005 },
        });
        return await new Promise<QueryConditionedEvidenceVerification[]>(
          () => {},
        );
      },
    };
    const reader = new QueryConditionedSemanticEvidenceReader({
      verifier,
      timeoutMs: 40,
    });
    const decision = await reader.readBatch([
      {
        query: question,
        passage,
        candidateKey: "forged",
        title: "Forged",
        documentType: "concept",
        unitType: "PARAGRAPH",
        parentUnitType: null,
      },
    ]);
    expect(decision[0]?.verdict.kind).toBe("INSUFFICIENT");
    expect(decision[0]?.reason).toContain(
      "QUERY_CONDITIONED_EVIDENCE_SPAN_INVALID",
    );
  });

  it("does not salvage partial callbacks from a non-timeout verifier failure", async () => {
    const verifier: QueryConditionedEvidenceVerifier = {
      id: "failed-batch",
      async verify() {
        throw new Error("must not retry");
      },
      async verifyBatch(_inputs, options) {
        options?.onCandidateCompleted?.(0, supported);
        throw new Error("provider unexpected failure");
      },
    };
    const result = await new QueryConditionedSemanticEvidenceReader({
      verifier,
      timeoutMs: 40,
    }).readBatch([
      {
        query: question,
        passage,
        candidateKey: "failure",
        title: "Failed",
        documentType: "concept",
        unitType: "PARAGRAPH",
        parentUnitType: null,
      },
    ]);
    expect(result[0]?.verdict.kind).toBe("INSUFFICIENT");
    expect(result[0]?.reason).toContain("SEMANTIC_READER_ERROR");
  });

  it("transports actual parallel reader completions without another inference", async () => {
    const calls: string[] = [];
    const verifier = new ReaderEvidenceVerifier({
      reader: {
        id: "partial-source-quote",
        async judge({ body }) {
          calls.push(body);
          if (body.includes("unrelated")) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            return { answers: false, quote: "" };
          }
          return {
            answers: true,
            quote: passage,
            requestedFact: "the retry budget's number of attempts",
            extractedAnswer: "3",
          };
        },
      },
      shortlistSize: 2,
      concurrency: 2,
    });
    const semanticReader = new QueryConditionedSemanticEvidenceReader({
      verifier,
      timeoutMs: 60,
    });
    const decisions = await semanticReader.readBatch([
      {
        query: question,
        passage,
        candidateKey: "quick",
        title: "Retry",
        documentType: "concept",
        unitType: "PARAGRAPH",
        parentUnitType: null,
      },
      {
        query: question,
        passage: "An unrelated topic.",
        candidateKey: "slow",
        title: "Unrelated",
        documentType: "concept",
        unitType: "PARAGRAPH",
        parentUnitType: null,
      },
    ]);
    expect(decisions.map((row) => row.verdict.kind)).toEqual([
      "ANSWERS",
      "INSUFFICIENT",
    ]);
    expect(calls).toHaveLength(2);
    expect(decisions[0]).toMatchObject({
      verdict: {
        kind: "ANSWERS",
        answerEvidence: { kind: "LITERAL", answerText: "3" },
      },
    });
    expect(decisions[1]?.reason).toContain("SEMANTIC_READER_TIMEOUT");
  });
});
