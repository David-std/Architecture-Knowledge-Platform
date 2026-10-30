import { randomUUID } from "node:crypto";
import type { SearchHit } from "@akp/contracts";
import { describe, expect, it } from "vitest";
import { exactSourceCardinalWord } from "../src/answer-value-evidence.js";
import {
  LayeredEvidenceAdmissionPipeline,
  QueryConditionedSemanticEvidenceReader,
  StructuralEvidenceGuard,
} from "../src/evidence-admission.js";
import { ReaderEvidenceVerifier } from "../src/evidence-reader.js";

function hit(body: string): SearchHit {
  return {
    documentId: randomUUID(),
    vaultId: randomUUID(),
    unitId: randomUUID(),
    unitType: "PARAGRAPH",
    document: {
      externalId: "Faro-6",
      path: "policy/faro-6.md",
      title: "Faro-6",
      aliases: [],
    },
    revision: "fixed-test-r1",
    title: "Faro-6",
    type: "concept",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["test"],
    excerpt: body,
    citations: [],
  };
}
function typedVerdict(body: string, quote: string, value: string) {
  const startOffset = body.indexOf(quote);
  const valueStart = body.indexOf(value, startOffset);
  return {
    kind: "ANSWERS" as const,
    quote: { startOffset, endOffset: startOffset + quote.length },
    answerEvidence: {
      kind: "LITERAL" as const,
      requestedFact: "the exact count of reviewers for the same B3 release",
      answerText: value,
      valueSpan: {
        startOffset: valueStart,
        endOffset: valueStart + value.length,
      },
    },
  };
}

describe("exact cardinal word values in a source-verified v5 answer slot", () => {
  it("recognizes only whole small cardinal values, not headings, IDs, ordinals or estimates", () => {
    expect(exactSourceCardinalWord("tres")).toBe(3);
    expect(exactSourceCardinalWord("THREE")).toBe(3);
    expect(exactSourceCardinalWord("dieciséis")).toBe(16);
    expect(exactSourceCardinalWord("dieciseis")).toBe(16);
    for (const invalid of [
      "three reviewers",
      "some three",
      "thirty",
      "tres veces",
      "Faro-6",
      "6",
      "tercero",
      "third",
      "approximately three",
      "one-hundred",
      "",
    ]) {
      expect(exactSourceCardinalWord(invalid)).toBeNull();
    }
  });

  it("repairs the exact Qwen3.5 Spanish Faro-6 citation without accepting a document ID as the count", async () => {
    const body =
      "Faro-6 permite distribuir B3 únicamente cuando tres revisores de seguridad aprueban exactamente la misma versión. Una revisión pendiente bloquea la distribución.";
    const quote = body.slice(0, body.indexOf(".") + 1);
    const current = hit(body);
    const question =
      "¿Cuántos revisores deben aprobar la misma versión para distribuir B3 en Faro-6?";
    const guard = new StructuralEvidenceGuard();
    expect(
      guard.constrainVerdict(
        current,
        question,
        typedVerdict(body, quote, "tres"),
      ),
    ).toMatchObject({
      accepted: true,
      verdict: {
        kind: "ANSWERS",
        answerEvidence: { kind: "LITERAL", answerText: "tres" },
      },
    });

    const badValue = typedVerdict(body, quote, "6");
    expect(guard.constrainVerdict(current, question, badValue)).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_ANSWER_SLOT_INVALID",
    });

    const noSlot = {
      kind: "ANSWERS" as const,
      quote: typedVerdict(body, quote, "tres").quote,
    };
    expect(guard.constrainVerdict(current, question, noSlot)).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_REQUIRED_FACT_MISSING",
    });

    const unbound = typedVerdict(body, quote, "tres");
    expect(
      guard.constrainVerdict(current, question, {
        ...unbound,
        answerEvidence: {
          ...unbound.answerEvidence,
          valueSpan: { startOffset: 0, endOffset: 4 },
        },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_ANSWER_SLOT_INVALID",
    });
  });

  it("fails closed for wrong monthly scope, multiple copies and a mere document name", () => {
    const guard = new StructuralEvidenceGuard();
    const body = "Faro-6 requiere tres revisores de seguridad.";
    const quote = body;
    expect(
      guard.constrainVerdict(
        hit(body),
        "¿Cuántos revisores se requieren por mes?",
        typedVerdict(body, quote, "tres"),
      ),
    ).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_REQUIRED_FACT_MISSING",
    });
    const duplicated =
      "El primer control exige tres revisores, pero el segundo exige tres observadores.";
    expect(
      guard.constrainVerdict(
        hit(duplicated),
        "¿Cuántos revisores exige el primer control?",
        typedVerdict(duplicated, duplicated, "tres"),
      ),
    ).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_ANSWER_SLOT_INVALID",
    });
    const nameOnly = "Proyecto Tres es una etiqueta.";
    expect(
      guard.constrainVerdict(
        hit(nameOnly),
        "¿Cuántas personas debe aprobar la solicitud?",
        {
          kind: "ANSWERS",
          quote: { startOffset: 0, endOffset: nameOnly.length },
        },
      ),
    ).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_REQUIRED_FACT_MISSING",
    });
  });

  it("preserves numeric 3, wrong year and ordinal protections", () => {
    const guard = new StructuralEvidenceGuard();
    const numeric = "Faro-6 requires 3 security reviewers in 2025.";
    expect(
      guard.constrainVerdict(
        hit(numeric),
        "How many security reviewers are required in 2025?",
        typedVerdict(numeric, numeric, "3"),
      ),
    ).toMatchObject({ accepted: true, verdict: { kind: "ANSWERS" } });
    expect(
      guard.constrainVerdict(
        hit(numeric),
        "How many security reviewers are required in 2026?",
        typedVerdict(numeric, numeric, "3"),
      ),
    ).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_REQUIRED_FACT_MISSING",
    });
    const numbered = "3. Rotate the keys.";
    expect(
      guard.constrainVerdict(hit(numbered), "How many keys are active?", {
        kind: "ANSWERS",
        quote: { startOffset: 0, endOffset: 1 },
      }),
    ).toMatchObject({
      accepted: false,
      reason: "STRUCTURAL_REQUIRED_FACT_MISSING",
    });
  });

  it("retains typed source value through real reader → pipeline → structural guard", async () => {
    const body =
      "Faro-6 permite distribuir B3 únicamente cuando tres revisores de seguridad aprueban exactamente la misma versión.";
    const reader = new ReaderEvidenceVerifier({
      reader: {
        id: "fixed-v5-reader",
        async judge() {
          return {
            answers: true,
            quote: body,
            requestedFact: "the count of security reviewers for releasing B3",
            extractedAnswer: "tres",
          };
        },
      },
      requireExtractedAnswerInQuote: true,
    });
    const pipeline = new LayeredEvidenceAdmissionPipeline({
      semanticReader: new QueryConditionedSemanticEvidenceReader({
        verifier: reader,
      }),
    });
    const decision = await pipeline.evaluate({
      query: "¿Cuántos revisores de seguridad deben aprobar B3?",
      hit: hit(body),
    });
    expect(decision).toMatchObject({
      layer: "SEMANTIC_READER",
      verdict: {
        kind: "ANSWERS",
        answerEvidence: { kind: "LITERAL", answerText: "tres" },
      },
      reason: "READER_QUOTED_ANSWER",
    });
  });
});
