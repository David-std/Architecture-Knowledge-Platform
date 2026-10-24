import { describe, it, expect } from "vitest";
import { checkS2SourceClaimActorBinding } from "../src/s2-actor-binding.js";
describe("structural actor binding, shadow only", () => {
  it("rejects a source-to-claim subject swap even when objects, verbs and units coincide", () => {
    const result = checkS2SourceClaimActorBinding({
      sourceQuote: "The alpha sensor measures pressure in pascals.",
      fullDeclarativeClaim: "The beta sensor measures pressure in pascals.",
      extraction: {
        sourceActor: "The alpha sensor",
        claimActor: "The beta sensor",
        sourcePredicate: "measures pressure",
        claimPredicate: "measures pressure",
      },
    });
    expect(result).toMatchObject({
      status: "ACTOR_MISMATCH",
      relationSurfaceStatus: "LEXICALLY_ALIGNED",
      sourceBound: true,
      claimBound: true,
      sourceEntailmentVerified: false,
      productionAdmission: false,
    });
  });
  it("recognizes only matching subjects without treating them as complete proof", () => {
    const result = checkS2SourceClaimActorBinding({
      sourceQuote: "The alpha sensor never deletes archived data.",
      fullDeclarativeClaim: "Alpha sensor always deletes archived data.",
      extraction: {
        sourceActor: "The alpha sensor",
        claimActor: "Alpha sensor",
      },
    });
    expect(result).toMatchObject({
      status: "ACTOR_MATCH_CANDIDATE",
      sourceEntailmentVerified: false,
    });
  });
  it("never admits invented or ambiguous actor spans", () => {
    const first = checkS2SourceClaimActorBinding({
      sourceQuote: "The custodian reviews the ticket.",
      fullDeclarativeClaim: "The administrator reviews the ticket.",
      extraction: { sourceActor: "operator", claimActor: "The administrator" },
    });
    expect(first.status).toBe("INDETERMINATE");
    const duplicate = checkS2SourceClaimActorBinding({
      sourceQuote: "The officer contacts the officer.",
      fullDeclarativeClaim: "The officer contacts support.",
      extraction: { sourceActor: "The officer", claimActor: "The officer" },
    });
    expect(duplicate.status).toBe("INDETERMINATE");
  });
  it("identifies a same-actor, different-predicate surface without declaring contradiction", () => {
    const result = checkS2SourceClaimActorBinding({
      sourceQuote: "The TracerProvider holds the configuration for tracing.",
      fullDeclarativeClaim: "The TracerProvider provides Tracers to clients.",
      extraction: {
        sourceActor: "The TracerProvider",
        claimActor: "The TracerProvider",
        sourcePredicate: "holds the configuration",
        claimPredicate: "provides Tracers",
      },
    });
    expect(result).toMatchObject({
      status: "ACTOR_MATCH_CANDIDATE",
      relationSurfaceStatus: "LEXICALLY_DIVERGENT",
      relationSurfaceReason: "PREDICATE_SURFACES_DIFFER_SEMANTICS_UNVERIFIED",
      sourceEntailmentVerified: false,
      productionAdmission: false,
    });
  });
  it("never converts changed negation or a potential paraphrase into an asserted contradiction", () => {
    const result = checkS2SourceClaimActorBinding({
      sourceQuote: "The service never removes old backups.",
      fullDeclarativeClaim: "The service always removes old backups.",
      extraction: {
        sourceActor: "The service",
        claimActor: "The service",
        sourcePredicate: "never removes",
        claimPredicate: "always removes",
      },
    });
    expect(result.relationSurfaceStatus).toBe("LEXICALLY_DIVERGENT");
    expect(result.status).toBe("ACTOR_MATCH_CANDIDATE");
  });
  it("leaves invented and repeated predicates unbound without semantic authority", () => {
    const result = checkS2SourceClaimActorBinding({
      sourceQuote: "The worker manages state and manages logs.",
      fullDeclarativeClaim: "The worker manages checkpoints.",
      extraction: {
        sourceActor: "The worker",
        claimActor: "The worker",
        sourcePredicate: "manages",
        claimPredicate: "manages",
      },
    });
    expect(result.relationSurfaceStatus).toBe("PREDICATE_UNBOUND");
    expect(result.sourceEntailmentVerified).toBe(false);
    expect(result.releaseGateAccepted).toBe(false);
  });
  it("does not infer subjects when source is a heading or is too short", () => {
    expect(
      checkS2SourceClaimActorBinding({
        sourceQuote: "Get records",
        fullDeclarativeClaim: "The client gets records.",
        extraction: { sourceActor: null, claimActor: null },
      }).status,
    ).toBe("INDETERMINATE");
    expect(
      checkS2SourceClaimActorBinding({
        sourceQuote: "x",
        fullDeclarativeClaim: "The client gets records.",
        extraction: { sourceActor: "x", claimActor: "The client" },
      }).status,
    ).toBe("REJECTED");
  });
});
