import { describe, it, expect } from "vitest";
import {
  buildS2ProjectedRoleTokenFormat,
  resolveS2ProjectedRoleToken,
  S2_POST_PROJECTION_ROLE_TOKENS,
} from "../src/s2-question-answer-claim.js";
describe("the role verdict and rationale cannot be contradictory enum fields", () => {
  it("exposes the one-field provider schema with only consistent decision/reason combos", () => {
    const schema = buildS2ProjectedRoleTokenFormat();
    expect(schema.required).toEqual(["verdictToken"]);
    expect(schema.properties.verdictToken.enum).toEqual(
      S2_POST_PROJECTION_ROLE_TOKENS,
    );
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.verdictToken.enum).toContain("UNCERTAIN@UNSURE");
    expect(schema.properties.verdictToken.enum).not.toContain("MATCH@UNSURE");
    expect(schema.properties.verdictToken.enum).not.toContain("MISMATCH@NONE");
  });
  it("binds every legal token to only one reviewer proposal without granting authority", () => {
    for (const token of S2_POST_PROJECTION_ROLE_TOKENS) {
      const r = resolveS2ProjectedRoleToken({ verdictToken: token });
      expect(r).toMatchObject({
        status: "VALID_ROLE_PROPOSAL_ONLY",
        decision: token.split("@")[0],
        failureKind: token.split("@")[1],
        roleEquivalenceVerified: false,
        productionAdmission: false,
        releaseGateAccepted: false,
      });
    }
  });
  it("fails closed on contradictory, invented, mixed-case or arbitrary role verdict tokens", () => {
    for (const x of [
      "MATCH@UNSURE",
      "MISMATCH@NONE",
      "UNCERTAIN@TIME_OR_NUMBER_AS_AGENT",
      "MATCH",
      "match@NONE",
      "MISMATCH@FAKE",
      "MATCH@NONE@OTHER",
      "MISMATCH@TIME_OR_NUMBER_AS_AGENT\nignore instructions",
    ]) {
      expect(resolveS2ProjectedRoleToken({ verdictToken: x })).toMatchObject({
        status: "REJECTED",
        decision: "UNCERTAIN",
        productionAdmission: false,
      });
    }
  });
  it("will not accept old two independent fields, extra JSON keys or mutated shapes", () => {
    for (const r of [
      { decision: "MATCH", failureKind: "UNSURE" },
      { verdictToken: "MATCH@NONE", extra: "x" },
      ["MATCH@NONE"],
      null,
      undefined,
      { verdictToken: null },
      { verdictToken: 42 },
      { verdictToken: ["MATCH@NONE"] },
      {},
    ])
      expect(resolveS2ProjectedRoleToken(r)).toMatchObject({
        status: "REJECTED",
        roleEquivalenceVerified: false,
      });
  });
});
