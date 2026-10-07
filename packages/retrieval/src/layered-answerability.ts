import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  retrievalAnswerabilityCandidateKey,
  type CandidateSupportReason,
  type QueryConditionedEvidenceSpan,
  type QueryConditionedEvidenceTrace,
  type RetrievalAnswerabilityAssessment,
  type RetrievalAnswerabilityContext,
  type RetrievalAnswerabilityPolicyInput,
} from "./answerability.js";
import type {
  EvidenceAdmissionDecision,
  LayeredEvidenceAdmissionInput,
} from "./evidence-admission.js";

/** The batch boundary of `LayeredEvidenceAdmissionPipeline`. */
export interface LayeredEvidenceAdmissionEvaluator {
  evaluateBatch(
    inputs: readonly LayeredEvidenceAdmissionInput[],
  ): Promise<EvidenceAdmissionDecision[]>;
}

export interface LayeredAnswerabilityOptions {
  /** Leading candidates of the fused, reranked pool that may be admitted. */
  maxCandidates?: number;
  /** Recorded in traces of decisions that carry no reader identity. */
  admissionId?: string;
}

export const DEFAULT_LAYERED_ADMISSION_MAX_CANDIDATES = 64;

const LAYERED_ADMISSION_FAILURE = "LAYERED_ADMISSION_FAILURE";
const READER_FAILURE_REASON =
  /^(?:READER_ERROR|SEMANTIC_READER_(?:ERROR|TIMEOUT|BATCH_FAILURE|BATCH_SIZE_MISMATCH))\b/u;

function boundedWindow(value: number | undefined): number {
  const resolved = value ?? DEFAULT_LAYERED_ADMISSION_MAX_CANDIDATES;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 256) {
    throw new Error(
      "layered admission maxCandidates must be an integer between 1 and 256",
    );
  }
  return resolved;
}

function failureDecisions(count: number): EvidenceAdmissionDecision[] {
  return Array.from({ length: count }, () => ({
    layer: "SEMANTIC_READER",
    verdict: { kind: "INSUFFICIENT" },
    reason: LAYERED_ADMISSION_FAILURE,
  }));
}

/**
 * Pipeline spans index the excerpt as given to the reader; candidate traces
 * index the trimmed excerpt, like every other query-conditioned verifier.
 */
function trimmedExcerptSpan(
  hit: SearchHit,
  span: { startOffset: number; endOffset: number },
): QueryConditionedEvidenceSpan | null {
  const lead = hit.excerpt.length - hit.excerpt.trimStart().length;
  const length = hit.excerpt.trim().length;
  const startOffset = span.startOffset - lead;
  const endOffset = Math.min(span.endOffset - lead, length);
  return startOffset >= 0 && endOffset > startOffset
    ? { startOffset, endOffset }
    : null;
}

function layeredTrace(
  hit: SearchHit,
  decision: EvidenceAdmissionDecision | undefined,
  admissionId: string,
): QueryConditionedEvidenceTrace {
  if (!decision) {
    return {
      verifierId: admissionId,
      mode: "LAYERED",
      decision: "NOT_VERIFIED",
      score: null,
      reason: "LAYERED_ADMISSION_OUTSIDE_BOUNDED_WINDOW",
      evidenceSpan: null,
    };
  }
  const failed =
    decision.reason === LAYERED_ADMISSION_FAILURE ||
    READER_FAILURE_REASON.test(decision.reason);
  const quote =
    decision.verdict.kind === "ANSWERS" ||
    decision.verdict.kind === "CONTRADICTS"
      ? decision.verdict.quote
      : null;
  const evidenceSpan = quote ? trimmedExcerptSpan(hit, quote) : null;
  return {
    verifierId: decision.readerId ?? `${admissionId}:${decision.layer}`,
    mode: "LAYERED",
    decision: failed
      ? "VERIFIER_ERROR"
      : decision.verdict.kind === "ANSWERS" && evidenceSpan
        ? "SUPPORTS"
        : decision.verdict.kind === "CONTRADICTS" && evidenceSpan
          ? "CONTRADICTS"
          : "INSUFFICIENT",
    score: null,
    reason: decision.reason,
    evidenceSpan,
  };
}

function layeredReason(
  trace: QueryConditionedEvidenceTrace,
): CandidateSupportReason {
  switch (trace.decision) {
    case "SUPPORTS":
      return "QUERY_CONDITIONED_SUPPORT";
    case "CONTRADICTS":
      return "QUERY_CONDITIONED_CONTRADICTION";
    case "VERIFIER_ERROR":
      return "QUERY_CONDITIONED_VERIFIER_ERROR";
    default:
      return "QUERY_CONDITIONED_INSUFFICIENT";
  }
}

/**
 * Production admission through `LayeredEvidenceAdmissionPipeline`.
 *
 * Only a pipeline `ANSWERS` verdict with an exact visible source span admits a
 * passage: the structural guard keeps lifecycle, truth, identifier, span and
 * explicit numeric/date authority; structured propositions and the semantic
 * reader own support. Deterministic passage heuristics (`PASSAGE_TEXT_SUPPORT`,
 * `PASSAGE_CUE_SUPPORT` and the other lexical reasons) are evaluated for
 * diagnostics only and never admit. Candidates outside the bounded window,
 * reader failures and malformed batches fail closed.
 */
export async function assessRetrievalAnswerabilityWithLayeredAdmission(
  hits: readonly SearchHit[],
  query: string,
  pipeline: LayeredEvidenceAdmissionEvaluator,
  options: LayeredAnswerabilityOptions = {},
  policyInput: RetrievalAnswerabilityPolicyInput = {},
  context: RetrievalAnswerabilityContext = {},
): Promise<RetrievalAnswerabilityAssessment> {
  const maxCandidates = boundedWindow(options.maxCandidates);
  const admissionId = options.admissionId ?? "layered-admission";
  const baseline = assessRetrievalAnswerability(
    hits,
    query,
    policyInput,
    context,
  );
  if (hits.length === 0) return baseline;

  const window = hits.slice(0, maxCandidates);
  let decisions: EvidenceAdmissionDecision[];
  try {
    const evaluated: unknown = await pipeline.evaluateBatch(
      window.map((hit) => ({ query, hit })),
    );
    decisions =
      Array.isArray(evaluated) && evaluated.length === window.length
        ? (evaluated as EvidenceAdmissionDecision[])
        : failureDecisions(window.length);
  } catch {
    decisions = failureDecisions(window.length);
  }

  const traces = new Map<string, QueryConditionedEvidenceTrace>();
  window.forEach((hit, index) => {
    const key = retrievalAnswerabilityCandidateKey(hit);
    if (!traces.has(key)) {
      traces.set(key, layeredTrace(hit, decisions[index], admissionId));
    }
  });
  const hitsByKey = new Map(
    hits.map((hit) => [retrievalAnswerabilityCandidateKey(hit), hit]),
  );
  const candidateSignals = baseline.candidateSignals.map((signal) => {
    const hit = hitsByKey.get(signal.candidateKey);
    const trace =
      traces.get(signal.candidateKey) ??
      (hit
        ? layeredTrace(hit, undefined, admissionId)
        : {
            verifierId: admissionId,
            mode: "LAYERED" as const,
            decision: "NOT_VERIFIED" as const,
            score: null,
            reason: "LAYERED_ADMISSION_OUTSIDE_BOUNDED_WINDOW",
            evidenceSpan: null,
          });
    const reason = layeredReason(trace);
    return {
      ...signal,
      passageSupport: {
        ...signal.passageSupport,
        supported: reason === "QUERY_CONDITIONED_SUPPORT",
        reason,
      },
      queryConditionedEvidence: trace,
    };
  });

  const supportedSignals = candidateSignals.filter(
    (signal) => signal.passageSupport.supported,
  );
  return {
    ...baseline,
    supported: supportedSignals.length > 0,
    reason:
      supportedSignals.length > 0
        ? "QUERY_CONDITIONED_SUPPORT"
        : "SUPPORT_NOT_DEMONSTRATED",
    supportedDocumentIds: [
      ...new Set(supportedSignals.map((signal) => signal.documentId)),
    ],
    supportedCandidateKeys: supportedSignals.map(
      (signal) => signal.candidateKey,
    ),
    candidateSignals,
  };
}
