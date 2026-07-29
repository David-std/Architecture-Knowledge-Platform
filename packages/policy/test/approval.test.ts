import { describe, expect, it } from "vitest";
import { decideApproval } from "../src/index.js";

describe("approval policy", () => {
  it("requires human review for rules", () => {
    expect(
      decideApproval({
        kind: "RULE",
        trust: "MACHINE_SUPPORTED",
        disputed: false,
        touchesNormativePath: true,
        validationErrors: 0,
        criticalProbeFailures: 0,
      }).decision,
    ).toBe("REVIEW_REQUIRED");
  });

  it("rejects failed critical probes", () => {
    expect(
      decideApproval({
        kind: "SOURCE_SUMMARY",
        trust: "MACHINE_SUPPORTED",
        disputed: false,
        touchesNormativePath: false,
        validationErrors: 0,
        criticalProbeFailures: 1,
      }).decision,
    ).toBe("REJECT");
  });
});
