import { randomUUID } from "node:crypto";
import type { SearchHit } from "@akp/contracts";
import { describe, expect, it } from "vitest";
import { ReaderEvidenceVerifier } from "../src/evidence-reader.js";
import {
  LayeredEvidenceAdmissionPipeline,
  QueryConditionedSemanticEvidenceReader,
  StructuralEvidenceGuard,
} from "../src/evidence-admission.js";
import { validateSourceBoundVerification } from "../src/source-verification.js";
import { uniqueSourceAnswerValueSpan } from "../src/answer-value-evidence.js";

const example = "📚 The B3 release requires tres security approvals.";
const span = { startOffset: 0, endOffset: example.length };
const principalHit = (): SearchHit => ({
  documentId: randomUUID(),
  vaultId: randomUUID(),
  unitId: randomUUID(),
  unitType: "PARAGRAPH",
  document: { path: "policies/b3.md", title: "B3 policy" },
  revision: "sha-pinned:rev-a",
  title: "B3 policy",
  type: "rule",
  trust: "MACHINE_SUPPORTED",
  lifecycle: "ACTIVE",
  refreshStatus: "CURRENT",
  score: 1,
  reasons: ["exact"],
  excerpt: example,
  citations: [],
});

const model = (answer: string, quoted = example) =>
  new ReaderEvidenceVerifier({
    reader: {
      id: "v5-relation-proposal",
      judge: async () => ({
        answers: true,
        quote: quoted,
        requestedFact:
          "B3 required number of security approvals before release",
        extractedAnswer: answer,
      }),
    },
  });

describe("single retrieval answer-slot provenance contract", () => {
  it("keeps a full UTF-16 value slot from structured reader into layered admission", async () => {
    const reader = model("tres");
    const proposed = await reader.verify({
      query: "¿Cuántas aprobaciones de seguridad exige B3?",
      candidateKey: "b3:rA",
      title: "B3 policy",
      passage: example,
      documentType: "rule",
      unitType: "PARAGRAPH",
      parentUnitType: null,
    });
    expect(proposed).toMatchObject({
      decision: "SUPPORTS",
      answerEvidence: {
        kind: "LITERAL",
        answerText: "tres",
        requestedFact:
          "B3 required number of security approvals before release",
      },
    });
    const value = proposed.answerEvidence!.valueSpan!;
    expect(example.slice(value.startOffset, value.endOffset)).toBe("tres");
    expect(value.startOffset).toBe(example.indexOf("tres"));
    expect(proposed.evidenceSpan?.startOffset).toBe(0);
    expect(proposed.evidenceSpan?.endOffset).toBeLessThanOrEqual(
      example.length,
    );
    expect(
      example.slice(
        proposed.evidenceSpan!.startOffset,
        proposed.evidenceSpan!.endOffset,
      ),
    ).toContain("tres security approvals");
    const validated = validateSourceBoundVerification(example, proposed);
    expect(validated.answerEvidence).toEqual(proposed.answerEvidence);
    const pipeline = new LayeredEvidenceAdmissionPipeline({
      semanticReader: new QueryConditionedSemanticEvidenceReader({
        verifier: reader,
      }),
    });
    const decision = await pipeline.evaluate({
      query: "¿Cuántas aprobaciones de seguridad exige B3?",
      hit: principalHit(),
    });
    // This stage still uses the existing digit-only quantitative guard.
    // Byte binding alone MUST NOT bypass that rule or assert full entailment.
    expect(decision).toMatchObject({
      layer: "STRUCTURAL_GUARD",
      verdict: { kind: "INSUFFICIENT" },
      reason: "STRUCTURAL_REQUIRED_FACT_MISSING",
    });
  });

  it("does not anchor a count inside a hyphenated document identifier", () => {
    const quote = "Faro-6 requires reviewer approval.";
    expect(uniqueSourceAnswerValueSpan(quote, "6", 0)).toBeNull();
    expect(uniqueSourceAnswerValueSpan(quote, "reviewer", 0)).not.toBeNull();
  });

  it("does not map three to 3 or a partial long identifier", () => {
    expect(uniqueSourceAnswerValueSpan(example, "3", 0)).toBeNull();
    expect(
      uniqueSourceAnswerValueSpan(
        "TracerProvider manages tracing.",
        "Tracer",
        0,
      ),
    ).toBeNull();
  });

  it("accepts only deterministic canonical unicode/case/whitespace equivalence", () => {
    const quote = "The café  renewal\n policy is effective.";
    const value = uniqueSourceAnswerValueSpan(
      quote,
      "cafe\u0301 renewal policy",
      17,
    );
    expect(value).not.toBeNull();
    expect(quote.slice(value!.startOffset - 17, value!.endOffset - 17)).toBe(
      "café  renewal\n policy",
    );
  });

  it("rejects tampered source value offsets, fabricated value, and repeated occurrences", () => {
    const record = {
      decision: "SUPPORTS",
      reason: "proposed",
      evidenceSpan: span,
      answerEvidence: {
        kind: "LITERAL",
        requestedFact: "B3 review count",
        answerText: "tres",
        valueSpan: {
          startOffset: example.indexOf("tres"),
          endOffset: example.indexOf("tres") + 4,
        },
      },
    };
    expect(
      validateSourceBoundVerification(example, record).answerEvidence,
    ).toEqual(record.answerEvidence);
    for (const corrupted of [
      {
        ...record,
        answerEvidence: { ...record.answerEvidence, answerText: "six" },
      },
      {
        ...record,
        answerEvidence: {
          ...record.answerEvidence,
          valueSpan: { startOffset: 0, endOffset: 4 },
        },
      },
      {
        ...record,
        answerEvidence: {
          ...record.answerEvidence,
          valueSpan: { startOffset: 1, endOffset: 3 },
        },
      },
    ]) {
      expect(() => validateSourceBoundVerification(example, corrupted)).toThrow(
        "QUERY_CONDITIONED_ANSWER_EVIDENCE_INVALID",
      );
    }
    const duplicate = "three approvals. Three approvals. three approvals.";
    expect(uniqueSourceAnswerValueSpan(duplicate, "three", 0)).toBeNull();
  });

  it("refuses answer evidence on CONTRADICTS or INSUFFICIENT, and preserves polarity separately", () => {
    const base = {
      decision: "SUPPORTS",
      reason: "proposed",
      evidenceSpan: span,
      answerEvidence: {
        kind: "POLARITY",
        requestedFact: "Can B3 ship without review?",
        answerText: "No",
      },
    };
    expect(
      validateSourceBoundVerification(example, base).answerEvidence,
    ).toMatchObject({
      kind: "POLARITY",
      answerText: "No",
    });
    for (const decision of ["CONTRADICTS", "INSUFFICIENT"]) {
      expect(() =>
        validateSourceBoundVerification(example, {
          ...base,
          decision,
          ...(decision === "INSUFFICIENT" ? { evidenceSpan: undefined } : {}),
        }),
      ).toThrow("QUERY_CONDITIONED_ANSWER_EVIDENCE_INVALID");
    }
    const guard = new StructuralEvidenceGuard();
    const fake = {
      kind: "ANSWERS" as const,
      quote: span,
      answerEvidence: {
        kind: "LITERAL" as const,
        requestedFact: "B3 review count",
        answerText: "six",
        valueSpan: {
          startOffset: example.indexOf("tres"),
          endOffset: example.indexOf("tres") + 4,
        },
      },
    };
    expect(
      guard.constrainVerdict(
        principalHit(),
        "What is the B3 review count?",
        fake,
      ),
    ).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_ANSWER_SLOT_INVALID",
    });
  });
});
