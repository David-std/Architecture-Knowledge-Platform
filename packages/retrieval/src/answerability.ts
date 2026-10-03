import { contextualEvidenceSpanText } from "./contextual-evidence.js";
import type { SearchHit } from "@akp/contracts";
import {
  DEFAULT_DETERMINISTIC_PASSAGE_SUPPORT_POLICY,
  quantitativeEvidenceMatches,
  dateYearEvidenceMatches,
  explicitYearBindingsMatch,
  explicitYearValues,
  resolveDeterministicPassageSupportPolicy,
  verifyDeterministicPassageSupport,
  type DeterministicPassageSupportPolicy,
  type DeterministicPassageSupportSignal,
} from "./support-verifier.js";
import {
  SourceVerificationError,
  sourceVerificationFailureCode,
  validateSourceBoundVerification,
} from "./source-verification.js";

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
  /** SUPPORTS and CONTRADICTS must point to an inspectable source span. */
  evidenceSpan?: QueryConditionedEvidenceSpan;
  reason: string;
}

export interface QueryConditionedEvidenceVerifierInput {
  query: string;
  candidateKey: string;
  title: string;
  /** Section headings that scope the passage, outermost first. */
  headingPath?: readonly string[];
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
  /** Optional batched form; results are returned in input order. */
  verifyBatch?(
    inputs: readonly QueryConditionedEvidenceVerifierInput[],
  ): Promise<QueryConditionedEvidenceVerification[]>;
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
  | "CLAIM_RELATION_SUPPORT"
  | "CONCEPT_DEFINITION_SUPPORT"
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
  claimRelationDiagnostics: DeterministicPassageSupportSignal["claimRelationDiagnostics"];
  boundedAnchorCoverage: DeterministicPassageSupportSignal["boundedAnchorCoverage"];
  boundedRelationRoleMatched: DeterministicPassageSupportSignal["boundedRelationRoleMatched"];
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
    reason === "PASSAGE_CUE_SUPPORT" ||
    reason === "CLAIM_RELATION_SUPPORT" ||
    reason === "CONCEPT_DEFINITION_SUPPORT"
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
        claimRelationDiagnostics: passage.claimRelationDiagnostics,
        boundedAnchorCoverage: passage.boundedAnchorCoverage,
        boundedRelationRoleMatched: passage.boundedRelationRoleMatched,
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
    "CLAIM_RELATION_SUPPORT",
    "CONCEPT_DEFINITION_SUPPORT",
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
  return hit.excerpt.trim();
}

function hardDeterministicRequirementsSatisfied(
  signal: {
    passageSupport: Pick<
      CandidatePassageSupport,
      "requiredAnswerCues" | "matchedAnswerCues"
    >;
  },
  evidence: {
    query: string;
    valueText: string;
    scopedText: string;
    periodScope: string;
    factGroups?: readonly { valueText: string; scopedText: string }[];
  },
): boolean {
  if (!explicitYearBindingsMatch(evidence.periodScope, evidence.query))
    return false;
  return (["QUANTITY", "DATE_YEAR"] as const).every((cue) => {
    if (!signal.passageSupport.requiredAnswerCues.includes(cue)) return true;
    return (evidence.factGroups ?? [evidence]).every((group) =>
      cue === "QUANTITY"
        ? quantitativeEvidenceMatches(
            group.valueText,
            evidence.query,
            group.scopedText,
          )
        : dateYearEvidenceMatches(group.valueText, evidence.query),
    );
  });
}

function verifierInput(
  hit: SearchHit,
  query: string,
): QueryConditionedEvidenceVerifierInput {
  return {
    query,
    candidateKey: retrievalAnswerabilityCandidateKey(hit),
    title: hit.title,
    ...(hit.headingPath ? { headingPath: hit.headingPath } : {}),
    passage: exactCandidatePassage(hit),
    unitType: hit.unitType ?? null,
    parentUnitType: hit.parentUnitType ?? null,
    documentType: hit.type,
  };
}

function verificationTrace(
  verifier: QueryConditionedEvidenceVerifier,
  policy: QueryConditionedEvidencePolicy,
  input: QueryConditionedEvidenceVerifierInput,
  result: unknown,
): QueryConditionedEvidenceTrace {
  try {
    const verified = validateSourceBoundVerification(input.passage, result);
    return {
      verifierId: verifier.id,
      mode: policy.mode,
      decision: verified.decision,
      score: verified.score ?? null,
      reason: verified.reason,
      evidenceSpan: verified.evidenceSpan ?? null,
    };
  } catch (error) {
    return verifierErrorTrace(verifier, policy, error);
  }
}

function verifierErrorTrace(
  verifier: QueryConditionedEvidenceVerifier,
  policy: QueryConditionedEvidencePolicy,
  error: unknown,
): QueryConditionedEvidenceTrace {
  return {
    verifierId: verifier.id,
    mode: policy.mode,
    decision: "VERIFIER_ERROR",
    score: null,
    reason: sourceVerificationFailureCode(error),
    evidenceSpan: null,
  };
}

async function verifyQueryConditionedEvidence(
  hits: readonly SearchHit[],
  query: string,
  verifier: QueryConditionedEvidenceVerifier,
  policy: QueryConditionedEvidencePolicy,
): Promise<Map<string, QueryConditionedEvidenceTrace>> {
  const output = new Map<string, QueryConditionedEvidenceTrace>();
  const inputs = hits
    .slice(0, policy.maxCandidates)
    .map((hit) => verifierInput(hit, query));
  if (verifier.verifyBatch) {
    try {
      const results: unknown = await verifier.verifyBatch(inputs);
      if (!Array.isArray(results) || results.length !== inputs.length) {
        throw new SourceVerificationError(
          "QUERY_CONDITIONED_EVIDENCE_BATCH_SIZE_MISMATCH",
        );
      }
      inputs.forEach((input, index) =>
        output.set(
          input.candidateKey,
          verificationTrace(verifier, policy, input, results[index]),
        ),
      );
    } catch (error) {
      for (const input of inputs) {
        output.set(
          input.candidateKey,
          verifierErrorTrace(verifier, policy, error),
        );
      }
    }
    return output;
  }
  for (
    let offset = 0;
    offset < inputs.length;
    offset += policy.maxConcurrency
  ) {
    const batch = inputs.slice(offset, offset + policy.maxConcurrency);
    const rows = await Promise.all(
      batch.map(async (input) => {
        try {
          return [
            input.candidateKey,
            verificationTrace(
              verifier,
              policy,
              input,
              await verifier.verify(input),
            ),
          ] as const;
        } catch (error) {
          return [
            input.candidateKey,
            verifierErrorTrace(verifier, policy, error),
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
  // SUPPORTS reaches here only after validating its selected source facts.
  // A baseline over the raw table cannot veto the verified column scope.
  return "QUERY_CONDITIONED_SUPPORT";
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
  const hitsByKey = new Map(
    hits.map((hit) => [retrievalAnswerabilityCandidateKey(hit), hit]),
  );
  const candidateSignals = baseline.candidateSignals.map((signal) => {
    let trace =
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

    const hit = hitsByKey.get(signal.candidateKey);
    if (
      trace.decision === "SUPPORTS" &&
      trace.evidenceSpan &&
      hit &&
      signal.passageSupport.reason !== "DIRECT_CHANNEL_SUPPORT"
    ) {
      // Selected cell values retain their column scope, never sibling facts.
      const evidence = contextualEvidenceSpanText(
        exactCandidatePassage(hit),
        trace.evidenceSpan,
      );
      // Explicit periods in selected columns take precedence over wider
      // title/heading context. A model cannot substitute a neighboring period.
      const requestedYears = explicitYearValues(query);
      const periodScopeForCell = (
        cell: (typeof evidence.selectedCells)[number],
      ) =>
        explicitYearValues(cell.header).length ? cell.header : cell.rowScope;
      const periodCells = requestedYears.length
        ? evidence.selectedCells.filter(
            (cell) => explicitYearValues(periodScopeForCell(cell)).length > 0,
          )
        : [];
      const matchingPeriodCells = periodCells.filter((cell) =>
        explicitYearValues(periodScopeForCell(cell)).some((year) =>
          requestedYears.includes(year),
        ),
      );
      const periodEvidence = periodCells.length
        ? {
            valueText: matchingPeriodCells.map((cell) => cell.value).join("; "),
            scopedText: evidence.scopedText,
            periodScope: periodCells.map(periodScopeForCell).join("; "),
            factGroups: requestedYears.map((year) => {
              const cells = matchingPeriodCells.filter((cell) =>
                explicitYearValues(periodScopeForCell(cell)).includes(year),
              );
              return {
                valueText: cells.map((cell) => cell.value).join("; "),
                scopedText: cells
                  .map((cell) =>
                    [cell.rowScope, cell.header, cell.value].join("; "),
                  )
                  .join("; "),
              };
            }),
          }
        : {
            valueText: evidence.valueText,
            scopedText: evidence.scopedText,
            periodScope: explicitYearValues(evidence.scopedText).length
              ? evidence.scopedText
              : [
                  hit.title,
                  ...(hit.headingPath ?? []),
                  evidence.scopedText,
                ].join(" "),
          };
      const passageSupport = verifyDeterministicPassageSupport(
        { ...hit, excerpt: evidence.scopedText },
        query,
        policyInput,
      );
      if (passageSupport.reason === "NO_CONCRETE_PASSAGE") {
        trace = {
          ...trace,
          decision: "INSUFFICIENT",
          reason: "EVIDENCE_SPAN_NOT_ASSERTION",
        };
      } else if (
        !hardDeterministicRequirementsSatisfied(
          { passageSupport },
          { ...periodEvidence, query },
        )
      ) {
        trace = {
          ...trace,
          decision: "INSUFFICIENT",
          reason: "EVIDENCE_SPAN_MISSING_REQUIRED_FACT",
        };
      }
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
