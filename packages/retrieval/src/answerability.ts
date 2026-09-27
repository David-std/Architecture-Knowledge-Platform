import type { SearchHit } from "@akp/contracts";

const ANSWERABILITY_STOPWORDS = new Set([
  "and",
  "are",
  "como",
  "con",
  "cual",
  "cuales",
  "de",
  "del",
  "el",
  "en",
  "es",
  "esta",
  "este",
  "for",
  "from",
  "how",
  "is",
  "la",
  "las",
  "los",
  "para",
  "por",
  "que",
  "the",
  "una",
  "un",
  "what",
  "where",
  "which",
]);

const DIRECT_SUPPORT_CHANNELS = new Set([
  "exact",
  "code",
  "raw",
  "context-pack",
  "temporal",
]);

export interface RetrievalAnswerabilityPolicy {
  minimumSalientCoverage: number;
  minimumVectorTextMargin: number;
  /** Minimum adjacent separation used inside a semantic neighbourhood. */
  minimumVectorMargin: number;
  /**
   * Minimum top-to-background separation for pure semantic support.
   * With 3+ candidates the third vector candidate is the conservative
   * background reference, allowing two close relevant neighbours.
   */
  minimumVectorNeighborhoodMargin: number;
}

export interface RetrievalAnswerabilityContext {
  allowGraphSupport?: boolean;
  /**
   * Same-query candidates retained before the caller's presentation limit.
   * They are used only to measure vector separation; support must still come
   * from the returned hits.
   */
  comparisonHits?: readonly SearchHit[];
}

export type RetrievalAnswerabilityPolicyInput =
  Partial<RetrievalAnswerabilityPolicy>;

export const DEFAULT_RETRIEVAL_ANSWERABILITY_POLICY: RetrievalAnswerabilityPolicy =
  {
    minimumSalientCoverage: 0.1,
    minimumVectorTextMargin: 0.007,
    minimumVectorMargin: 0.03,
    minimumVectorNeighborhoodMargin: 0.06,
  };

export type RetrievalAnswerabilityReason =
  | "NO_CANDIDATES"
  | "VECTOR_GATE_NOT_APPLICABLE"
  | "DIRECT_CHANNEL_SUPPORT"
  | "LEXICAL_TEXT_SUPPORT"
  | "VECTOR_TEXT_SUPPORT"
  | "VECTOR_MARGIN_SUPPORT"
  | "VECTOR_NEIGHBORHOOD_SUPPORT"
  | "GRAPH_INTENT_SUPPORT"
  | "WEAK_SEMANTIC_NEIGHBORS";

export interface CandidateAnswerabilitySignal {
  documentId: string;
  externalId: string | null;
  finalScore: number;
  textualSupport: {
    queryTokens: string[];
    overlapTokens: string[];
    queryCoverage: number;
    salientQueryTokens: string[];
    salientOverlapTokens: string[];
    salientCoverage: number;
  };
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
  candidateSignals: CandidateAnswerabilitySignal[];
  topVectorScore: number | null;
  secondVectorScore: number | null;
  thirdVectorScore: number | null;
  vectorMargin: number | null;
  vectorNeighborhoodMargin: number | null;
}

function validFraction(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new Error(`${field} must be a finite number between 0 and 1`);
  }
  return value;
}

export function resolveRetrievalAnswerabilityPolicy(
  input: RetrievalAnswerabilityPolicyInput = {},
): RetrievalAnswerabilityPolicy {
  return {
    minimumSalientCoverage: validFraction(
      input.minimumSalientCoverage ??
        DEFAULT_RETRIEVAL_ANSWERABILITY_POLICY.minimumSalientCoverage,
      "minimumSalientCoverage",
    ),
    minimumVectorTextMargin: validFraction(
      input.minimumVectorTextMargin ??
        DEFAULT_RETRIEVAL_ANSWERABILITY_POLICY.minimumVectorTextMargin,
      "minimumVectorTextMargin",
    ),
    minimumVectorMargin: validFraction(
      input.minimumVectorMargin ??
        DEFAULT_RETRIEVAL_ANSWERABILITY_POLICY.minimumVectorMargin,
      "minimumVectorMargin",
    ),
    minimumVectorNeighborhoodMargin: validFraction(
      input.minimumVectorNeighborhoodMargin ??
        DEFAULT_RETRIEVAL_ANSWERABILITY_POLICY.minimumVectorNeighborhoodMargin,
      "minimumVectorNeighborhoodMargin",
    ),
  };
}

function normalizedTokens(value: string): string[] {
  return [
    ...new Set(
      (
        value
          .normalize("NFKD")
          .replace(/\p{M}/gu, "")
          .toLocaleLowerCase("en-US")
          .match(/[\p{L}\p{N}]+/gu) ?? []
      ).filter((token) => token.length >= 2),
    ),
  ];
}

export function collectCandidateAnswerabilitySignals(
  hits: readonly SearchHit[],
  query: string,
): CandidateAnswerabilitySignal[] {
  const queryTokens = normalizedTokens(query);
  const salientQueryTokens = queryTokens.filter(
    (token) => token.length >= 3 && !ANSWERABILITY_STOPWORDS.has(token),
  );

  return hits.map((hit) => {
    const candidateTokens = new Set(
      normalizedTokens(`${hit.title} ${hit.excerpt}`),
    );
    const overlapTokens = queryTokens.filter((token) =>
      candidateTokens.has(token),
    );
    const salientOverlapTokens = salientQueryTokens.filter((token) =>
      candidateTokens.has(token),
    );

    return {
      documentId: hit.documentId,
      externalId: hit.document.externalId,
      finalScore: hit.score,
      textualSupport: {
        queryTokens,
        overlapTokens,
        queryCoverage:
          queryTokens.length === 0
            ? 0
            : overlapTokens.length / queryTokens.length,
        salientQueryTokens,
        salientOverlapTokens,
        salientCoverage:
          salientQueryTokens.length === 0
            ? 0
            : salientOverlapTokens.length / salientQueryTokens.length,
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

function assessment(
  supported: boolean,
  reason: RetrievalAnswerabilityReason,
  candidateSignals: CandidateAnswerabilitySignal[],
  topVectorScore: number | null,
  secondVectorScore: number | null,
  thirdVectorScore: number | null = null,
): RetrievalAnswerabilityAssessment {
  return {
    supported,
    reason,
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
        ? topVectorScore - (thirdVectorScore ?? secondVectorScore ?? topVectorScore)
        : null,
  };
}

/**
 * Decides whether retrieved candidates are strong enough to leave the
 * retrieval layer as supported material.
 *
 * The gate is deliberately narrow:
 * - non-vector retrieval keeps its historical behavior;
 * - exact/code/raw/context-pack/temporal evidence is direct support;
 * - lexical support may establish direct textual support;
 * - vector text support needs both salient overlap and a minimum separation
 *   from the next semantic neighbour;
 * - pure semantic support uses neighbourhood separation rather than only the
 *   top-1/top-2 gap, so two close relevant neighbours do not look ambiguous;
 * - when only two semantic candidates exist, a stronger pairwise margin is
 *   required because no background neighbour is available;
 * - graph evidence is direct support only when the caller explicitly declares
 *   a graph-oriented intent.
 *
 * Community expansion is intentionally not treated as direct authority.
 */
export function assessRetrievalAnswerability(
  hits: readonly SearchHit[],
  query: string,
  policyInput: RetrievalAnswerabilityPolicyInput = {},
  context: RetrievalAnswerabilityContext = {},
): RetrievalAnswerabilityAssessment {
  const policy = resolveRetrievalAnswerabilityPolicy(policyInput);
  const candidateSignals = collectCandidateAnswerabilitySignals(hits, query);

  if (candidateSignals.length === 0) {
    return assessment(false, "NO_CANDIDATES", candidateSignals, null, null);
  }

  const vectorCandidates = candidateSignals
    .flatMap((signal) => {
      const score = vectorScore(signal);
      return score === null ? [] : [{ signal, score }];
    })
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.signal.documentId.localeCompare(right.signal.documentId),
    );
  const comparisonSignals = context.comparisonHits
    ? collectCandidateAnswerabilitySignals(context.comparisonHits, query)
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

  const topVector = vectorCandidates[0];
  const secondVector = topVector
    ? comparisonVectorCandidates.find(
        (candidate) =>
          candidate.signal.documentId !== topVector.signal.documentId,
      )
    : undefined;
  const thirdVector = topVector
    ? comparisonVectorCandidates.find(
        (candidate) =>
          candidate.signal.documentId !== topVector.signal.documentId &&
          candidate.signal.documentId !== secondVector?.signal.documentId,
      )
    : undefined;
  const topVectorScore = topVector?.score ?? null;
  const secondVectorScore = secondVector?.score ?? null;
  const thirdVectorScore = thirdVector?.score ?? null;

  if (
    candidateSignals.some((signal) =>
      signal.contributions.some((contribution) =>
        DIRECT_SUPPORT_CHANNELS.has(contribution.channel),
      ),
    )
  ) {
    return assessment(
      true,
      "DIRECT_CHANNEL_SUPPORT",
      candidateSignals,
      topVectorScore,
      secondVectorScore,
      thirdVectorScore,
    );
  }

  if (
    context.allowGraphSupport === true &&
    candidateSignals.some((signal) =>
      signal.contributions.some(
        (contribution) =>
          contribution.channel === "graph" ||
          contribution.channel === "graph-ppr",
      ),
    )
  ) {
    return assessment(
      true,
      "GRAPH_INTENT_SUPPORT",
      candidateSignals,
      topVectorScore,
      secondVectorScore,
      thirdVectorScore,
    );
  }

  const hasLexicalCandidate = candidateSignals.some((signal) =>
    signal.contributions.some(
      (contribution) => contribution.channel === "lexical",
    ),
  );
  if (
    candidateSignals.some(
      (signal) =>
        signal.textualSupport.salientCoverage >=
          policy.minimumSalientCoverage &&
        signal.contributions.some(
          (contribution) => contribution.channel === "lexical",
        ),
    )
  ) {
    return assessment(
      true,
      "LEXICAL_TEXT_SUPPORT",
      candidateSignals,
      topVectorScore,
      secondVectorScore,
      thirdVectorScore,
    );
  }

  if (vectorCandidates.length === 0 && hasLexicalCandidate) {
    return assessment(
      true,
      "VECTOR_GATE_NOT_APPLICABLE",
      candidateSignals,
      null,
      null,
      null,
    );
  }

  const vectorMargin =
    topVectorScore !== null && secondVectorScore !== null
      ? topVectorScore - secondVectorScore
      : null;

  if (
    topVector &&
    topVector.signal.textualSupport.salientCoverage >=
      policy.minimumSalientCoverage &&
    vectorMargin !== null &&
    vectorMargin >= policy.minimumVectorTextMargin
  ) {
    return assessment(
      true,
      "VECTOR_TEXT_SUPPORT",
      candidateSignals,
      topVectorScore,
      secondVectorScore,
      thirdVectorScore,
    );
  }

  const secondToThirdMargin =
    secondVectorScore !== null && thirdVectorScore !== null
      ? secondVectorScore - thirdVectorScore
      : null;
  const vectorNeighborhoodMargin =
    topVectorScore !== null
      ? topVectorScore -
        (thirdVectorScore ?? secondVectorScore ?? topVectorScore)
      : null;

  if (
    thirdVectorScore !== null &&
    vectorNeighborhoodMargin !== null &&
    vectorNeighborhoodMargin >= policy.minimumVectorNeighborhoodMargin &&
    ((vectorMargin !== null && vectorMargin >= policy.minimumVectorMargin) ||
      (secondToThirdMargin !== null &&
        secondToThirdMargin >= policy.minimumVectorMargin))
  ) {
    return assessment(
      true,
      "VECTOR_NEIGHBORHOOD_SUPPORT",
      candidateSignals,
      topVectorScore,
      secondVectorScore,
      thirdVectorScore,
    );
  }

  if (
    thirdVectorScore === null &&
    vectorMargin !== null &&
    vectorMargin >= policy.minimumVectorNeighborhoodMargin
  ) {
    return assessment(
      true,
      "VECTOR_MARGIN_SUPPORT",
      candidateSignals,
      topVectorScore,
      secondVectorScore,
      thirdVectorScore,
    );
  }

  return assessment(
    false,
    "WEAK_SEMANTIC_NEIGHBORS",
    candidateSignals,
    topVectorScore,
    secondVectorScore,
  );
}
