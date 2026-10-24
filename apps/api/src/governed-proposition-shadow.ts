import type { SearchHit } from "@akp/contracts";
import {
  LayeredEvidenceAdmissionPipeline,
  projectSupportedTemporalFact,
  resolveTemporalFactPropositionForCandidate,
  type EvidenceAdmissionDecision,
  type SemanticEvidenceReader,
  type StructuredPropositionQuery,
} from "@akp/retrieval";
import {
  PostgresTemporalTruthStore,
  type GovernedTemporalFactEvidenceBundle,
  type Postgres,
} from "@akp/postgres";

export interface GovernedTemporalPropositionShadowInput {
  readonly spaceId: string;
  readonly hit: SearchHit;
  readonly query: string;
  readonly queryProposition: StructuredPropositionQuery;
  readonly authorizationPathPrefixes: Array<string | null>;
  readonly validAt?: string;
}

export interface GovernedTemporalPropositionShadowDecision {
  readonly sourceFactId: string;
  readonly supportSetId: string;
  readonly evidenceId: string;
  readonly decision: EvidenceAdmissionDecision;
}

export interface GovernedTemporalPropositionShadowResult {
  readonly evaluatedFacts: number;
  readonly projectedFacts: number;
  readonly resolvedCandidates: number;
  readonly decisions: readonly GovernedTemporalPropositionShadowDecision[];
}

const failClosedSemanticReader: SemanticEvidenceReader = {
  id: "shadow:structured-only",
  async read() {
    return {
      layer: "SEMANTIC_READER",
      verdict: { kind: "INSUFFICIENT" },
      reason: "SHADOW_SEMANTIC_READER_DISABLED",
      readerId: "shadow:structured-only",
    };
  },
};

function projectBundle(bundle: GovernedTemporalFactEvidenceBundle) {
  return projectSupportedTemporalFact({
    fact: bundle.fact,
    supportSet: bundle.supportSet,
    evidence: bundle.evidence,
  });
}

/**
 * Executes the governed structured-proposition arm as a shadow-only path.
 *
 * The query proposition is explicit caller input; this service performs no
 * free-text semantic extraction. Persistence supplies only current,
 * authorized facts and evidence linked to the candidate document. No returned
 * decision changes production answerability or hit selection.
 */
export async function evaluateGovernedTemporalPropositionShadow(
  db: Postgres,
  input: GovernedTemporalPropositionShadowInput,
): Promise<GovernedTemporalPropositionShadowResult> {
  const bundles = await new PostgresTemporalTruthStore(
    db,
  ).governedFactEvidenceForDocument({
    spaceId: input.spaceId,
    vaultId: input.hit.vaultId,
    documentId: input.hit.documentId,
    authorizationPathPrefixes: input.authorizationPathPrefixes,
    ...(input.validAt ? { validAt: input.validAt } : {}),
  });

  const pipeline = new LayeredEvidenceAdmissionPipeline({
    semanticReader: failClosedSemanticReader,
  });
  const decisions: GovernedTemporalPropositionShadowDecision[] = [];
  let projectedFacts = 0;
  let resolvedCandidates = 0;

  for (const bundle of bundles) {
    const projection = projectBundle(bundle);
    if (!projection) continue;
    projectedFacts += 1;
    const resolved = resolveTemporalFactPropositionForCandidate(
      projection,
      input.hit,
      bundle.evidence.map((evidence) => evidence.id),
    );
    if (!resolved) continue;
    resolvedCandidates += 1;
    decisions.push({
      sourceFactId: projection.sourceFactId,
      supportSetId: projection.supportSetId,
      evidenceId: resolved.evidenceId,
      decision: await pipeline.evaluate({
        query: input.query,
        hit: input.hit,
        queryProposition: input.queryProposition,
        candidateProposition: resolved.proposition,
      }),
    });
  }

  return {
    evaluatedFacts: bundles.length,
    projectedFacts,
    resolvedCandidates,
    decisions,
  };
}
