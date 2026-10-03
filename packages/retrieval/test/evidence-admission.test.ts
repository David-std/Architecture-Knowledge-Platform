import { randomUUID } from "node:crypto";
import type { SearchHit } from "@akp/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  ExactStructuredPropositionMatcher,
  LayeredEvidenceAdmissionPipeline,
  QueryConditionedSemanticEvidenceReader,
  StructuralEvidenceGuard,
  type SemanticEvidenceReader,
} from "../src/evidence-admission.js";
import type { QueryConditionedEvidenceVerifier } from "../src/answerability.js";

function hit(overrides: Partial<SearchHit> = {}): SearchHit {
  const base: SearchHit = {
    documentId: randomUUID(),
    vaultId: randomUUID(),
    unitId: randomUUID(),
    unitType: "PARAGRAPH",
    document: {
      externalId: "ADR-42",
      path: "architecture/adr-42.md",
      title: "ADR-42",
      aliases: ["decision-42"],
    },
    revision: "r5-test",
    title: "ADR-42",
    type: "decision-rule",
    trust: "MACHINE_SUPPORTED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["test"],
    excerpt: "The retry budget is 3 attempts in 2026.",
    citations: [],
  };
  return { ...base, ...overrides };
}

describe("R5 layered evidence admission boundaries", () => {
  it("matches only explicit structured propositions without semantic guessing", () => {
    const matcher = new ExactStructuredPropositionMatcher();
    const quote = { startOffset: 0, endOffset: 12 };

    expect(
      matcher.match({
        query: {
          subject: "policy:retry",
          predicate: "max_attempts",
          object: "3",
        },
        candidate: {
          subject: "policy:retry",
          predicate: "max_attempts",
          object: "3",
          quote,
        },
      }),
    ).toEqual({ kind: "ANSWERS", quote });

    expect(
      matcher.match({
        query: {
          subject: "policy:retry",
          predicate: "max_attempts",
          object: "3",
        },
        candidate: {
          subject: "policy:retry",
          predicate: "minimum_attempts",
          object: "3",
          quote,
        },
      }),
    ).toEqual({ kind: "INSUFFICIENT" });

    expect(
      matcher.match({
        query: {
          subject: "policy:retry",
          predicate: "enabled",
          polarity: "POSITIVE",
        },
        candidate: {
          subject: "policy:retry",
          predicate: "enabled",
          polarity: "NEGATIVE",
          quote,
        },
      }),
    ).toEqual({ kind: "CONTRADICTS", quote });
  });

  it("rejects hidden, interrogative and wrong-year source spans", () => {
    const guard = new StructuralEvidenceGuard();

    const hidden = hit({
      excerpt: "Visible fact. <!-- secret 2026 -->",
    });
    expect(
      guard.constrainVerdict(hidden, "Which year?", {
        kind: "ANSWERS",
        quote: { startOffset: 16, endOffset: hidden.excerpt.length - 4 },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_HIDDEN_SOURCE_SPAN",
      verdict: { kind: "INSUFFICIENT" },
    });

    const question = hit({ excerpt: "Is the retry budget three?" });
    expect(
      guard.constrainVerdict(question, "What is the retry budget?", {
        kind: "ANSWERS",
        quote: { startOffset: 0, endOffset: question.excerpt.length },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_NON_ASSERTION_SPAN",
    });

    const wrongYear = hit({
      excerpt: "The retry budget is 3 attempts in 2025.",
    });
    expect(
      guard.constrainVerdict(wrongYear, "What is the retry budget in 2026?", {
        kind: "ANSWERS",
        quote: { startOffset: 0, endOffset: wrongYear.excerpt.length },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_REQUIRED_FACT_MISSING",
    });
  });

  it("keeps selected table cells inside their header/year scope", () => {
    const guard = new StructuralEvidenceGuard();
    const passage = [
      "| Year | Retry budget |",
      "| --- | --- |",
      "| 2025 | 2 |",
      "| 2026 | 3 |",
    ].join("\n");
    const tableHit = hit({ excerpt: passage });
    const rowStart = passage.indexOf("| 2026 |");
    const rowEnd = passage.length;

    expect(
      guard.constrainVerdict(tableHit, "What is the retry budget in 2026?", {
        kind: "ANSWERS",
        quote: { startOffset: rowStart, endOffset: rowEnd },
      }),
    ).toMatchObject({
      accepted: true,
      reason: "STRUCTURAL_SOURCE_SPAN_VALID",
      verdict: { kind: "ANSWERS" },
    });
  });

  it("fails semantic reader timeout and spanless contradiction closed", async () => {
    const never = new Promise<never>(() => undefined);
    const timeoutVerifier: QueryConditionedEvidenceVerifier = {
      id: "timeout-verifier",
      verify: async () => never,
    };
    const timeoutReader = new QueryConditionedSemanticEvidenceReader({
      verifier: timeoutVerifier,
      timeoutMs: 10,
    });
    await expect(
      timeoutReader.read({
        query: "Can A call B?",
        candidateKey: "candidate",
        title: "A",
        passage: "A can call B.",
        unitType: "CLAIM",
        parentUnitType: null,
        documentType: "claim",
      }),
    ).resolves.toMatchObject({
      verdict: { kind: "INSUFFICIENT" },
      reason: "SEMANTIC_READER_ERROR:SEMANTIC_READER_TIMEOUT",
    });

    const contradictionReader = new QueryConditionedSemanticEvidenceReader({
      verifier: {
        id: "spanless-contradiction",
        verify: async () => ({
          decision: "CONTRADICTS",
          reason: "MODEL_SAYS_CONTRADICTS",
        }),
      },
    });
    await expect(
      contradictionReader.read({
        query: "Can A call B?",
        candidateKey: "candidate",
        title: "A",
        passage: "B cannot be called by A.",
        unitType: "CLAIM",
        parentUnitType: null,
        documentType: "claim",
      }),
    ).resolves.toMatchObject({
      verdict: { kind: "INSUFFICIENT" },
      reason: "SEMANTIC_CONTRADICTION_WITHOUT_SOURCE_SPAN",
    });
  });

  it("admits a source-bound contradiction and rejects hidden UTF-16 source", async () => {
    const passage = "😀 Visible fact. <!-- hidden 🔒 denial -->";
    const reader = new QueryConditionedSemanticEvidenceReader({
      verifier: {
        id: "contradiction-reader",
        verify: async () => ({
          decision: "CONTRADICTS",
          evidenceSpan: { startOffset: 0, endOffset: passage.indexOf("<!--") },
          reason: "visible contradiction",
        }),
      },
    });
    await expect(
      reader.read({
        query: "What is the fact?",
        candidateKey: "candidate",
        title: "Source boundary",
        passage,
        unitType: "CLAIM",
        parentUnitType: null,
        documentType: "claim",
      }),
    ).resolves.toMatchObject({
      verdict: {
        kind: "CONTRADICTS",
        quote: { startOffset: 0, endOffset: passage.indexOf("<!--") },
      },
      reason: "visible contradiction",
    });

    const hiddenStart = passage.indexOf("<!--");
    const hiddenReader = new QueryConditionedSemanticEvidenceReader({
      verifier: {
        id: "hidden-contradiction-reader",
        verify: async () => ({
          decision: "CONTRADICTS",
          evidenceSpan: {
            startOffset: hiddenStart + 4,
            endOffset: hiddenStart + 15,
          },
          reason: "hidden contradiction",
        }),
      },
    });
    await expect(
      hiddenReader.read({
        query: "What is the fact?",
        candidateKey: "candidate",
        title: "Source boundary",
        passage,
        unitType: "CLAIM",
        parentUnitType: null,
        documentType: "claim",
      }),
    ).resolves.toMatchObject({
      verdict: { kind: "INSUFFICIENT" },
      reason:
        "SEMANTIC_READER_ERROR:QUERY_CONDITIONED_EVIDENCE_SPAN_HIDDEN_SOURCE",
    });
  });

  it("rejects R5 spans that split an astral code point", async () => {
    const passage = "😀 fact";
    const input = {
      query: "What is the fact?",
      candidateKey: "candidate",
      title: "Surrogate boundary",
      passage,
      unitType: "CLAIM",
      parentUnitType: null,
      documentType: "claim",
    } as const;
    const reader = new QueryConditionedSemanticEvidenceReader({
      verifier: {
        id: "surrogate-reader",
        verify: async (candidate) => {
          const span =
            candidate.query === "first"
              ? { startOffset: 0, endOffset: 1 }
              : candidate.query === "second"
                ? { startOffset: 1, endOffset: 2 }
                : { startOffset: 0, endOffset: 2 };
          return {
            decision: "SUPPORTS" as const,
            evidenceSpan: span,
            reason: "source-bound fixture",
          };
        },
      },
    });

    await expect(
      reader.read({ ...input, query: "first" }),
    ).resolves.toMatchObject({
      verdict: { kind: "INSUFFICIENT" },
      reason: "SEMANTIC_READER_ERROR:QUERY_CONDITIONED_EVIDENCE_SPAN_INVALID",
    });
    await expect(
      reader.read({ ...input, query: "second" }),
    ).resolves.toMatchObject({
      verdict: { kind: "INSUFFICIENT" },
      reason: "SEMANTIC_READER_ERROR:QUERY_CONDITIONED_EVIDENCE_SPAN_INVALID",
    });
    await expect(
      reader.read({ ...input, query: "valid" }),
    ).resolves.toMatchObject({
      verdict: { kind: "ANSWERS", quote: { startOffset: 0, endOffset: 2 } },
      reason: "source-bound fixture",
    });

    const guard = new StructuralEvidenceGuard();
    const candidate = hit({ excerpt: passage });
    expect(
      guard.constrainVerdict(candidate, "What is the fact?", {
        kind: "ANSWERS",
        quote: { startOffset: 1, endOffset: 2 },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_SOURCE_SPAN_INVALID",
    });
    expect(
      guard.constrainVerdict(candidate, "What is the fact?", {
        kind: "ANSWERS",
        quote: { startOffset: 0, endOffset: 2 },
      }),
    ).toMatchObject({
      accepted: true,
      verdict: { kind: "ANSWERS", quote: { startOffset: 0, endOffset: 2 } },
    });
  });

  it("keeps malformed batch rows isolated and closes batch failures", async () => {
    const inputs = [
      {
        query: "What is fact one?",
        candidateKey: "one",
        title: "One",
        passage: "Fact one.",
        unitType: "CLAIM",
        parentUnitType: null,
        documentType: "claim",
      },
      {
        query: "What is fact two?",
        candidateKey: "two",
        title: "Two",
        passage: "Fact two.",
        unitType: "CLAIM",
        parentUnitType: null,
        documentType: "claim",
      },
    ] as const;
    const reader = new QueryConditionedSemanticEvidenceReader({
      verifier: {
        id: "row-bounded-reader",
        verifyBatch: async () =>
          [
            {
              decision: "SUPPORTS",
              evidenceSpan: {
                startOffset: 0,
                endOffset: inputs[0].passage.length,
              },
              reason: "first source",
            },
            {
              decision: "UNKNOWN",
              evidenceSpan: {
                startOffset: 0,
                endOffset: inputs[1].passage.length,
              },
              reason: "malformed second row",
            },
          ] as never,
        verify: async () => ({
          decision: "INSUFFICIENT",
          reason: "single-row fallback",
        }),
      },
    });
    await expect(reader.readBatch(inputs)).resolves.toMatchObject([
      { verdict: { kind: "ANSWERS" }, reason: "first source" },
      {
        verdict: { kind: "INSUFFICIENT" },
        reason:
          "SEMANTIC_READER_ERROR:QUERY_CONDITIONED_EVIDENCE_DECISION_INVALID",
      },
    ]);

    const batchFailureReader = new QueryConditionedSemanticEvidenceReader({
      verifier: {
        id: "batch-size-reader",
        verifyBatch: async () => [],
        verify: async () => ({
          decision: "INSUFFICIENT",
          reason: "single-row fallback",
        }),
      },
    });
    await expect(batchFailureReader.readBatch(inputs)).resolves.toMatchObject([
      {
        verdict: { kind: "INSUFFICIENT" },
        reason:
          "SEMANTIC_READER_ERROR:QUERY_CONDITIONED_EVIDENCE_BATCH_SIZE_MISMATCH",
      },
      {
        verdict: { kind: "INSUFFICIENT" },
        reason:
          "SEMANTIC_READER_ERROR:QUERY_CONDITIONED_EVIDENCE_BATCH_SIZE_MISMATCH",
      },
    ]);
  });

  it("handles null results and null input without exposing provider failures", async () => {
    const reader = new QueryConditionedSemanticEvidenceReader({
      verifier: {
        id: "null-reader",
        verify: async () => null as never,
      },
    });
    await expect(
      reader.read({
        query: "What is the fact?",
        candidateKey: "candidate",
        title: "Source boundary",
        passage: "Fact.",
        unitType: "CLAIM",
        parentUnitType: null,
        documentType: "claim",
      }),
    ).resolves.toMatchObject({
      verdict: { kind: "INSUFFICIENT" },
      reason: "SEMANTIC_READER_ERROR:QUERY_CONDITIONED_EVIDENCE_RESULT_INVALID",
    });

    await expect(reader.read(null as never)).resolves.toMatchObject({
      verdict: { kind: "INSUFFICIENT" },
      reason: "SEMANTIC_READER_ERROR:QUERY_CONDITIONED_EVIDENCE_INPUT_INVALID",
    });

    const secret = "source-bytes https://user:password@example.invalid/private";
    const failingReader = new QueryConditionedSemanticEvidenceReader({
      verifier: {
        id: "provider-failure-reader",
        verify: async () => {
          throw new Error(secret);
        },
      },
    });
    const result = await failingReader.read({
      query: "What is the fact?",
      candidateKey: "candidate",
      title: "Source boundary",
      passage: "Fact.",
      unitType: "CLAIM",
      parentUnitType: null,
      documentType: "claim",
    });
    expect(result).toMatchObject({
      verdict: { kind: "INSUFFICIENT" },
      reason: "SEMANTIC_READER_ERROR:QUERY_CONDITIONED_EVIDENCE_VERIFIER_ERROR",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("lets the structural guard veto a semantic support proposal", async () => {
    const semanticReader: SemanticEvidenceReader = {
      id: "fixture-reader",
      read: vi.fn(async () => ({
        layer: "SEMANTIC_READER" as const,
        verdict: {
          kind: "ANSWERS" as const,
          quote: { startOffset: 0, endOffset: 38 },
        },
        reason: "FIXTURE_SUPPORT",
        readerId: "fixture-reader",
      })),
    };
    const pipeline = new LayeredEvidenceAdmissionPipeline({ semanticReader });
    const candidate = hit({
      excerpt: "The retry budget is 3 attempts in 2025.",
    });

    await expect(
      pipeline.evaluate({
        query: "What is the retry budget in 2026?",
        hit: candidate,
      }),
    ).resolves.toMatchObject({
      layer: "SEMANTIC_READER",
      verdict: { kind: "INSUFFICIENT" },
      reason: "STRUCTURAL_REQUIRED_FACT_MISSING",
    });
  });
});
