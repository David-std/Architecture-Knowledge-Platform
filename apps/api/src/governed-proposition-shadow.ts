import type { SearchHit } from "@akp/contracts";
import type { ObjectStore } from "@akp/object-store";
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
import { verifyGovernedRawSourceExcerpt } from "./governed-source-integrity.js";

export interface GovernedTemporalPropositionShadowInput {
  readonly spaceId: string;
  /** Required to prove that a persisted quote exists in original SOURCE bytes. */
  readonly rawObjectStore?: ObjectStore;
  readonly hit: SearchHit;
  readonly query: string;
  readonly queryProposition: StructuredPropositionQuery & {
    /** Unproved semantic qualifiers are explicitly rejected in this shadow. */
    readonly conditions?: readonly string[];
    readonly temporalScope?: string;
    readonly quantityUnit?: string;
    readonly modality?: "REQUIRED" | "PERMITTED" | "PROHIBITED" | "OPTIONAL";
  };
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
  // This shadow projection can prove only a fully identified positive/negative
  // temporal fact. Unsupported qualifiers must not be silently ignored by the
  // older exact matcher (which does not implement a general entailment engine).
  // Never infer polarity or qualifiers from the natural-language query.
  if (
    !input.rawObjectStore ||
    !input.queryProposition.polarity ||
    // An omitted or empty object is a wildcard in the generic matcher.
    // The governed path cannot prove a complete subject→predicate→object
    // proposition from a wildcard assertion in a free-text question.
    !input.queryProposition.object?.trim() ||
    input.queryProposition.conditions?.length ||
    input.queryProposition.temporalScope !== undefined ||
    input.queryProposition.quantityUnit !== undefined ||
    input.queryProposition.modality !== undefined
  ) {
    return {
      evaluatedFacts: 0,
      projectedFacts: 0,
      resolvedCandidates: 0,
      decisions: [],
    };
  }
  const bundles = await new PostgresTemporalTruthStore(
    db,
  ).governedFactEvidenceForDocument({
    spaceId: input.spaceId,
    vaultId: input.hit.vaultId,
    documentId: input.hit.documentId,
    documentPath: input.hit.document.path,
    documentRevision: input.hit.revision,
    authorizationPathPrefixes: input.authorizationPathPrefixes,
    ...(input.validAt ? { validAt: input.validAt } : {}),
  });

  const pipeline = new LayeredEvidenceAdmissionPipeline({
    semanticReader: failClosedSemanticReader,
    // A mismatch against source-governed fact slots is not a license to
    // fall back to an LLM, even if a future shadow reader is attached.
    structuredMismatchPolicy: "ABSTAIN",
  });
  const decisions: GovernedTemporalPropositionShadowDecision[] = [];
  let projectedFacts = 0;
  let resolvedCandidates = 0;

  for (const bundle of bundles) {
    const projection = projectBundle(bundle);
    if (!projection) continue;
    // Every support evidence ID must be grounded in the verified immutable
    // SOURCE object; a missing object or an unsupported locator abstains.
    let rawEvidenceVerified = true;
    for (const evidence of bundle.evidence) {
      if (
        !(await verifyGovernedRawSourceExcerpt(input.rawObjectStore, evidence))
      ) {
        rawEvidenceVerified = false;
        break;
      }
    }
    if (!rawEvidenceVerified) continue;
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
