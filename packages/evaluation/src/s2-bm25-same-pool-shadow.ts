/**
 * Read-only, bounded S2 BM25 comparison over the SAME already-authorized
 * candidate pool. This is not a PostgreSQL lexical retriever or a full hybrid
 * RAG A/B: it cannot recover a source absent from the supplied pool, and a
 * BM25 relevance score cannot attest proposition entailment.
 *
 * Token boundaries are Unicode aware; language-specific morphology, stopwords,
 * synonyms and mixed-language retrieval must be evaluated separately before
 * replacing PostgreSQL's currently deployed ts_rank_cd.
 */
export interface S2Bm25Candidate {
  readonly candidateKey: string;
  readonly passage: string;
  /** Optional original retrieval ordering for paired diagnostics. */
  readonly baselineRank?: number;
}

export interface S2Bm25RankedCandidate {
  readonly candidateKey: string;
  readonly score: number;
  readonly rank: number;
  readonly baselineRank: number | null;
  readonly matchingQueryTerms: number;
}

export interface S2Bm25ShadowResult {
  readonly status: "EVALUATION_ONLY_SAME_POOL_NO_RETRIEVAL_OR_ADMISSION";
  readonly model: "BM25_OKAPI";
  readonly k1: 1.2;
  readonly b: 0.75;
  readonly queryTokenCount: number;
  readonly poolSize: number;
  readonly ordered: readonly S2Bm25RankedCandidate[];
  readonly sourceTruthVerified: false;
  readonly answersVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

/** NFKC preserves Spanish ñ/accents; no English-only stemming or stopwords. */
export function s2Bm25Tokens(text: string): string[] {
  return (
    text
      .normalize("NFKC")
      .toLocaleLowerCase("und")
      .match(/[\p{L}\p{N}]+(?:[_-][\p{L}\p{N}]+)*/gu) ?? []
  );
}

/**
 * Okapi BM25: idf=log(1+(N-df+0.5)/(df+0.5)), k1=1.2 and b=0.75.
 * Use actual candidate passage lengths and within-pool document frequencies,
 * never the constant vector similarity scale. The (query, pool) itself must
 * already be authorized, revision-pinned and source-bound by the caller.
 */
export function shadowS2Bm25SamePool(input: {
  readonly query: string;
  readonly candidates: readonly S2Bm25Candidate[];
}): S2Bm25ShadowResult {
  if (
    typeof input.query !== "string" ||
    input.query.length < 1 ||
    input.query.length > 4_096 ||
    !Array.isArray(input.candidates) ||
    input.candidates.length === 0 ||
    input.candidates.length > 500
  ) {
    throw new Error("S2_BM25_INVALID_QUERY_OR_BOUNDED_POOL");
  }
  const keys = new Set<string>();
  const documents = input.candidates.map((candidate) => {
    if (
      !candidate ||
      typeof candidate.candidateKey !== "string" ||
      candidate.candidateKey.length === 0 ||
      candidate.candidateKey.length > 256 ||
      keys.has(candidate.candidateKey) ||
      typeof candidate.passage !== "string" ||
      candidate.passage.length === 0 ||
      candidate.passage.length > 16_384 ||
      (candidate.baselineRank !== undefined &&
        (!Number.isSafeInteger(candidate.baselineRank) ||
          candidate.baselineRank < 1))
    ) {
      throw new Error("S2_BM25_AMBIGUOUS_OR_UNBOUNDED_SOURCE");
    }
    keys.add(candidate.candidateKey);
    const tokens = s2Bm25Tokens(candidate.passage);
    const terms = new Map<string, number>();
    for (const term of tokens) terms.set(term, (terms.get(term) ?? 0) + 1);
    return { candidate, tokens, terms };
  });
  const query = s2Bm25Tokens(input.query);
  const uniqueQuery = [...new Set(query)];
  const N = documents.length;
  const averageLength =
    documents.reduce((sum, document) => sum + document.tokens.length, 0) / N;
  const df = new Map<string, number>();
  for (const term of uniqueQuery) {
    df.set(
      term,
      documents.reduce(
        (sum, document) => sum + Number(document.terms.has(term)),
        0,
      ),
    );
  }
  const scored = documents.map(({ candidate, tokens, terms }) => {
    let score = 0;
    let matchingQueryTerms = 0;
    for (const term of uniqueQuery) {
      const tf = terms.get(term) ?? 0;
      if (tf === 0) continue;
      matchingQueryTerms++;
      const documentFrequency = df.get(term) ?? 0;
      const idf = Math.log(
        1 + (N - documentFrequency + 0.5) / (documentFrequency + 0.5),
      );
      const lengthNorm =
        1.2 * (1 - 0.75 + 0.75 * (tokens.length / Math.max(1, averageLength)));
      score += idf * ((tf * (1.2 + 1)) / (tf + lengthNorm));
    }
    return {
      candidateKey: candidate.candidateKey,
      score,
      rank: 0,
      baselineRank: candidate.baselineRank ?? null,
      matchingQueryTerms,
    };
  });
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      (a.baselineRank ?? Number.POSITIVE_INFINITY) -
        (b.baselineRank ?? Number.POSITIVE_INFINITY) ||
      a.candidateKey.localeCompare(b.candidateKey),
  );
  return {
    status: "EVALUATION_ONLY_SAME_POOL_NO_RETRIEVAL_OR_ADMISSION",
    model: "BM25_OKAPI",
    k1: 1.2,
    b: 0.75,
    queryTokenCount: query.length,
    poolSize: N,
    ordered: scored.map((candidate, index) => ({
      ...candidate,
      rank: index + 1,
    })),
    sourceTruthVerified: false,
    answersVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  };
}
