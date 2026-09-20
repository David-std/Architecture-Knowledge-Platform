import { describe, expect, it } from "vitest";
import { resolveSourceModelResidency } from "../src/source-model-residency.js";

describe("resolveSourceModelResidency", () => {
  it("preserves legacy behavior when no durable boundary is requested", () => {
    expect(resolveSourceModelResidency({})).toBe("EXTERNAL_ALLOWED");
    expect(
      resolveSourceModelResidency({
        documentIntelligence: { privacyPolicy: "LOCAL_PREFERRED" },
      }),
    ).toBe("EXTERNAL_ALLOWED");
  });

  it("carries extraction LOCAL_ONLY forward to downstream model work", () => {
    expect(
      resolveSourceModelResidency({
        documentIntelligence: { privacyPolicy: "LOCAL_ONLY" },
      }),
    ).toBe("LOCAL_ONLY");
  });

  it("uses the most restrictive explicit and extraction boundaries", () => {
    expect(
      resolveSourceModelResidency({
        modelResidency: "ORG_APPROVED",
        documentIntelligence: { privacyPolicy: "REMOTE_ALLOWED" },
      }),
    ).toBe("ORG_APPROVED");
    expect(
      resolveSourceModelResidency({
        modelResidency: "EXTERNAL_ALLOWED",
        documentIntelligence: { privacyPolicy: "LOCAL_ONLY" },
      }),
    ).toBe("LOCAL_ONLY");
  });

  it("rejects an invalid persisted residency boundary", () => {
    expect(() =>
      resolveSourceModelResidency({ modelResidency: "ANYWHERE" }),
    ).toThrow("INVALID_MODEL_RESIDENCY");
  });
});
