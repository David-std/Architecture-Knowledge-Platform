import type { SearchHit } from "@akp/contracts";
import { retrievalAnswerabilityCandidateKey } from "./answerability.js";
import type {
  EvidenceAdmissionDecision,
  LayeredEvidenceAdmissionInput,
  StructuredPropositionQuery,
} from "./evidence-admission.js";
import {
  bindGovernedLayeredPropositionInput,
  type GovernedLayeredPropositionPort,
  type LayeredEvidenceAdmissionEvaluator,
} from "./layered-answerability.js";
import { sourceSpanUsesCodePointBoundaries } from "./source-verification.js";

/**
 * An evaluation/opt-in claim-custody adapter over the SAME R5 admission
 * pipeline, not a second LLM judge. Writer claim propositions must be
 * externally reviewed/attested; model-generated projections are proposals,
 * not trustworthy input. This returns only a candidate, never release gold.
 */
export interface GovernedWriterStatement {
  readonly text: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly citedCandidateKey: string;
  /** Native Writer citation ID, later checked against the frozen provider request. */
  readonly citationId: string;
  readonly citedHit: SearchHit;
  /** Independently verified projection of this ACTUAL Writer statement. */
  readonly statementProposition: StructuredPropositionQuery;
}

export interface GovernedWriterClaimAudit {
  readonly status:
    | "SOURCE_BOUND_CLAIMS_CANDIDATE"
    | "REJECTED_ANSWER_COVERAGE"
    | "WITHHELD_SOURCE_CUSTODY"
    | "WITHHELD_QUESTION_RELATION"
    | "WITHHELD_WRITER_STATEMENT"
    | "WITHHELD_READER_FAILURE";
  readonly testedClaims: number;
  readonly totalClaims: number;
  readonly firstRejectedClaim: number | null;
  /** One exact original SOURCE digest for each covered Writer statement. */
  readonly sourceCitations: readonly {
    readonly citationId: string;
    readonly originalSourceSha256: string;
  }[];
  readonly fullyAtomicIndependentlyVerified: false;
  readonly fullQuestionCoverageIndependentlyVerified: false;
  readonly originalSourceAuthorizationIndependentlyVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}
const sourceBoundAnswer = (decision: EvidenceAdmissionDecision | undefined) =>
  decision?.verdict.kind === "ANSWERS" &&
  decision.layer === "STRUCTURED_PROPOSITION" &&
  decision.verdict.quote.endOffset > decision.verdict.quote.startOffset;

/**
 * Requires complete UTF-16 coverage of the exact Writer answer. A syntactically
 * covered answer can still be split into non-atomic claims, omit a question
 * clause or contain false implications; those require independent review.
 * Citation keys must refer to the exact source hit, not an LLM-supplied title.
 */
export async function auditGovernedWriterStatements(input: {
  readonly originalQuestion: string;
  readonly answerText: string;
  readonly statements: readonly GovernedWriterStatement[];
  readonly governedPropositionPort: GovernedLayeredPropositionPort;
  readonly admissionPipeline: LayeredEvidenceAdmissionEvaluator;
}): Promise<GovernedWriterClaimAudit> {
  const totalClaims = input.statements?.length ?? 0;
  const sourceCitations: {
    citationId: string;
    originalSourceSha256: string;
  }[] = [];
  const make = (
    status: GovernedWriterClaimAudit["status"],
    testedClaims: number,
    firstRejectedClaim: number | null,
  ): GovernedWriterClaimAudit => ({
    status,
    testedClaims,
    totalClaims,
    firstRejectedClaim,
    sourceCitations: [...sourceCitations],
    fullyAtomicIndependentlyVerified: false,
    fullQuestionCoverageIndependentlyVerified: false,
    originalSourceAuthorizationIndependentlyVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  if (
    !input.originalQuestion?.trim() ||
    !input.answerText?.trim() ||
    input.answerText.length > 4096 ||
    !Array.isArray(input.statements) ||
    totalClaims === 0 ||
    totalClaims > 16 ||
    !input.governedPropositionPort?.resolve ||
    !input.admissionPipeline?.evaluateBatch
  )
    return make("REJECTED_ANSWER_COVERAGE", 0, null);

  let cursor = 0;
  for (const [index, statement] of input.statements.entries()) {
    if (
      !statement ||
      !Number.isSafeInteger(statement.startUtf16) ||
      !Number.isSafeInteger(statement.endUtf16) ||
      statement.startUtf16 !== cursor ||
      statement.endUtf16 <= statement.startUtf16 ||
      statement.endUtf16 > input.answerText.length ||
      !sourceSpanUsesCodePointBoundaries(
        input.answerText,
        statement.startUtf16,
        statement.endUtf16,
      ) ||
      statement.text !==
        input.answerText.slice(statement.startUtf16, statement.endUtf16) ||
      !statement.text.trim() ||
      typeof statement.citationId !== "string" ||
      !/^[A-Za-z0-9_.:-]{1,100}$/u.test(statement.citationId) ||
      !statement.citedHit ||
      statement.citedCandidateKey !==
        retrievalAnswerabilityCandidateKey(statement.citedHit) ||
      !statement.statementProposition
    )
      return make("REJECTED_ANSWER_COVERAGE", index, index);
    cursor = statement.endUtf16;
  }
  if (cursor !== input.answerText.length) {
    return make("REJECTED_ANSWER_COVERAGE", 0, null);
  }

  // Writer citation IDs are references into one frozen provider source list.
  // Reusing an ID for a different unit/revision makes attribution ambiguous,
  // even if each individual source proof passes its own SHA check.
  const citationSources = new Map<string, string>();
  for (const [index, statement] of input.statements.entries()) {
    const hit = statement.citedHit;
    const sourceIdentity = JSON.stringify([
      hit.vaultId,
      hit.documentId,
      hit.unitId ?? null,
      hit.revision,
      hit.document.path,
      hit.excerpt,
    ]);
    const prior = citationSources.get(statement.citationId);
    if (prior !== undefined && prior !== sourceIdentity) {
      return make("WITHHELD_SOURCE_CUSTODY", index, index);
    }
    citationSources.set(statement.citationId, sourceIdentity);
  }

  for (const [index, statement] of input.statements.entries()) {
    let proof;
    try {
      proof = await input.governedPropositionPort.resolve({
        originalQuestion: input.originalQuestion,
        hit: statement.citedHit,
      });
    } catch {
      return make("WITHHELD_SOURCE_CUSTODY", index, index);
    }
    const bound = bindGovernedLayeredPropositionInput(
      input.originalQuestion,
      statement.citedHit,
      proof,
    );
    if (!bound?.candidateProposition)
      return make("WITHHELD_SOURCE_CUSTODY", index, index);
    const statementBound: LayeredEvidenceAdmissionInput = {
      query: statement.text,
      hit: statement.citedHit,
      queryProposition: statement.statementProposition,
      candidateProposition: bound.candidateProposition,
      requireStructuredProposition: true,
    };
    let decisions: EvidenceAdmissionDecision[];
    try {
      decisions = await input.admissionPipeline.evaluateBatch([
        bound,
        statementBound,
      ]);
    } catch {
      return make("WITHHELD_READER_FAILURE", index, index);
    }
    if (!Array.isArray(decisions) || decisions.length !== 2) {
      return make("WITHHELD_READER_FAILURE", index, index);
    }
    if (!sourceBoundAnswer(decisions[0])) {
      return make("WITHHELD_QUESTION_RELATION", index, index);
    }
    if (!sourceBoundAnswer(decisions[1])) {
      return make("WITHHELD_WRITER_STATEMENT", index, index);
    }
    sourceCitations.push({
      citationId: statement.citationId,
      originalSourceSha256: proof!.originalSourceSha256,
    });
  }
  return make("SOURCE_BOUND_CLAIMS_CANDIDATE", totalClaims, null);
}
