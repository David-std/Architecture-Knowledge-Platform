import { describe, expect, it } from "vitest";
import { explicitClaimNumbersBoundToQuote } from "../src/s2-claim-numeric-integrity.js";
describe("S2 generic explicit numeric claim authority", () => {
  it("rejects a swapped decimal value even when the same digits occur", () => {
    expect(
      explicitClaimNumbersBoundToQuote(
        "The calibrated dose is 0.5 milligrams.",
        "The calibrated dose is 5.0 milligrams.",
      ).eligible,
    ).toBe(false);
  });
  it("rejects a flipped negative sign, without treating ISO date hyphens as negatives", () => {
    expect(
      explicitClaimNumbersBoundToQuote(
        "The adjustment is -12 credits.",
        "The adjustment is 12 credits.",
      ).eligible,
    ).toBe(false);
    expect(
      explicitClaimNumbersBoundToQuote(
        "The event is on 2031-04-30.",
        "The event is on 30 April 2031.",
      ).eligible,
    ).toBe(true);
  });

  it("rejects an unsupported quantity despite other overlapping words", () => {
    expect(
      explicitClaimNumbersBoundToQuote(
        "The sample holds exactly 42 cases.",
        "The sample holds exactly 43 cases.",
      ),
    ).toMatchObject({
      eligible: false,
      reason: "EXPLICIT_CLAIM_NUMBER_NOT_IN_QUOTE",
    });
  });
  it("rejects an invented year or day of month", () => {
    expect(
      explicitClaimNumbersBoundToQuote(
        "Expiry: 2031-04-30.",
        "Expiry: 2031-04-31.",
      ).eligible,
    ).toBe(false);
    expect(
      explicitClaimNumbersBoundToQuote(
        "Expiry: 2031-04-30.",
        "Expiry: 2032-04-30.",
      ).eligible,
    ).toBe(false);
  });
  it("allows explicitly copied quantity/date components even reordered", () => {
    expect(
      explicitClaimNumbersBoundToQuote(
        "Expiry: 2031-04-30.",
        "The expiry is April 30, 2031.",
      ).eligible,
    ).toBe(true);
  });
  it("does not invent a numerical derivation", () => {
    expect(
      explicitClaimNumbersBoundToQuote("36 months.", "3 years.").eligible,
    ).toBe(false);
  });
  it("guards source identifiers with different numeric suffixes", () => {
    expect(
      explicitClaimNumbersBoundToQuote(
        "Asset M-9 is approved.",
        "Asset M-8 is approved.",
      ).eligible,
    ).toBe(false);
  });
  it("keeps semantic judgment for claims without explicit numeric digits", () => {
    expect(
      explicitClaimNumbersBoundToQuote(
        "The station is blue.",
        "The station is green.",
      ).eligible,
    ).toBe(true);
  });
  it("fails closed for unsupported non-Latin decimal scripts", () => {
    expect(
      explicitClaimNumbersBoundToQuote("Price 42.", "Price ٤٢.").eligible,
    ).toBe(false);
  });
  it("rejects pathological input budgets", () => {
    expect(
      explicitClaimNumbersBoundToQuote("a".repeat(12001), "42").eligible,
    ).toBe(false);
  });
});
