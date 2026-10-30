/**
 * Shadow-only structural predicate-argument consistency check.
 * A generative extractor proposes *verbatim* grammatical actors.
 * The deterministic validator binds each to its actual source string,
 * catching swapped named subjects even when NLI wrongly says SUPPORTS.
 * It is NOT an entailment validator, source authorization, or release gate.
 */
export interface S2ActorPairExtraction {
  readonly sourceActor: string | null;
  readonly claimActor: string | null;
  readonly sourcePredicate?: string | null;
  readonly claimPredicate?: string | null;
}
export interface S2ActorBindingResult {
  readonly status:
    "ACTOR_MATCH_CANDIDATE" | "ACTOR_MISMATCH" | "INDETERMINATE" | "REJECTED";
  readonly reason: string;
  readonly sourceActor: string | null;
  readonly claimActor: string | null;
  readonly sourceBound: boolean;
  readonly claimBound: boolean;
  /** Only reports literal predicate correspondence, never synonymous meaning or entailment. */
  readonly relationSurfaceStatus:
    | "LEXICALLY_ALIGNED"
    | "LEXICALLY_DIVERGENT"
    | "PREDICATE_UNBOUND"
    | "PREDICATE_NOT_PROVIDED";
  readonly relationSurfaceReason: string;
  readonly sourceEntailmentVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}
const allowed = (text: unknown, max: number): text is string =>
  typeof text === "string" &&
  text.trim() === text &&
  text.length >= 2 &&
  text.length <= max;
const fold = (text: string) =>
  text
    .normalize("NFKC")
    .toLocaleLowerCase("und")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/^(?:the|el|la|los|las|an|a)\s+/iu, "");
const unique = (body: string, actor: string): boolean => {
  // Both the exact bytes and the case-insensitive surface must be unique:
  // repetitions with different case cannot identify one grammatical actor.
  const at = body.indexOf(actor);
  if (at < 0 || body.indexOf(actor, at + 1) >= 0) return false;
  const sourceFold = body.normalize("NFKC").toLocaleLowerCase("und");
  const actorFold = actor.normalize("NFKC").toLocaleLowerCase("und");
  const normalizedAt = sourceFold.indexOf(actorFold);
  return (
    normalizedAt >= 0 && sourceFold.indexOf(actorFold, normalizedAt + 1) < 0
  );
};
/**
 * A source can name the correct actor while saying nothing about the claimed
 * relation. Predicate comparison is a source/claim *surface diagnostic* only:
 * lexical divergence may be paraphrase, negation or a genuine wrong relation.
 * Do not infer a contradiction or veto a complete-claim verifier from this.
 */
function predicateSurface(input: {
  readonly sourceQuote: string;
  readonly fullDeclarativeClaim: string;
  readonly extraction: S2ActorPairExtraction;
}): {
  status: S2ActorBindingResult["relationSurfaceStatus"];
  reason: string;
} {
  const { sourcePredicate, claimPredicate } = input.extraction;
  if (sourcePredicate == null && claimPredicate == null)
    return {
      status: "PREDICATE_NOT_PROVIDED",
      reason: "NO_PREDICATE_PROPOSED",
    };
  if (
    !allowed(sourcePredicate, 256) ||
    !allowed(claimPredicate, 256) ||
    !unique(input.sourceQuote, sourcePredicate) ||
    !unique(input.fullDeclarativeClaim, claimPredicate)
  )
    return {
      status: "PREDICATE_UNBOUND",
      reason: "PREDICATE_SPAN_NOT_UNIQUE_OR_VERBATIM",
    };
  return fold(sourcePredicate) === fold(claimPredicate)
    ? {
        status: "LEXICALLY_ALIGNED",
        reason: "PREDICATE_SURFACE_ONLY_NOT_ENTAILMENT",
      }
    : {
        status: "LEXICALLY_DIVERGENT",
        reason: "PREDICATE_SURFACES_DIFFER_SEMANTICS_UNVERIFIED",
      };
}

export function checkS2SourceClaimActorBinding(input: {
  readonly sourceQuote: string;
  readonly fullDeclarativeClaim: string;
  readonly extraction: S2ActorPairExtraction;
}): S2ActorBindingResult {
  const make = (
    status: S2ActorBindingResult["status"],
    reason: string,
    sourceActor: string | null = null,
    claimActor: string | null = null,
    sourceBound = false,
    claimBound = false,
  ): S2ActorBindingResult => ({
    status,
    reason,
    sourceActor,
    claimActor,
    sourceBound,
    claimBound,
    relationSurfaceStatus:
      input?.extraction &&
      typeof input.sourceQuote === "string" &&
      typeof input.fullDeclarativeClaim === "string"
        ? predicateSurface(input).status
        : "PREDICATE_UNBOUND",
    relationSurfaceReason:
      input?.extraction &&
      typeof input.sourceQuote === "string" &&
      typeof input.fullDeclarativeClaim === "string"
        ? predicateSurface(input).reason
        : "PREDICATE_INPUT_INVALID",
    sourceEntailmentVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  if (
    !allowed(input?.sourceQuote, 12000) ||
    !allowed(input?.fullDeclarativeClaim, 4096) ||
    !input.extraction ||
    typeof input.extraction !== "object"
  )
    return make("REJECTED", "SOURCE_CLAIM_OR_EXTRACTION_INVALID");
  const { sourceActor, claimActor } = input.extraction;
  if (sourceActor === null && claimActor === null)
    return make("INDETERMINATE", "NO_EXTRACTABLE_ACTOR");
  if (!allowed(sourceActor, 256) || !allowed(claimActor, 256))
    return make("INDETERMINATE", "ACTOR_FIELDS_NOT_BOTH_VERBATIM");
  if (
    !unique(input.sourceQuote, sourceActor) ||
    !unique(input.fullDeclarativeClaim, claimActor)
  )
    return make("INDETERMINATE", "ACTOR_SOURCE_OR_CLAIM_SPAN_UNBOUND");
  if (fold(sourceActor) !== fold(claimActor))
    return make(
      "ACTOR_MISMATCH",
      "EXPLICIT_ACTOR_IDENTITY_MISMATCH",
      sourceActor,
      claimActor,
      true,
      true,
    );
  return make(
    "ACTOR_MATCH_CANDIDATE",
    "ACTOR_IDENTITY_ONLY_NOT_ENTAILMENT",
    sourceActor,
    claimActor,
    true,
    true,
  );
}
