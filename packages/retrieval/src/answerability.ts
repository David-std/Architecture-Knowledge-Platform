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

export type CandidateSupportReason =
  | "DIRECT_CHANNEL_SUPPORT"
  | "GRAPH_INTENT_SUPPORT"
  | DeterministicPassageSupportSignal["reason"];

export type RetrievalAnswerabilityReason =
  | "NO_CANDIDATES"
  | "DIRECT_CHANNEL_SUPPORT"
  | "GRAPH_INTENT_SUPPORT"
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
