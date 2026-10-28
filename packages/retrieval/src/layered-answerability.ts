import { createHash } from "node:crypto";
import type { SearchHit } from "@akp/contracts";
import {
  assessRetrievalAnswerability,
  collidingRetrievalCandidateKeys,
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
  StructuredProposition,
  StructuredPropositionQuery,
} from "./evidence-admission.js";
import { sourceSpanUsesCodePointBoundaries } from "./source-verification.js";

/** The batch boundary of `LayeredEvidenceAdmissionPipeline`. */
export interface LayeredEvidenceAdmissionEvaluator {
  evaluateBatch(
    inputs: readonly LayeredEvidenceAdmissionInput[],
  ): Promise<EvidenceAdmissionDecision[]>;
}

/**
 * Internally supplied proof of an externally adjudicated question/SOURCE
 * relation, tied to an original UTF-8 SOURCE document. The resolver must
 * obtain the content and claims through an authorized, revision-scoped
 * application service; these checks bind its output but cannot authenticate
 * its identity or independently decide semantic truth.
 *
 * Never populate this from client JSON, a Reader output, a bare citation or
 * an unauthenticated temporal-fact validity timestamp.
 */
export interface GovernedLayeredPropositionProof {
  readonly originalQuestion: string;
  readonly originalQuestionSha256: string;
  readonly candidateKey: string;
  readonly documentId: string;
  readonly unitId: string | null;
  readonly vaultId: string;
  readonly revision: string;
  readonly path: string;
  readonly originalSourceBytes: Uint8Array;
  readonly originalSourceText: string;
  readonly originalSourceSha256: string;
  readonly excerptStartUtf16: number;
  readonly excerptEndUtf16: number;
  readonly queryProposition: StructuredPropositionQuery;
  readonly candidateProposition: StructuredProposition;
}

export interface GovernedLayeredPropositionPort {
  resolve(input: {
    readonly originalQuestion: string;
    readonly hit: SearchHit;
    /** Authenticated request identity when invoked by the API route. */
    readonly principalId?: string;
    readonly spaceId?: string;
  }): Promise<GovernedLayeredPropositionProof | null>;
}

export interface LayeredAnswerabilityOptions {
  /** Optional trusted-internal SOURCE/semantic projection port, fail-closed. */
  readonly governedPropositionPort?: GovernedLayeredPropositionPort;
  /** Leading candidates of the fused, reranked pool that may be admitted. */
  maxCandidates?: number;
  /** Recorded in traces of decisions that carry no reader identity. */
  admissionId?: string;
  /** Optional query-level abstention until N distinct documents provide support. */
  minimumDistinctDocuments?: number;
  /** Abstain if a checked source passage explicitly contradicts the claim. */
  abstainOnSourceConflict?: boolean;
}

export const DEFAULT_LAYERED_ADMISSION_MAX_CANDIDATES = 64;

const LAYERED_ADMISSION_FAILURE = "LAYERED_ADMISSION_FAILURE";
const governedUnavailableDecision: EvidenceAdmissionDecision = {
  layer: "STRUCTURED_PROPOSITION",
  verdict: { kind: "INSUFFICIENT" },
  reason: "GOVERNED_SOURCE_PROPOSITION_UNAVAILABLE",
};

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function originalBytesMatchText(bytes: Uint8Array, text: string): boolean {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes) === text;
  } catch {
    return false;
  }
}

function sourceBoundary(text: string, start: number, end: number): boolean {
  return (
    Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    end > start &&
    end <= text.length &&
    sourceSpanUsesCodePointBoundaries(text, start, end)
  );
}

/**
 * Structural custody only. The authenticated port must separately establish
 * question role, exact semantic equivalence and source authorization.
 * A valid hash and original quote are NOT proof of entailment.
 */
export function bindGovernedLayeredPropositionInput(
  query: string,
  hit: SearchHit,
  proof: GovernedLayeredPropositionProof | null,
): LayeredEvidenceAdmissionInput | null {
  if (
    !proof ||
    proof.originalQuestion !== query ||
    proof.originalQuestionSha256 !== sha256(query) ||
    proof.candidateKey !== retrievalAnswerabilityCandidateKey(hit) ||
    proof.documentId !== hit.documentId ||
    proof.unitId !== (hit.unitId ?? null) ||
    proof.vaultId !== hit.vaultId ||
    proof.revision !== hit.revision ||
    proof.path !== hit.document.path ||
    !(proof.originalSourceBytes instanceof Uint8Array) ||
    proof.originalSourceBytes.byteLength === 0 ||
    proof.originalSourceBytes.byteLength > 2_000_000 ||
    typeof proof.originalSourceText !== "string" ||
    !/^[0-9a-f]{64}$/u.test(proof.originalSourceSha256) ||
    proof.originalSourceSha256 !==
      createHash("sha256").update(proof.originalSourceBytes).digest("hex") ||
    !originalBytesMatchText(
      proof.originalSourceBytes,
      proof.originalSourceText,
    ) ||
    !sourceBoundary(
      proof.originalSourceText,
      proof.excerptStartUtf16,
      proof.excerptEndUtf16,
    ) ||
    proof.originalSourceText.slice(
      proof.excerptStartUtf16,
      proof.excerptEndUtf16,
    ) !== hit.excerpt ||
    !proof.queryProposition ||
    !proof.candidateProposition ||
    typeof proof.queryProposition.subject !== "string" ||
    typeof proof.queryProposition.predicate !== "string" ||
    typeof proof.candidateProposition.subject !== "string" ||
    typeof proof.candidateProposition.predicate !== "string" ||
    !proof.queryProposition.subject.trim() ||
    !proof.queryProposition.predicate.trim() ||
    !proof.candidateProposition.subject.trim() ||
    !proof.candidateProposition.predicate.trim() ||
    !proof.candidateProposition.quote ||
    !sourceBoundary(
      hit.excerpt,
      proof.candidateProposition.quote.startOffset,
      proof.candidateProposition.quote.endOffset,
    )
  )
    return null;
  return {
    query,
    hit,
    queryProposition: proof.queryProposition,
    candidateProposition: proof.candidateProposition,
    requireStructuredProposition: true,
  };
}
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
    // The effective decision layer, not an overridden reader proposal, owns
    // the attribution when a structural guard vetoes evidence.
    verifierId:
      decision.layer === "SEMANTIC_READER" && decision.readerId
        ? decision.readerId
        : `${admissionId}:${decision.layer}`,
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
  const minimumDistinctDocuments = options.minimumDistinctDocuments ?? 1;
  if (
    !Number.isSafeInteger(minimumDistinctDocuments) ||
    minimumDistinctDocuments < 1 ||
    minimumDistinctDocuments > 256
  ) {
    throw new Error(
      "layered admission minimumDistinctDocuments must be in [1,256]",
    );
  }
  const admissionId = options.admissionId ?? "layered-admission";
  const baseline = assessRetrievalAnswerability(
    hits,
    query,
    policyInput,
    context,
  );
  if (hits.length === 0) return baseline;

  // A candidate key identifies a document/unit, not its revision or bytes.
  // If duplicate keys reach this boundary, a verdict for one SOURCE passage
  // must never be reassigned to another passage (or a passage outside the
  // bounded reader window). Detect collisions across the *whole* pool.
  const collisions = collidingRetrievalCandidateKeys(hits);
  const collisionDecision: EvidenceAdmissionDecision = {
    layer: "STRUCTURAL_GUARD",
    verdict: { kind: "INSUFFICIENT" },
    reason: "LAYERED_CANDIDATE_KEY_COLLISION",
  };

  const window = hits.slice(0, maxCandidates);
  const uniqueWindow = window.filter(
    (hit) => !collisions.has(retrievalAnswerabilityCandidateKey(hit)),
  );
  const prepared = await Promise.all(
    uniqueWindow.map(async (hit) => {
      if (!options.governedPropositionPort) {
        return { input: { query, hit } as LayeredEvidenceAdmissionInput };
      }
      try {
        const proof = await options.governedPropositionPort.resolve({
          originalQuestion: query,
          hit,
        });
        const input = bindGovernedLayeredPropositionInput(query, hit, proof);
        return input ? { input } : { decision: governedUnavailableDecision };
      } catch {
        return { decision: governedUnavailableDecision };
      }
    }),
  );
  const evaluable = prepared.flatMap((item) =>
    item.input ? [item.input] : [],
  );
  let decisions: EvidenceAdmissionDecision[];
  if (evaluable.length === 0) {
    decisions = [];
  } else {
    try {
      const evaluated: unknown = await pipeline.evaluateBatch(evaluable);
      decisions =
        Array.isArray(evaluated) && evaluated.length === evaluable.length
          ? (evaluated as EvidenceAdmissionDecision[])
          : failureDecisions(evaluable.length);
    } catch {
      decisions = failureDecisions(evaluable.length);
    }
  }
  let nextDecision = 0;
  const verified: EvidenceAdmissionDecision[] = prepared.map(
    (item) =>
      item.decision ?? decisions[nextDecision++] ?? governedUnavailableDecision,
  );

  const traces = new Map<string, QueryConditionedEvidenceTrace>();
  for (const hit of hits) {
    const key = retrievalAnswerabilityCandidateKey(hit);
    if (collisions.has(key) && !traces.has(key)) {
      traces.set(key, layeredTrace(hit, collisionDecision, admissionId));
    }
  }
  let nextVerified = 0;
  for (const hit of window) {
    const key = retrievalAnswerabilityCandidateKey(hit);
    if (!collisions.has(key)) {
      traces.set(key, layeredTrace(hit, verified[nextVerified++], admissionId));
    }
  }
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

  const sourceBoundSignals = candidateSignals.filter(
    (signal) => signal.passageSupport.supported,
  );
  const distinctDocuments = new Set(
    sourceBoundSignals.map((signal) => signal.documentId),
  );
  // Source corroboration is a selective answer policy, not a claim that
  // documents are statistically independent or that the quotes are correct.
  const sourceConflict = candidateSignals.some(
    (signal) => signal.queryConditionedEvidence?.decision === "CONTRADICTS",
  );
  const supportedSignals =
    distinctDocuments.size >= minimumDistinctDocuments &&
    !(options.abstainOnSourceConflict && sourceConflict)
      ? sourceBoundSignals
      : [];
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
