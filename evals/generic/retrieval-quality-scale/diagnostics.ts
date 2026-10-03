import type { SearchHit } from "@akp/contracts";
import {
  diagnoseEvidencePipeline,
  evidenceCandidateDiagnostic,
  retrievalAnswerabilityCandidateKey,
  type EvidenceCandidateDiagnostic,
  type EvidenceIdentity,
  type EvidenceRetrievalStageSnapshot,
  type GoldEvidenceTarget,
  type RetrievalAnswerabilityAssessment,
} from "../../../packages/retrieval/src/index.js";

export type RetrievalScaleLabelScope = "CLOSED_GOLD_BENCHMARK";

export interface BuildRetrievalScaleStageAttributionInput {
  caseId: string;
  expected: readonly GoldEvidenceTarget[];
  admissible: readonly EvidenceIdentity[];
  labelsComplete: boolean;
  labelScope: RetrievalScaleLabelScope;
  sourceDocuments: readonly string[];
  materializedUnits: readonly EvidenceIdentity[];
  snapshot: EvidenceRetrievalStageSnapshot | undefined;
  returnedHits: readonly SearchHit[];
  assessment: RetrievalAnswerabilityAssessment;
  shortlistLimit: number;
}

export type RetrievalScaleStageAttribution = ReturnType<
  typeof diagnoseEvidencePipeline
> & {
  labelsComplete: boolean;
  labelScope: RetrievalScaleLabelScope;
  admitted: EvidenceCandidateDiagnostic[];
  admittedOutsideAdmissible: EvidenceCandidateDiagnostic[];
};

function identityKey(identity: EvidenceIdentity): string {
  return `${identity.documentId}:${identity.unitId ?? "document"}`;
}

function enrichAdmission(
  rows: readonly EvidenceCandidateDiagnostic[],
  admissionByIdentity: ReadonlyMap<string, EvidenceCandidateDiagnostic["admission"]>,
): EvidenceCandidateDiagnostic[] {
  return rows.map((row) => ({
    ...row,
    admission: admissionByIdentity.get(identityKey(row)) ?? row.admission,
  }));
}

/**
 * Join the real retrieval-stage snapshot with the deterministic answerability
 * assessment used by the R8 harness.
 *
 * The closed fixture gold set is a regression label set, not a universal
 * semantic authority. Callers therefore decide explicitly whether labels are
 * complete. When they are not complete, outside-gold admissions remain
 * inspectable but are not promoted to ADMISSION_FALSE_POSITIVE failures.
 */
export function buildRetrievalScaleStageAttribution(
  input: BuildRetrievalScaleStageAttributionInput,
): RetrievalScaleStageAttribution {
  if (!input.snapshot) {
    throw new Error(`R8_STAGE_SNAPSHOT_MISSING:${input.caseId}`);
  }

  const returnedDiagnostics = input.returnedHits.map((hit, index) =>
    evidenceCandidateDiagnostic(hit, index + 1, input.assessment),
  );
  const admissionByIdentity = new Map(
    returnedDiagnostics.map((candidate) => [
      identityKey(candidate),
      candidate.admission,
    ]),
  );

  const fusedCandidates = enrichAdmission(
    input.snapshot.fusedCandidates,
    admissionByIdentity,
  );
  const beforeRerank = enrichAdmission(
    input.snapshot.beforeRerank,
    admissionByIdentity,
  );
  const reranked = enrichAdmission(
    input.snapshot.afterRerank,
    admissionByIdentity,
  );

  const supported = new Set(input.assessment.supportedCandidateKeys);
  const admitted = returnedDiagnostics.filter((candidate) =>
    supported.has(
      retrievalAnswerabilityCandidateKey({
        documentId: candidate.documentId,
        unitId: candidate.unitId,
      }),
    ),
  );
  const admissible = new Set(input.admissible.map(identityKey));
  const admittedOutsideAdmissible = admitted.filter(
    (candidate) => !admissible.has(identityKey(candidate)),
  );

  const diagnosis = diagnoseEvidencePipeline({
    caseId: input.caseId,
    measurement: "RETRIEVAL_PIPELINE",
    expected: input.expected,
    admissible: input.admissible,
    labelsComplete: input.labelsComplete,
    sourceDocuments: input.sourceDocuments,
    materializedUnits: input.materializedUnits,
    channelCandidates: input.snapshot.channelCandidates,
    candidates: fusedCandidates,
    beforeRerank,
    reranked,
    shortlist: input.snapshot.returned,
    shortlistLimit: input.shortlistLimit,
    admitted,
  });

  return {
    ...diagnosis,
    labelsComplete: input.labelsComplete,
    labelScope: input.labelScope,
    admitted,
    admittedOutsideAdmissible,
  };
}
