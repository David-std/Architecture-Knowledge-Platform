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
