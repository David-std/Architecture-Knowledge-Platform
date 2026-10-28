import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SearchHit } from "@akp/contracts";
import {
  LayeredEvidenceAdmissionPipeline,
  type StructuredPropositionQuery,
} from "../src/evidence-admission.js";
import { type GovernedLayeredPropositionProof } from "../src/layered-answerability.js";
import {
  auditGovernedWriterStatements,
  type GovernedWriterStatement,
} from "../src/governed-writer-claims.js";
import { retrievalAnswerabilityCandidateKey } from "../src/answerability.js";

const sha = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
const question = "Did Lira approve the index on 2026-09-13 after inspection?";
const sourceText = "Lira approved the index on 2026-09-13 after inspection.";
const proposition: StructuredPropositionQuery = {
  subject: "Lira",
  predicate: "approved",
  object: "the index",
  polarity: "POSITIVE",
  temporalScope: "2026-09-13",
  conditions: ["after inspection"],
};

function hit(): SearchHit {
  return {
    documentId: randomUUID(),
    vaultId: randomUUID(),
    unitId: randomUUID(),
    unitType: "PARAGRAPH",
    document: {
      externalId: "synthetic",
      path: "synthetic/source.md",
      title: "Original source",
    },
    revision: "revision-A",
    title: "Original source",
    type: "claim",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["fixture"],
    excerpt: sourceText,
    citations: [],
  };
}
function proof(candidate: SearchHit): GovernedLayeredPropositionProof {
  const raw = "HEADER\n" + candidate.excerpt + "\nFOOTER";
  return {
    originalQuestion: question,
    originalQuestionSha256: sha(question),
    candidateKey: retrievalAnswerabilityCandidateKey(candidate),
    documentId: candidate.documentId,
    unitId: candidate.unitId ?? null,
    vaultId: candidate.vaultId,
    revision: candidate.revision,
    path: candidate.document.path,
    originalSourceBytes: new TextEncoder().encode(raw),
    originalSourceText: raw,
    originalSourceSha256: sha(raw),
    excerptStartUtf16: "HEADER\n".length,
    excerptEndUtf16: "HEADER\n".length + candidate.excerpt.length,
    queryProposition: proposition,
    candidateProposition: {
      ...proposition,
      quote: { startOffset: 0, endOffset: candidate.excerpt.length },
    },
  };
}
function context() {
  const candidate = hit();
  const reader = vi.fn(async () => {
    throw Error("Reader must not decide a governed relation");
  });
  const pipeline = new LayeredEvidenceAdmissionPipeline({
    semanticReader: { id: "forbidden-reader", read: reader },
  });
  return {
    candidate,
    reader,
    pipeline,
    port: { resolve: vi.fn(async () => proof(candidate)) },
  };
}
function statement(
  candidate: SearchHit,
  text = sourceText,
): GovernedWriterStatement {
  return {
    text,
    startUtf16: 0,
    endUtf16: text.length,
    citedCandidateKey: retrievalAnswerabilityCandidateKey(candidate),
    citationId: "SRC1",
    citedHit: candidate,
    statementProposition: proposition,
  };
}

describe("original-question to SOURCE to every Writer statement, candidate-only", () => {
  it("preserves original question and SOURCE custody through the same R5 admission owner", async () => {
    const c = context();
    const result = await auditGovernedWriterStatements({
      originalQuestion: question,
      answerText: sourceText,
      statements: [statement(c.candidate)],
      governedPropositionPort: c.port,
      admissionPipeline: c.pipeline,
    });
    expect(result).toMatchObject({
      status: "SOURCE_BOUND_CLAIMS_CANDIDATE",
      testedClaims: 1,
      totalClaims: 1,
      sourceCitations: [
        {
          citationId: "SRC1",
          originalSourceSha256: proof(c.candidate).originalSourceSha256,
        },
      ],
      fullyAtomicIndependentlyVerified: false,
      fullQuestionCoverageIndependentlyVerified: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    });
    expect(c.reader).not.toHaveBeenCalled();
    expect(c.port.resolve).toHaveBeenCalledWith({
      originalQuestion: question,
      hit: c.candidate,
    });
  });

  it.each([
    ["actor", { subject: "Miro" }],
    ["direction", { subject: "the index", object: "Lira" }],
    ["predicate", { predicate: "rejected" }],
    ["polarity", { polarity: "NEGATIVE" as const }],
    ["event date", { temporalScope: "2026-09-12" }],
    ["missing condition", { conditions: [] }],
  ])("withholds a Writer claim with the wrong %s", async (_name, change) => {
    const c = context();
    const result = await auditGovernedWriterStatements({
      originalQuestion: question,
      answerText: sourceText,
      statements: [
        {
          ...statement(c.candidate),
          statementProposition: { ...proposition, ...change },
        },
      ],
      governedPropositionPort: c.port,
      admissionPipeline: c.pipeline,
    });
    expect(result).toMatchObject({
      status: "WITHHELD_WRITER_STATEMENT",
      firstRejectedClaim: 0,
      productionAdmission: false,
    });
    expect(c.reader).not.toHaveBeenCalled();
  });

  it("requires each cited statement, not only one supported lead sentence", async () => {
    const c = context();
    const extra = " Miro rejected the index.";
    const answerText = sourceText + extra;
    const result = await auditGovernedWriterStatements({
      originalQuestion: question,
      answerText,
      statements: [
        { ...statement(c.candidate, sourceText), endUtf16: sourceText.length },
        {
          text: extra,
          startUtf16: sourceText.length,
          endUtf16: answerText.length,
          citedCandidateKey: retrievalAnswerabilityCandidateKey(c.candidate),
          citationId: "SRC1",
          citedHit: c.candidate,
          statementProposition: {
            ...proposition,
            subject: "Miro",
            predicate: "rejected",
          },
        },
      ],
      governedPropositionPort: c.port,
      admissionPipeline: c.pipeline,
    });
    expect(result).toMatchObject({
      status: "WITHHELD_WRITER_STATEMENT",
      testedClaims: 1,
      totalClaims: 2,
      firstRejectedClaim: 1,
    });
    expect(c.reader).not.toHaveBeenCalled();
  });

  it("permits repeated citation of the same immutable source unit across fully covered claims", async () => {
    const c = context();
    const answerText = sourceText + " " + sourceText;
    const result = await auditGovernedWriterStatements({
      originalQuestion: question,
      answerText,
      statements: [
        statement(c.candidate),
        {
          ...statement(c.candidate),
          text: " " + sourceText,
          startUtf16: sourceText.length,
          endUtf16: answerText.length,
        },
      ],
      governedPropositionPort: c.port,
      admissionPipeline: c.pipeline,
    });
    expect(result).toMatchObject({
      status: "SOURCE_BOUND_CLAIMS_CANDIDATE",
      testedClaims: 2,
      productionAdmission: false,
    });
    expect(c.port.resolve).toHaveBeenCalledTimes(2);
    expect(c.reader).not.toHaveBeenCalled();
  });

  it("rejects a reused Writer citation ID mapped to two different original source units before resolving either", async () => {
    const c = context();
    const second = {
      ...c.candidate,
      unitId: randomUUID(),
      revision: "revision-B",
    };
    const answerText = sourceText + " " + sourceText;
    const result = await auditGovernedWriterStatements({
      originalQuestion: question,
      answerText,
      statements: [
        statement(c.candidate),
        {
          ...statement(second),
          text: " " + sourceText,
          startUtf16: sourceText.length,
          endUtf16: answerText.length,
          citationId: "SRC1",
        },
      ],
      governedPropositionPort: c.port,
      admissionPipeline: c.pipeline,
    });
    expect(result).toMatchObject({
      status: "WITHHELD_SOURCE_CUSTODY",
      firstRejectedClaim: 1,
      productionAdmission: false,
    });
    expect(c.port.resolve).not.toHaveBeenCalled();
    expect(c.reader).not.toHaveBeenCalled();
  });

  it("rejects uncovered answer text, missing citation identity and altered SOURCE custody", async () => {
    const c = context();
    const basic = {
      originalQuestion: question,
      answerText: sourceText,
      governedPropositionPort: c.port,
      admissionPipeline: c.pipeline,
    };
    expect(
      (
        await auditGovernedWriterStatements({
          ...basic,
          statements: [
            { ...statement(c.candidate), endUtf16: sourceText.length - 1 },
          ],
        })
      ).status,
    ).toBe("REJECTED_ANSWER_COVERAGE");
    expect(
      (
        await auditGovernedWriterStatements({
          ...basic,
          statements: [
            { ...statement(c.candidate), citedCandidateKey: "forged" },
          ],
        })
      ).status,
    ).toBe("REJECTED_ANSWER_COVERAGE");
    c.port.resolve.mockImplementationOnce(async () => ({
      ...proof(c.candidate),
      revision: "other-revision",
    }));
    expect(
      (
        await auditGovernedWriterStatements({
          ...basic,
          statements: [statement(c.candidate)],
        })
      ).status,
    ).toBe("WITHHELD_SOURCE_CUSTODY");
    expect(c.reader).not.toHaveBeenCalled();
  });

  it("withholds when the original question role differs even if the Writer restates the source", async () => {
    const c = context();
    c.port.resolve.mockImplementationOnce(async () => ({
      ...proof(c.candidate),
      queryProposition: { ...proposition, predicate: "rejected" },
    }));
    expect(
      (
        await auditGovernedWriterStatements({
          originalQuestion: question,
          answerText: sourceText,
          statements: [statement(c.candidate)],
          governedPropositionPort: c.port,
          admissionPipeline: c.pipeline,
        })
      ).status,
    ).toBe("WITHHELD_QUESTION_RELATION");
    expect(c.reader).not.toHaveBeenCalled();
  });
});
