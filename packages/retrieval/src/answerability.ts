import type { SearchHit } from "@akp/contracts";
import {
  DEFAULT_DETERMINISTIC_PASSAGE_SUPPORT_POLICY,
  resolveDeterministicPassageSupportPolicy,
  verifyDeterministicPassageSupport,
  type DeterministicPassageSupportPolicy,
  type DeterministicPassageSupportSignal,
} from "./support-verifier.js";

const DIRECT_SUPPORT_CHANNELS = new Set([
  "exact",
  "code",
  "raw",
  "context-pack",
  "temporal",
]);

export interface RetrievalAnswerabilityPolicy extends DeterministicPassageSupportPolicy {}

export type RetrievalAnswerabilityPolicyInput =
  Partial<RetrievalAnswerabilityPolicy>;

export const DEFAULT_RETRIEVAL_ANSWERABILITY_POLICY: RetrievalAnswerabilityPolicy =
  {
    ...DEFAULT_DETERMINISTIC_PASSAGE_SUPPORT_POLICY,
  };

export interface RetrievalAnswerabilityContext {
  allowGraphSupport?: boolean;
  /**
   * Authorized, truth-filtered candidates from the same query before the
   * presentation limit. They are diagnostic ranking context only; support is
   * established independently for each concrete passage.
   */
  comparisonHits?: readonly SearchHit[];
}

export type QueryConditionedEvidenceDecision =
  "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT";

export type QueryConditionedEvidenceVerifierMode = "SHADOW" | "ENFORCE";

export interface QueryConditionedEvidenceSpan {
  /** Zero-based UTF-16 offset in the exact passage supplied to the verifier. */
  startOffset: number;
  /** Exclusive zero-based UTF-16 offset in the exact passage supplied to the verifier. */
  endOffset: number;
}

export interface QueryConditionedEvidenceVerification {
  decision: QueryConditionedEvidenceDecision;
  /** Optional calibrated provider score. Core policy never treats it as proof. */
  score?: number;
  /** SUPPORTS must point to an inspectable span in the supplied passage. */
  evidenceSpan?: QueryConditionedEvidenceSpan;
  reason: string;
}

export interface QueryConditionedEvidenceVerifierInput {
  query: string;
  candidateKey: string;
  title: string;
  passage: string;
  unitType: string | null;
  parentUnitType: string | null;
  documentType: string;
}

export interface QueryConditionedEvidenceVerifier {
  readonly id: string;
  verify(
    input: QueryConditionedEvidenceVerifierInput,
  ): Promise<QueryConditionedEvidenceVerification>;
}

export interface QueryConditionedEvidencePolicy {
  mode: QueryConditionedEvidenceVerifierMode;
  maxCandidates: number;
  maxConcurrency: number;
}

export const DEFAULT_QUERY_CONDITIONED_EVIDENCE_POLICY: QueryConditionedEvidencePolicy =
  Object.freeze({
    mode: "SHADOW",
    maxCandidates: 64,
    maxConcurrency: 4,
  });

export interface QueryConditionedEvidenceTrace {
  verifierId: string;
  mode: QueryConditionedEvidenceVerifierMode;
  decision:
    QueryConditionedEvidenceDecision | "VERIFIER_ERROR" | "NOT_VERIFIED";
  score: number | null;
  reason: string;
  evidenceSpan: QueryConditionedEvidenceSpan | null;
}

export type CandidateSupportReason =
  | "DIRECT_CHANNEL_SUPPORT"
  | "GRAPH_INTENT_SUPPORT"
  | "QUERY_CONDITIONED_SUPPORT"
  | "QUERY_CONDITIONED_CONTRADICTION"
  | "QUERY_CONDITIONED_INSUFFICIENT"
  | "QUERY_CONDITIONED_VERIFIER_ERROR"
  | DeterministicPassageSupportSignal["reason"];

export type RetrievalAnswerabilityReason =
  | "NO_CANDIDATES"
  | "DIRECT_CHANNEL_SUPPORT"
  | "GRAPH_INTENT_SUPPORT"
  | "QUERY_CONDITIONED_SUPPORT"
  | "PASSAGE_TEXT_SUPPORT"
  | "PASSAGE_CUE_SUPPORT"
  | "SUPPORT_NOT_DEMONSTRATED";

export interface CandidatePassageSupport {
  supported: boolean;
  reason: CandidateSupportReason;
  passageSource: DeterministicPassageSupportSignal["passageSource"];
  passageCharacters: number;
  excerptCharacters: number;
  supportSurfaceExtendsExcerpt: boolean;
  requiredAnswerCues: DeterministicPassageSupportSignal["requiredAnswerCues"];
  matchedAnswerCues: DeterministicPassageSupportSignal["matchedAnswerCues"];
  answerCueCoverage: number;
  vectorRank: number | null;
}

export interface CandidateAnswerabilitySignal {
  documentId: string;
  unitId: string | null;
  candidateKey: string;
  externalId: string | null;
  candidateRank: number;
  finalScore: number;
  textualSupport: Pick<
    DeterministicPassageSupportSignal,
    | "queryTokens"
    | "overlapTokens"
    | "queryCoverage"
    | "salientQueryTokens"
    | "salientOverlapTokens"
    | "salientCoverage"
  >;
  passageSupport: CandidatePassageSupport;
  contributions: Array<{
    channel: string;
    rank: number;
    channelWeight: number;
    rawScore: number | null;
    reason: string;
  }>;
  rerank: SearchHit["rerankTrace"] | null;
  queryConditionedEvidence?: QueryConditionedEvidenceTrace;
}

export interface RetrievalAnswerabilityAssessment {
  supported: boolean;
  reason: RetrievalAnswerabilityReason;
  /** Compatibility/document-level summary; do not use to admit passages. */
  supportedDocumentIds: string[];
  /** Concrete passages that independently demonstrated support. */
  supportedCandidateKeys: string[];
  candidateSignals: CandidateAnswerabilitySignal[];
  topVectorScore: number | null;
  secondVectorScore: number | null;
  thirdVectorScore: number | null;
  vectorMargin: number | null;
  vectorNeighborhoodMargin: number | null;
}

export function resolveRetrievalAnswerabilityPolicy(
  input: RetrievalAnswerabilityPolicyInput = {},
): RetrievalAnswerabilityPolicy {
  return resolveDeterministicPassageSupportPolicy(input);
}

export function retrievalAnswerabilityCandidateKey(
  hit: Pick<SearchHit, "documentId" | "unitId">,
): string {
  return `${hit.documentId}:${hit.unitId ?? "document"}`;
}

function normalizedIdentity(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLocaleLowerCase("en-US");
}

function identifierLikeQuery(query: string): boolean {
  const trimmed = query.trim();
  if (
    !trimmed ||
    /\s/u.test(trimmed) ||
    !/^[\p{L}\p{N}_.:/-]+$/u.test(trimmed)
  ) {
    return false;
  }
  return (
    /\d/u.test(trimmed) ||
    /[_:/.]/u.test(trimmed) ||
    (trimmed.includes("-") && trimmed === trimmed.toLocaleUpperCase("en-US"))
  );
}

function exactIdentifierMatchesHit(hit: SearchHit, query: string): boolean {
  if (!identifierLikeQuery(query)) return false;
  const needle = normalizedIdentity(query);
  const path = normalizedIdentity(hit.document.path);
  const pathLeaf = path.split("/").at(-1) ?? path;
  const pathStem = pathLeaf.replace(/\.[^.]+$/u, "");
  const identities = [
    hit.document.externalId,
    hit.title,
    hit.document.title,
    path,
    pathLeaf,
    pathStem,
  ]
    .filter((value): value is string => typeof value === "string")
    .map(normalizedIdentity);
  return identities.includes(needle);
}

function supportReasonForCandidate(
  hit: SearchHit,
  passage: DeterministicPassageSupportSignal,
  allowGraphSupport: boolean,
  query: string,
): CandidateSupportReason {
  const directChannel = (hit.fusionContributions ?? []).some((contribution) =>
    DIRECT_SUPPORT_CHANNELS.has(contribution.channel),
  );
  if (directChannel && exactIdentifierMatchesHit(hit, query)) {
    return "DIRECT_CHANNEL_SUPPORT";
  }

  // Retrieval channels and graph topology rank candidates; they are not
  // evidence that a natural-language predicate is answered. Keep the graph
  // flag for diagnostics/caller policy, but require passage support itself.
  if (
    allowGraphSupport &&
    passage.supported &&
    (hit.fusionContributions ?? []).some(
      (contribution) =>
        contribution.channel === "graph" ||
        contribution.channel === "graph-ppr",
    )
  ) {
    return passage.reason;
  }
  return passage.reason;
}

function supportedReason(reason: CandidateSupportReason): boolean {
  return (
    reason === "DIRECT_CHANNEL_SUPPORT" ||
    reason === "GRAPH_INTENT_SUPPORT" ||
    reason === "QUERY_CONDITIONED_SUPPORT" ||
    reason === "PASSAGE_TEXT_SUPPORT" ||
    reason === "PASSAGE_CUE_SUPPORT"
  );
}

export function collectCandidateAnswerabilitySignals(
  hits: readonly SearchHit[],
  query: string,
  policyInput: RetrievalAnswerabilityPolicyInput = {},
  context: Pick<RetrievalAnswerabilityContext, "allowGraphSupport"> = {},
): CandidateAnswerabilitySignal[] {
  const policy = resolveRetrievalAnswerabilityPolicy(policyInput);
  return hits.map((hit, index) => {
    const passage = verifyDeterministicPassageSupport(hit, query, policy);
    const supportReason = supportReasonForCandidate(
      hit,
      passage,
      context.allowGraphSupport === true,
      query,
    );
    return {
      documentId: hit.documentId,
      unitId: hit.unitId ?? null,
      candidateKey: retrievalAnswerabilityCandidateKey(hit),
      externalId: hit.document.externalId,
      candidateRank: index + 1,
      finalScore: hit.score,
      textualSupport: {
        queryTokens: passage.queryTokens,
        overlapTokens: passage.overlapTokens,
        queryCoverage: passage.queryCoverage,
        salientQueryTokens: passage.salientQueryTokens,
        salientOverlapTokens: passage.salientOverlapTokens,
        salientCoverage: passage.salientCoverage,
      },
      passageSupport: {
        passageSource: passage.passageSource,
        passageCharacters: passage.passageCharacters,
        excerptCharacters: passage.excerptCharacters,
        supportSurfaceExtendsExcerpt: passage.supportSurfaceExtendsExcerpt,
        requiredAnswerCues: passage.requiredAnswerCues,
        matchedAnswerCues: passage.matchedAnswerCues,
        answerCueCoverage: passage.answerCueCoverage,
        vectorRank: passage.vectorRank,
        supported: supportedReason(supportReason),
        reason: supportReason,
      },
      contributions: (hit.fusionContributions ?? []).map((contribution) => ({
        channel: contribution.channel,
        rank: contribution.rank,
        channelWeight: contribution.channelWeight,
        rawScore: contribution.rawScore ?? null,
        reason: contribution.reason,
      })),
      rerank: hit.rerankTrace ?? null,
    };
  });
}

function vectorScore(signal: CandidateAnswerabilitySignal): number | null {
  const scores = signal.contributions.flatMap((contribution) =>
    contribution.channel === "vector" &&
    typeof contribution.rawScore === "number" &&
    Number.isFinite(contribution.rawScore)
      ? [contribution.rawScore]
      : [],
  );
  return scores.length ? Math.max(...scores) : null;
}

function topLevelReason(
  signals: readonly CandidateAnswerabilitySignal[],
): RetrievalAnswerabilityReason {
  const supported = signals.filter((signal) => signal.passageSupport.supported);
  if (supported.length === 0) return "SUPPORT_NOT_DEMONSTRATED";
  const reasons = supported.map((signal) => signal.passageSupport.reason);
  for (const reason of [
    "DIRECT_CHANNEL_SUPPORT",
    "GRAPH_INTENT_SUPPORT",
    "QUERY_CONDITIONED_SUPPORT",
    "PASSAGE_TEXT_SUPPORT",
    "PASSAGE_CUE_SUPPORT",
  ] as const) {
    if (reasons.includes(reason)) return reason;
  }
  return "SUPPORT_NOT_DEMONSTRATED";
}

/**
 * Determines which authorized retrieved passages can actually support an
 * answer. Retrieval rank and vector geometry remain diagnostics; they never
 * turn a candidate into evidence by themselves.
 */
export function assessRetrievalAnswerability(
  hits: readonly SearchHit[],
  query: string,
  policyInput: RetrievalAnswerabilityPolicyInput = {},
  context: RetrievalAnswerabilityContext = {},
): RetrievalAnswerabilityAssessment {
  const candidateSignals = collectCandidateAnswerabilitySignals(
    hits,
    query,
    policyInput,
    context,
  );

  if (candidateSignals.length === 0) {
    return {
      supported: false,
      reason: "NO_CANDIDATES",
      supportedDocumentIds: [],
      supportedCandidateKeys: [],
      candidateSignals,
      topVectorScore: null,
      secondVectorScore: null,
      thirdVectorScore: null,
      vectorMargin: null,
      vectorNeighborhoodMargin: null,
    };
  }

  const supportedSignals = candidateSignals.filter(
    (signal) => signal.passageSupport.supported,
  );
  const supportedDocumentIds = [
    ...new Set(supportedSignals.map((signal) => signal.documentId)),
  ];
  const supportedCandidateKeys = supportedSignals.map(
    (signal) => signal.candidateKey,
  );
  const comparisonSignals = context.comparisonHits
    ? collectCandidateAnswerabilitySignals(
        context.comparisonHits,
        query,
        policyInput,
        context,
      )
    : candidateSignals;
  const comparisonVectorCandidates = comparisonSignals
    .flatMap((signal) => {
      const score = vectorScore(signal);
      return score === null ? [] : [{ signal, score }];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.signal.documentId.localeCompare(right.signal.documentId),
    );
  const topVectorScore = comparisonVectorCandidates[0]?.score ?? null;
  const secondVectorScore = comparisonVectorCandidates[1]?.score ?? null;
  const thirdVectorScore = comparisonVectorCandidates[2]?.score ?? null;

  return {
    supported: supportedCandidateKeys.length > 0,
    reason: topLevelReason(candidateSignals),
    supportedDocumentIds,
    supportedCandidateKeys,
    candidateSignals,
    topVectorScore,
    secondVectorScore,
    thirdVectorScore,
    vectorMargin:
      topVectorScore !== null && secondVectorScore !== null
        ? topVectorScore - secondVectorScore
        : null,
    vectorNeighborhoodMargin:
      topVectorScore !== null
        ? topVectorScore -
          (thirdVectorScore ?? secondVectorScore ?? topVectorScore)
        : null,
  };
}

function resolveQueryConditionedEvidencePolicy(
  input: Partial<QueryConditionedEvidencePolicy> = {},
): QueryConditionedEvidencePolicy {
  const mode = input.mode ?? DEFAULT_QUERY_CONDITIONED_EVIDENCE_POLICY.mode;
  if (mode !== "SHADOW" && mode !== "ENFORCE") {
    throw new Error(
      "query-conditioned evidence mode must be SHADOW or ENFORCE",
    );
  }
  const integer = (value: number, field: string): number => {
    if (!Number.isSafeInteger(value) || value < 1 || value > 256) {
      throw new Error(`${field} must be an integer between 1 and 256`);
    }
    return value;
  };
  return {
    mode,
    maxCandidates: integer(
      input.maxCandidates ??
        DEFAULT_QUERY_CONDITIONED_EVIDENCE_POLICY.maxCandidates,
      "query-conditioned evidence maxCandidates",
    ),
    maxConcurrency: integer(
      input.maxConcurrency ??
        DEFAULT_QUERY_CONDITIONED_EVIDENCE_POLICY.maxConcurrency,
      "query-conditioned evidence maxConcurrency",
    ),
  };
}

function exactCandidatePassage(hit: SearchHit): string {
  return hit.parentContext?.trim() || hit.excerpt.trim();
}

function hardDeterministicRequirementsSatisfied(
  signal: CandidateAnswerabilitySignal,
): boolean {
  return (["QUANTITY", "DATE_YEAR"] as const).every(
    (cue) =>
      !signal.passageSupport.requiredAnswerCues.includes(cue) ||
      signal.passageSupport.matchedAnswerCues.includes(cue),
  );
}

function validateQueryConditionedVerification(
  passage: string,
  result: QueryConditionedEvidenceVerification,
): QueryConditionedEvidenceVerification {
  if (
    result.decision !== "SUPPORTS" &&
    result.decision !== "CONTRADICTS" &&
    result.decision !== "INSUFFICIENT"
  ) {
    throw new Error("QUERY_CONDITIONED_EVIDENCE_DECISION_INVALID");
  }
  if (!result.reason?.trim()) {
    throw new Error("QUERY_CONDITIONED_EVIDENCE_REASON_REQUIRED");
  }
  if (
    result.score !== undefined &&
    (!Number.isFinite(result.score) || result.score < 0 || result.score > 1)
  ) {
    throw new Error("QUERY_CONDITIONED_EVIDENCE_SCORE_INVALID");
  }
  if (result.decision === "SUPPORTS") {
    const span = result.evidenceSpan;
    if (
      !span ||
      !Number.isSafeInteger(span.startOffset) ||
      !Number.isSafeInteger(span.endOffset) ||
      span.startOffset < 0 ||
      span.endOffset <= span.startOffset ||
      span.endOffset > passage.length
    ) {
      throw new Error("QUERY_CONDITIONED_EVIDENCE_SPAN_REQUIRED");
    }
  }
  return { ...result, reason: result.reason.trim() };
}

async function verifyQueryConditionedEvidence(
  hits: readonly SearchHit[],
  query: string,
  verifier: QueryConditionedEvidenceVerifier,
  policy: QueryConditionedEvidencePolicy,
): Promise<Map<string, QueryConditionedEvidenceTrace>> {
  const output = new Map<string, QueryConditionedEvidenceTrace>();
  const candidates = hits.slice(0, policy.maxCandidates);
  for (
    let offset = 0;
    offset < candidates.length;
    offset += policy.maxConcurrency
  ) {
    const batch = candidates.slice(offset, offset + policy.maxConcurrency);
    const rows = await Promise.all(
      batch.map(async (hit) => {
        const candidateKey = retrievalAnswerabilityCandidateKey(hit);
        const passage = exactCandidatePassage(hit);
        try {
          const result = validateQueryConditionedVerification(
            passage,
            await verifier.verify({
              query,
              candidateKey,
              title: hit.title,
              passage,
              unitType: hit.unitType ?? null,
              parentUnitType: hit.parentUnitType ?? null,
              documentType: hit.type,
            }),
          );
          return [
            candidateKey,
            {
              verifierId: verifier.id,
              mode: policy.mode,
              decision: result.decision,
              score: result.score ?? null,
              reason: result.reason,
              evidenceSpan: result.evidenceSpan ?? null,
            } satisfies QueryConditionedEvidenceTrace,
          ] as const;
        } catch (error) {
          return [
            candidateKey,
            {
              verifierId: verifier.id,
              mode: policy.mode,
              decision: "VERIFIER_ERROR",
              score: null,
              reason:
                error instanceof Error
                  ? error.message
                  : "QUERY_CONDITIONED_EVIDENCE_VERIFIER_ERROR",
              evidenceSpan: null,
            } satisfies QueryConditionedEvidenceTrace,
          ] as const;
        }
      }),
    );
    for (const [candidateKey, trace] of rows) output.set(candidateKey, trace);
  }
  return output;
}

function enforcedQueryConditionedReason(
  baseline: CandidateAnswerabilitySignal,
  trace: QueryConditionedEvidenceTrace,
): CandidateSupportReason {
  if (baseline.passageSupport.reason === "DIRECT_CHANNEL_SUPPORT") {
    return "DIRECT_CHANNEL_SUPPORT";
  }
  if (trace.decision === "VERIFIER_ERROR") {
    return "QUERY_CONDITIONED_VERIFIER_ERROR";
  }
  if (trace.decision === "CONTRADICTS") {
    return "QUERY_CONDITIONED_CONTRADICTION";
  }
  if (trace.decision !== "SUPPORTS") {
    return "QUERY_CONDITIONED_INSUFFICIENT";
  }
  return hardDeterministicRequirementsSatisfied(baseline)
    ? "QUERY_CONDITIONED_SUPPORT"
    : "QUERY_CONDITIONED_INSUFFICIENT";
}

/**
 * Optional query-conditioned passage verification.
 *
 * SHADOW records decisions without changing the current deterministic gate.
 * ENFORCE requires SUPPORTS plus a concrete evidence span for natural-language
 * candidates. Exact identifiers remain deterministic and quantity/year gates
 * remain hard requirements that a verifier score cannot override.
 */
export async function assessRetrievalAnswerabilityWithVerifier(
  hits: readonly SearchHit[],
  query: string,
  verifier: QueryConditionedEvidenceVerifier,
  verifierPolicyInput: Partial<QueryConditionedEvidencePolicy> = {},
  policyInput: RetrievalAnswerabilityPolicyInput = {},
  context: RetrievalAnswerabilityContext = {},
): Promise<RetrievalAnswerabilityAssessment> {
  const verifierPolicy =
    resolveQueryConditionedEvidencePolicy(verifierPolicyInput);
  const baseline = assessRetrievalAnswerability(
    hits,
    query,
    policyInput,
    context,
  );
  if (hits.length === 0) return baseline;

  const traces = await verifyQueryConditionedEvidence(
    hits,
    query,
    verifier,
    verifierPolicy,
  );
  const candidateSignals = baseline.candidateSignals.map((signal) => {
    const trace =
      traces.get(signal.candidateKey) ??
      ({
        verifierId: verifier.id,
        mode: verifierPolicy.mode,
        decision: "NOT_VERIFIED",
        score: null,
        reason: "QUERY_CONDITIONED_EVIDENCE_OUTSIDE_BOUNDED_WINDOW",
        evidenceSpan: null,
      } satisfies QueryConditionedEvidenceTrace);

    if (verifierPolicy.mode === "SHADOW") {
      return { ...signal, queryConditionedEvidence: trace };
    }

    const reason = enforcedQueryConditionedReason(signal, trace);
    return {
      ...signal,
      passageSupport: {
        ...signal.passageSupport,
        supported: supportedReason(reason),
        reason,
      },
      queryConditionedEvidence: trace,
    };
  });

  if (verifierPolicy.mode === "SHADOW") {
    return { ...baseline, candidateSignals };
  }

  const supportedSignals = candidateSignals.filter(
    (signal) => signal.passageSupport.supported,
  );
  return {
    ...baseline,
    supported: supportedSignals.length > 0,
    reason:
      supportedSignals.length > 0
        ? topLevelReason(candidateSignals)
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
