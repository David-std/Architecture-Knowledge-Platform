import type { SearchHit } from "../packages/contracts/src/index.js";
import {
  aggregateBenchmarkRun,
  type BenchmarkConfiguration,
  type BenchmarkObservation,
} from "../packages/evaluation/src/index.js";
import {
  diagnoseEvidencePipeline,
  evidenceCandidateDiagnostic,
  retrievalAnswerabilityCandidateKey,
  type EvidenceRetrievalStageSnapshot,
  type RetrievalAnswerabilityAssessment,
} from "../packages/retrieval/src/index.js";

/** Only for fixtures that explicitly seed exactly one unit per document. */
export function diagnoseSingleUnitCorpusCase(input: {
  caseId: string;
  goldDocuments: readonly string[];
  expectNoAnswer: boolean;
  documentIds: ReadonlyMap<string, string>;
  unitIds: ReadonlyMap<string, string>;
  candidateStages: EvidenceRetrievalStageSnapshot | undefined;
  shortlist: readonly SearchHit[];
  shortlistLimit: number;
  admitted: readonly SearchHit[];
  assessment: RetrievalAnswerabilityAssessment;
}) {
  const identityForDocument = (document: string) => {
    const documentId = input.documentIds.get(document);
    const unitId = input.unitIds.get(document);
    if (!documentId || !unitId)
      throw new Error("CORPUS_GOLD_UNIT_MAPPING_MISSING");
    return { documentId, unitId, evidenceSpan: null };
  };
  const measuredAdmission = new Map(
    input.shortlist.map((hit, index) => [
      retrievalAnswerabilityCandidateKey(hit),
      evidenceCandidateDiagnostic(hit, index + 1, input.assessment).admission,
    ]),
  );
  const withAdmission = (
    candidates: EvidenceRetrievalStageSnapshot["fusedCandidates"],
  ) =>
    candidates.map((candidate) => ({
      ...candidate,
      admission:
        measuredAdmission.get(
          `${candidate.documentId}:${candidate.unitId ?? "document"}`,
        ) ?? candidate.admission,
    }));
  return diagnoseEvidencePipeline({
    caseId: input.caseId,
    measurement: "RETRIEVAL_PIPELINE",
    expected: input.goldDocuments.map(identityForDocument),
    admissible: input.goldDocuments.map(identityForDocument),
    // Document labels are not exhaustive source/span support annotations.
    labelsComplete: input.expectNoAnswer,
    sourceDocuments: [...input.documentIds.values()],
    materializedUnits: [...input.documentIds.keys()].map(identityForDocument),
    ...(input.candidateStages
      ? {
          channelCandidates: input.candidateStages.channelCandidates,
          candidates: withAdmission(input.candidateStages.fusedCandidates),
          beforeRerank: withAdmission(input.candidateStages.beforeRerank),
          reranked: withAdmission(input.candidateStages.afterRerank),
        }
      : {}),
    shortlist: input.shortlist.map((hit) => ({
      documentId: hit.documentId,
      unitId: hit.unitId ?? null,
    })),
    shortlistLimit: input.shortlistLimit,
    admitted: input.admitted.map((hit, index) =>
      evidenceCandidateDiagnostic(hit, index + 1, input.assessment),
    ),
  });
}

export function aggregateObservedBenchmarkRun<T extends BenchmarkObservation>(
  configuration: BenchmarkConfiguration,
  observations: readonly T[],
) {
  const run = aggregateBenchmarkRun(configuration, observations);
  return {
    ...run,
    results: run.results.map((result, index) => ({
      ...observations[index]!,
      metrics: result.metrics,
      passed: result.passed,
    })),
  };
}
