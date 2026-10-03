import type { SearchHit } from "@akp/contracts";
import type {
  CandidateAnswerabilitySignal,
  QueryConditionedEvidenceSpan,
  RetrievalAnswerabilityAssessment,
} from "./answerability.js";
import { retrievalAnswerabilityCandidateKey } from "./answerability.js";
import { markdownVisibleSource } from "./markdown-visible-source.js";

export type EvidenceFailureStage =
  | "INGESTION_MISSING"
  | "UNITIZATION_BAD"
  | "CANDIDATE_NOT_RETRIEVED"
  | "CANDIDATE_RANKED_TOO_LOW"
  | "RERANK_DROPPED_GOLD"
  | "ADMISSION_FALSE_NEGATIVE"
  | "ADMISSION_FALSE_POSITIVE"
  | "SPAN_INVALID"
  | "CONTEXT_BUDGET_DROPPED"
  | "GENERATION_FAILURE"
  | "GENERATOR_UNSUPPORTED_CLAIM";

export interface EvidenceIdentity {
  documentId: string;
  unitId: string | null;
}

export interface GoldEvidenceTarget extends EvidenceIdentity {
  /** Null means no exact gold span was annotated, not that any span is valid. */
  evidenceSpan: QueryConditionedEvidenceSpan | null;
}

/** Metadata only. Query text, paths, titles and passage bytes are excluded. */
export interface EvidenceCandidateDiagnostic extends EvidenceIdentity {
  rank: number;
  score: number;
  unitType: string | null;
  channels: Array<{
    channel: string;
    rank: number;
    rawScore: number | null;
    fusionContribution: number;
    generation:
      | NonNullable<
          SearchHit["retrievalTrace"]
        >["contributions"][number]["generation"]
      | null;
  }>;
  authorization:
    NonNullable<SearchHit["retrievalTrace"]>["authorization"] | null;
  truth: NonNullable<SearchHit["retrievalTrace"]>["truth"] | null;
  temporal: NonNullable<SearchHit["retrievalTrace"]>["temporal"] | null;
  rerank: SearchHit["rerankTrace"] | null;
  admission: {
    accepted: boolean;
    decision: string;
    span: QueryConditionedEvidenceSpan | null;
    spanIntegrity: "VALID" | "INVALID" | "NOT_MEASURED";
    readerSelected: boolean | null;
  } | null;
}

export interface EvidencePipelineObservation {
  caseId: string;
  measurement: "RETRIEVAL_PIPELINE" | "SUPPLIED_CANDIDATE_ADMISSION";
  expected: readonly GoldEvidenceTarget[];
  /** All labeled admissible units, including acceptable alternatives. */
  admissible: readonly EvidenceIdentity[];
  labelsComplete: boolean;
  sourceDocuments?: readonly string[];
  materializedUnits?: readonly EvidenceIdentity[];
  channelCandidates?: readonly EvidenceIdentity[];
  candidates?: readonly EvidenceCandidateDiagnostic[];
  beforeRerank?: readonly EvidenceCandidateDiagnostic[];
  reranked?: readonly EvidenceCandidateDiagnostic[];
  shortlist?: readonly EvidenceIdentity[];
  shortlistLimit?: number;
  admitted?: readonly EvidenceCandidateDiagnostic[];
  context?: readonly EvidenceIdentity[];
  contextOmissions?: readonly (EvidenceIdentity & {
    reason: "TOKEN_BUDGET" | "DOCUMENT_SECTION_LIMIT" | "MISSING_EVIDENCE";
  })[];
  generation?: { correct: boolean; unsupportedClaims: number };
}

export interface EvidenceRetrievalStageSnapshot {
  channelCandidates: readonly EvidenceIdentity[];
  fusedCandidates: readonly EvidenceCandidateDiagnostic[];
  beforeRerank: readonly EvidenceCandidateDiagnostic[];
  afterRerank: readonly EvidenceCandidateDiagnostic[];
  returned: readonly EvidenceIdentity[];
}

function key(identity: EvidenceIdentity): string {
  return `${identity.documentId}:${identity.unitId ?? "document"}`;
}

function matching<T extends EvidenceIdentity>(
  rows: readonly T[] | undefined,
  target: EvidenceIdentity,
): T | undefined {
  return rows?.find((row) => key(row) === key(target));
}

function spanIntegrity(
  passage: string,
  span: QueryConditionedEvidenceSpan | null,
): "VALID" | "INVALID" | "NOT_MEASURED" {
  if (!span) return "NOT_MEASURED";
  if (
    !Number.isSafeInteger(span.startOffset) ||
    !Number.isSafeInteger(span.endOffset) ||
    span.startOffset < 0 ||
    span.endOffset <= span.startOffset ||
    span.endOffset > passage.length ||
    markdownVisibleSource(passage).comments.some(
      (comment) =>
        comment.startOffset < span.endOffset &&
        comment.endOffset > span.startOffset,
    )
  )
    return "INVALID";
  return "VALID";
}

export function evidenceCandidateDiagnostic(
  hit: SearchHit,
  rank: number,
  assessment?: Pick<
    RetrievalAnswerabilityAssessment,
    "candidateSignals" | "supportedCandidateKeys"
  >,
): EvidenceCandidateDiagnostic {
  const signal: CandidateAnswerabilitySignal | undefined =
    assessment?.candidateSignals.find(
      (entry) => entry.candidateKey === retrievalAnswerabilityCandidateKey(hit),
    );
  const verification = signal?.queryConditionedEvidence;
  const span = verification?.evidenceSpan ?? null;
  const accepted =
    assessment?.supportedCandidateKeys.includes(
      retrievalAnswerabilityCandidateKey(hit),
    ) ?? false;
  return {
    documentId: hit.documentId,
    unitId: hit.unitId ?? null,
    rank,
    score: hit.score,
    unitType: hit.unitType ?? null,
    channels: (
      hit.retrievalTrace?.contributions ??
      hit.fusionContributions ??
      []
    ).map((contribution) => ({
      channel: contribution.channel,
      rank: contribution.rank,
      rawScore: contribution.rawScore ?? null,
      fusionContribution: contribution.channelWeight / (60 + contribution.rank),
      generation:
        hit.retrievalTrace?.contributions.find(
          (trace) =>
            trace.channel === contribution.channel &&
            trace.rank === contribution.rank,
        )?.generation ?? null,
    })),
    authorization: hit.retrievalTrace?.authorization ?? null,
    truth: hit.retrievalTrace?.truth ?? null,
    temporal: hit.retrievalTrace?.temporal ?? null,
    rerank: hit.rerankTrace ?? null,
    admission: assessment
      ? {
          accepted,
          decision:
            verification?.decision ?? (accepted ? "SUPPORTS" : "INSUFFICIENT"),
          span,
          spanIntegrity:
            verification?.reason === "READER_QUOTE_NOT_IN_PASSAGE"
              ? "INVALID"
              : spanIntegrity(hit.excerpt.trim(), span),
          readerSelected: verification
            ? verification.decision !== "NOT_VERIFIED" &&
              verification.reason !== "NOT_SHORTLISTED_FOR_READING"
            : null,
        }
      : null,
  };
}

export interface EvidenceStageFailure {
  stage: EvidenceFailureStage;
  target: GoldEvidenceTarget | null;
  detail: string;
}

export function diagnoseEvidencePipeline(input: EvidencePipelineObservation) {
  const failures: EvidenceStageFailure[] = [];
  const unresolved: Array<{ target: GoldEvidenceTarget; reason: string }> = [];
  const fail = (
    stage: EvidenceFailureStage,
    target: GoldEvidenceTarget | null,
    detail: string,
  ) => failures.push({ stage, target, detail });

  for (const target of input.expected) {
    if (
      input.sourceDocuments &&
      !input.sourceDocuments.includes(target.documentId)
    ) {
      fail("INGESTION_MISSING", target, "EXPECTED_SOURCE_ABSENT");
      continue;
    }
    if (input.materializedUnits && !matching(input.materializedUnits, target)) {
      if (input.sourceDocuments?.includes(target.documentId)) {
        fail("UNITIZATION_BAD", target, "SOURCE_PRESENT_EXPECTED_UNIT_ABSENT");
      } else {
        unresolved.push({ target, reason: "SOURCE_PRESENCE_NOT_MEASURED" });
      }
      continue;
    }
    const candidate = matching(input.candidates, target);
    const admitted = matching(input.admitted, target);
    if (input.candidates && !candidate) {
      if (input.measurement === "SUPPLIED_CANDIDATE_ADMISSION") {
        throw new Error("ADMISSION_GOLD_NOT_IN_SUPPLIED_CANDIDATES");
      }
      if (matching(input.channelCandidates, target)) {
        fail(
          "CANDIDATE_RANKED_TOO_LOW",
          target,
          "CHANNEL_UNIT_NOT_RETAINED_BY_FUSION",
        );
      } else if (
        input.channelCandidates &&
        matching(input.materializedUnits, target)
      ) {
        fail(
          "CANDIDATE_NOT_RETRIEVED",
          target,
          "UNIT_PRESENT_CANDIDATE_ABSENT",
        );
      } else {
        unresolved.push({
          target,
          reason: "UNIT_OR_CHANNEL_POOL_NOT_MEASURED",
        });
      }
      continue;
    }
    if (
      !admitted &&
      input.beforeRerank &&
      !matching(input.beforeRerank, target) &&
      candidate
    ) {
      fail(
        "CANDIDATE_RANKED_TOO_LOW",
        target,
        "FUSED_UNIT_OUTSIDE_INTERNAL_POOL",
      );
      continue;
    }
    if (!admitted && input.shortlist && !matching(input.shortlist, target)) {
      if (!candidate) {
        unresolved.push({ target, reason: "CANDIDATE_POOL_NOT_MEASURED" });
        continue;
      }
      const post = matching(input.reranked, target);
      const limit = input.shortlistLimit;
      const pre = matching(input.beforeRerank, target) ?? candidate;
      const droppedByRerank =
        input.measurement === "RETRIEVAL_PIPELINE" &&
        limit !== undefined &&
        pre.rank <= limit &&
        post !== undefined &&
        post.rank > limit;
      fail(
        droppedByRerank ? "RERANK_DROPPED_GOLD" : "CANDIDATE_RANKED_TOO_LOW",
        target,
        "EXPECTED_UNIT_OUTSIDE_MEASURED_SHORTLIST",
      );
      continue;
    }
    if (input.admitted && !admitted) {
      if (
        candidate &&
        (!input.shortlist || matching(input.shortlist, target))
      ) {
        if (candidate.admission?.spanIntegrity === "INVALID") {
          fail("SPAN_INVALID", target, "READER_SPAN_NOT_VISIBLE_SOURCE");
        } else {
          fail(
            "ADMISSION_FALSE_NEGATIVE",
            target,
            "EXPECTED_CANDIDATE_REJECTED",
          );
        }
      } else {
        unresolved.push({ target, reason: "READ_CANDIDATES_NOT_MEASURED" });
      }
      continue;
    }
    if (admitted?.admission?.spanIntegrity === "INVALID") {
      fail("SPAN_INVALID", target, "ADMITTED_SPAN_NOT_VISIBLE_SOURCE");
    }
    if (input.context && !matching(input.context, target)) {
      if (!admitted) {
        unresolved.push({ target, reason: "ADMISSION_NOT_MEASURED" });
        continue;
      }
      const omission = matching(input.contextOmissions, target);
      if (
        omission?.reason === "TOKEN_BUDGET" ||
        omission?.reason === "DOCUMENT_SECTION_LIMIT"
      ) {
        fail("CONTEXT_BUDGET_DROPPED", target, omission.reason);
      } else if (omission?.reason === "MISSING_EVIDENCE") {
        fail("SPAN_INVALID", target, "CONTEXT_SOURCE_LOCATOR_MISSING");
      } else {
        unresolved.push({
          target,
          reason: "CONTEXT_OMISSION_REASON_NOT_MEASURED",
        });
      }
    }
  }
  const allowed = new Set(input.admissible.map(key));
  if (input.labelsComplete) {
    for (const candidate of input.admitted ?? []) {
      if (!allowed.has(key(candidate))) {
        fail(
          "ADMISSION_FALSE_POSITIVE",
          {
            documentId: candidate.documentId,
            unitId: candidate.unitId,
            evidenceSpan: null,
          },
          "ADMITTED_UNIT_EXCLUDED_BY_COMPLETE_LABELS",
        );
      }
    }
  }
  if (input.generation?.unsupportedClaims) {
    fail("GENERATOR_UNSUPPORTED_CLAIM", null, "UNSUPPORTED_CLAIM_OBSERVED");
  } else if (
    input.generation?.correct === false &&
    input.context !== undefined &&
    input.expected.length > 0 &&
    input.expected.every((target) => matching(input.context, target))
  ) {
    for (const target of input.expected) {
      fail(
        "GENERATION_FAILURE",
        target,
        "GOLD_CONTEXT_PRESENT_ANSWER_INCORRECT",
      );
    }
  }
  const stages = {
    ingestion: input.sourceDocuments !== undefined,
    unitization: input.materializedUnits !== undefined,
    candidates: input.candidates !== undefined,
    channels: input.channelCandidates !== undefined,
    rerank: input.reranked !== undefined,
    shortlist: input.shortlist !== undefined,
    admission: input.admitted !== undefined,
    context: input.context !== undefined,
    generation: input.generation !== undefined,
  };
  const admittedCount = input.admitted?.length ?? 0;
  return {
    schemaVersion: 1,
    caseId: input.caseId,
    measurement: input.measurement,
    measuredStages: stages,
    expected: input.expected,
    failures,
    unresolved,
    candidateTrace: input.reranked ?? input.candidates ?? [],
    admittedUnitPrecision:
      !input.labelsComplete ||
      input.admitted === undefined ||
      admittedCount === 0
        ? null
        : input.admitted.filter((entry) => allowed.has(key(entry))).length /
          admittedCount,
    exactSpanEvaluation: {
      annotatedGoldUnits: input.expected.filter(
        (target) => target.evidenceSpan !== null,
      ).length,
      totalGoldUnits: input.expected.length,
      // Source integrity and semantic span precision are separate measurements.
      precision: null,
    },
  };
}
