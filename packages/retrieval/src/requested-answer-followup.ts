import type { RetrievalAnswerabilityAssessment } from "./answerability.js";
import {
  projectRequestedAnswerSlot,
  type RequestedAnswerSlotProjection,
} from "./requested-answer-slot.js";

export type RequestedAnswerCoverageStatus =
  "COVERED" | "MISSING" | "UNSUPPORTED_QUERY";

export type RequestedAnswerFollowUpOutcome =
  "SUPPORTED_INITIAL" | "SUPPORTED_FOLLOW_UP" | "INSUFFICIENT_KNOWLEDGE";

export interface RequestedAnswerCoverageAssessment {
  readonly status: RequestedAnswerCoverageStatus;
  readonly projection: RequestedAnswerSlotProjection | null;
  readonly followUpQuery: string | null;
  readonly reason:
    | "SUPPORTED_EVIDENCE_PRESENT"
    | "SUPPORTED_QUERY_FORM_WITHOUT_EVIDENCE"
    | "QUERY_FORM_NOT_PROJECTABLE"
    | "FOLLOW_UP_QUERY_NOT_SAFE";
}

export type RequestedAnswerSupportAssessment = Pick<
  RetrievalAnswerabilityAssessment,
  "supported" | "reason" | "supportedCandidateKeys"
>;

export interface RequestedAnswerFollowUpResult<T> {
  readonly outcome: RequestedAnswerFollowUpOutcome;
  readonly coverage: RequestedAnswerCoverageAssessment;
  readonly initialCandidates: readonly T[];
  readonly finalCandidates: readonly T[];
  readonly initialAssessment: RequestedAnswerSupportAssessment;
  readonly finalAssessment: RequestedAnswerSupportAssessment;
  readonly followUpAttemptCount: 0 | 1;
  readonly followUpQuery: string | null;
}

export interface RequestedAnswerFollowUpInput<T> {
  readonly query: string;
  readonly initialCandidates: readonly T[];
  readonly initialAssessment: RequestedAnswerSupportAssessment;
  /**
   * Runs the normal retrieval pipeline once with the bounded follow-up query.
   * Authorization, truth, ranking and all other caller policy stay outside
   * this helper and must be supplied unchanged by the caller.
   */
  readonly retrieve: (followUpQuery: string) => Promise<readonly T[]>;
  /**
   * Re-runs normal evidence admission against the ORIGINAL user query.
   * The follow-up query is retrieval assistance only and never becomes proof.
   */
  readonly assess: (
    candidates: readonly T[],
    originalQuery: string,
  ) =>
    | RequestedAnswerSupportAssessment
    | Promise<RequestedAnswerSupportAssessment>;
}

const SAFE_ANCHOR = /^[\p{L}\p{N}_-]{2,64}$/u;
const MAX_ANCHORS = 16;
const MAX_QUERY_CHARACTERS = 256;

function safeAnchor(value: string): string | null {
  const normalized = value.normalize("NFKC").trim();
  return SAFE_ANCHOR.test(normalized) ? normalized : null;
}

/**
 * Builds retrieval assistance only from the already-governed slot projection.
 *
 * No synonyms, stemming, semantic expansion, entity typing or corpus terms are
 * introduced here. Invalid or unexpectedly large projections fail closed.
 */
export function buildRequestedAnswerFollowUpQuery(
  projection: RequestedAnswerSlotProjection,
): string | null {
  const source = [
    projection.relationAnchor,
    ...projection.boundArgumentAnchors,
  ];
  if (source.length < 2 || source.length > MAX_ANCHORS) return null;

  const anchors: string[] = [];
  const seen = new Set<string>();
  for (const value of source) {
    const anchor = safeAnchor(value);
    if (!anchor) return null;
    const key = anchor.toLocaleLowerCase("und");
    if (seen.has(key)) continue;
    seen.add(key);
    anchors.push(anchor);
  }
  if (anchors.length < 2) return null;

  const query = anchors.join(" ");
  return query.length <= MAX_QUERY_CHARACTERS ? query : null;
}

/**
 * Slot coverage is evidence-governed: a projection identifies what the query
 * asks for, but only the existing answerability/admission result can mark it
 * covered. Retrieval relevance or anchor overlap never grants support.
 */
export function assessRequestedAnswerCoverage(
  query: string,
  assessment: RequestedAnswerSupportAssessment,
): RequestedAnswerCoverageAssessment {
  const projection = projectRequestedAnswerSlot(query);
  if (!projection) {
    return {
      status: "UNSUPPORTED_QUERY",
      projection: null,
      followUpQuery: null,
      reason: "QUERY_FORM_NOT_PROJECTABLE",
    };
  }

  if (assessment.supported) {
    return {
      status: "COVERED",
      projection,
      followUpQuery: null,
      reason: "SUPPORTED_EVIDENCE_PRESENT",
    };
  }

  const followUpQuery = buildRequestedAnswerFollowUpQuery(projection);
  if (!followUpQuery) {
    return {
      status: "UNSUPPORTED_QUERY",
      projection,
      followUpQuery: null,
      reason: "FOLLOW_UP_QUERY_NOT_SAFE",
    };
  }

  return {
    status: "MISSING",
    projection,
    followUpQuery,
    reason: "SUPPORTED_QUERY_FORM_WITHOUT_EVIDENCE",
  };
}

/**
 * Executes zero or one follow-up retrieval pass.
 *
 * The helper cannot recurse and cannot turn candidates into evidence. The
 * second pass is assessed against the original user query, so a retrieval-only
 * reformulation never weakens admission semantics.
 */
export async function runRequestedAnswerFollowUp<T>(
  input: RequestedAnswerFollowUpInput<T>,
): Promise<RequestedAnswerFollowUpResult<T>> {
  const coverage = assessRequestedAnswerCoverage(
    input.query,
    input.initialAssessment,
  );

  if (input.initialAssessment.supported) {
    return {
      outcome: "SUPPORTED_INITIAL",
      coverage,
      initialCandidates: input.initialCandidates,
      finalCandidates: input.initialCandidates,
      initialAssessment: input.initialAssessment,
      finalAssessment: input.initialAssessment,
      followUpAttemptCount: 0,
      followUpQuery: null,
    };
  }

  if (coverage.status !== "MISSING" || !coverage.followUpQuery) {
    return {
      outcome: "INSUFFICIENT_KNOWLEDGE",
      coverage,
      initialCandidates: input.initialCandidates,
      finalCandidates: input.initialCandidates,
      initialAssessment: input.initialAssessment,
      finalAssessment: input.initialAssessment,
      followUpAttemptCount: 0,
      followUpQuery: null,
    };
  }

  const followUpCandidates = await input.retrieve(coverage.followUpQuery);
  const followUpAssessment = await input.assess(
    followUpCandidates,
    input.query,
  );

  return {
    outcome: followUpAssessment.supported
      ? "SUPPORTED_FOLLOW_UP"
      : "INSUFFICIENT_KNOWLEDGE",
    coverage,
    initialCandidates: input.initialCandidates,
    finalCandidates: followUpCandidates,
    initialAssessment: input.initialAssessment,
    finalAssessment: followUpAssessment,
    followUpAttemptCount: 1,
    followUpQuery: coverage.followUpQuery,
  };
}
