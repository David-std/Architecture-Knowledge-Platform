import { describe, expect, it } from "vitest";
import {
  freezeS2QuoteEvidenceOptions,
  buildS2QuoteEvidenceChoiceFormat,
  resolveS2QuoteEvidenceChoice,
  buildS2PairedQuoteEvidenceTokenFormat,
  resolveS2QuoteEvidenceToken,
} from "../src/s2-quote-evidence-choice.js";
const text =
  "Original source: the `volume-nocopy` option prevents copying files.";
describe("frozen literal quote choices: no model-generated evidence text", () => {
  it("accepts only a pre-frozen quote ID and exact original UTF-16 span", () => {
    const f = freezeS2QuoteEvidenceOptions(text);
    const x = resolveS2QuoteEvidenceChoice(text, f, {
      decision: "SUPPORTS",
      evidenceId: "Q1",
    });
    expect(x).toMatchObject({
      decision: "SUPPORTS",
      evidenceSpan: { startUtf16: 0, endUtf16: text.length },
    });
    expect(f.options[0].text).toBe(text);
    expect(f.semanticEntailmentIndependentlyVerified).toBe(false);
    expect(f.productionAdmission).toBe(false);
  });
  it("models cannot invent an ID, supply fuzzy evidence or add unknown JSON keys", () => {
    const f = freezeS2QuoteEvidenceOptions(text);
    for (const answer of [
      { decision: "SUPPORTS", evidenceId: "Q7" },
      { decision: "SUPPORTS", evidenceId: "Q1", evidenceText: text },
      { decision: "SUPPORTS", evidenceText: text },
      { decision: "INSUFFICIENT", evidenceId: "Q1" },
      { decision: "CONTRADICTS", evidenceId: "NONE" },
    ])
      expect(resolveS2QuoteEvidenceChoice(text, f, answer).decision).toBe(
        "INSUFFICIENT",
      );
  });
  it("pins provider schema to exact pre-frozen choice IDs", () => {
    const f = freezeS2QuoteEvidenceOptions(text);
    const schema = buildS2QuoteEvidenceChoiceFormat(text, f);
    expect(schema.properties.evidenceId.enum).toEqual(["NONE", "Q1"]);
    expect(schema.additionalProperties).toBe(false);
    expect(() => buildS2QuoteEvidenceChoiceFormat(text + "z", f)).toThrow();
  });
  it("allows an explicit insufficient result without selecting evidence", () => {
    const f = freezeS2QuoteEvidenceOptions(text);
    expect(
      resolveS2QuoteEvidenceChoice(text, f, {
        decision: "INSUFFICIENT",
        evidenceId: "NONE",
      }),
    ).toMatchObject({ decision: "INSUFFICIENT", reason: "MODEL_INSUFFICIENT" });
  });
  it("rejects drifted source bytes even if its model-selected ID was valid", () => {
    const f = freezeS2QuoteEvidenceOptions(text);
    expect(
      resolveS2QuoteEvidenceChoice(text + "x", f, {
        decision: "SUPPORTS",
        evidenceId: "Q1",
      }).decision,
    ).toBe("INSUFFICIENT");
  });
  it("creates contiguous UTF-16 chunks without splitting surrogate pairs", () => {
    const quote = "a".repeat(258) + "😀" + "b".repeat(780);
    const f = freezeS2QuoteEvidenceOptions(quote, 259);
    expect(f.options.length).toBeGreaterThan(1);
    expect(f.options.map((x) => x.text).join("")).toBe(quote);
    for (const x of f.options) {
      expect(quote.slice(x.startUtf16, x.endUtf16)).toBe(x.text);
      expect(
        resolveS2QuoteEvidenceChoice(quote, f, {
          decision: "CONTRADICTS",
          evidenceId: x.id,
        }),
      ).toMatchObject({
        decision: "CONTRADICTS",
        evidenceSpan: { startUtf16: x.startUtf16, endUtf16: x.endUtf16 },
      });
    }
    expect(f.options[0].endUtf16).toBe(258);
  });
  it("rejects tampered span descriptors without repairing offsets", () => {
    const f = freezeS2QuoteEvidenceOptions(text);
    const forged = {
      ...f,
      options: [{ ...f.options[0], endUtf16: text.length - 1 }],
    };
    expect(
      resolveS2QuoteEvidenceChoice(text, forged, {
        decision: "SUPPORTS",
        evidenceId: "Q1",
      }).decision,
    ).toBe("INSUFFICIENT");
  });
  it("fails closed without throwing on an untrusted malformed freeze", () => {
    const f = freezeS2QuoteEvidenceOptions(text);
    expect(
      resolveS2QuoteEvidenceChoice(
        text,
        { ...f, maxChunkUtf16: 0 },
        {
          decision: "SUPPORTS",
          evidenceId: "Q1",
        },
      ).decision,
    ).toBe("INSUFFICIENT");
    expect(
      resolveS2QuoteEvidenceChoice(text, { ...f, options: null } as never, {
        decision: "SUPPORTS",
        evidenceId: "Q1",
      }).decision,
    ).toBe("INSUFFICIENT");
  });
  it("rejects oversized source quotes and invalid chunk capacities", () => {
    expect(() => freezeS2QuoteEvidenceOptions("z".repeat(12001))).toThrow();
    expect(() => freezeS2QuoteEvidenceOptions(text, 7)).toThrow();
    expect(() => freezeS2QuoteEvidenceOptions(" ")).toThrow();
  });
});

describe("single enum token binds a decision to a source ID structurally", () => {
  it("offers ONLY legal decisions+frozen IDs and no contradictory combinations", () => {
    const frozen = freezeS2QuoteEvidenceOptions(text);
    const schema = buildS2PairedQuoteEvidenceTokenFormat(text, frozen);
    expect(schema.properties.questionToken.enum).toEqual([
      "INSUFFICIENT@NONE",
      "SUPPORTS@Q1",
      "CONTRADICTS@Q1",
    ]);
    expect(schema.properties.claimToken.enum).toEqual(
      schema.properties.questionToken.enum,
    );
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(["questionToken", "claimToken"]);
    expect(
      schema.properties.claimToken.enum.some((x) => x === "INSUFFICIENT@Q1"),
    ).toBe(false);
    expect(() =>
      buildS2PairedQuoteEvidenceTokenFormat(text + " changed", frozen),
    ).toThrow();
  });
  it("retains exact literal citation UTF-16 positions and preserves unsupported abstention", () => {
    const frozen = freezeS2QuoteEvidenceOptions(text);
    expect(
      resolveS2QuoteEvidenceToken(text, frozen, "SUPPORTS@Q1"),
    ).toMatchObject({
      decision: "SUPPORTS",
      evidenceSpan: { startUtf16: 0, endUtf16: text.length },
    });
    expect(
      resolveS2QuoteEvidenceToken(text, frozen, "CONTRADICTS@Q1"),
    ).toMatchObject({
      decision: "CONTRADICTS",
      evidenceSpan: { startUtf16: 0, endUtf16: text.length },
    });
    expect(
      resolveS2QuoteEvidenceToken(text, frozen, "INSUFFICIENT@NONE"),
    ).toMatchObject({ decision: "INSUFFICIENT", reason: "MODEL_INSUFFICIENT" });
  });
  it("rejects invented, malformed, mixed, repeated and forged schema tokens", () => {
    const frozen = freezeS2QuoteEvidenceOptions(text);
    for (const token of [
      "INSUFFICIENT@Q1",
      "SUPPORTS@NONE",
      "SUPPORTS@Q2",
      "CONTRADICTS@Q42",
      "SUPPORTS@Q01",
      "SUPPORTS@Q1.EXTRA",
      "supports@Q1",
      "INSUFFICIENT@NONE@Q1",
      3,
      null,
      {},
      ["SUPPORTS@Q1"],
    ]) {
      expect(resolveS2QuoteEvidenceToken(text, frozen, token)).toMatchObject({
        decision: "INSUFFICIENT",
        reason: "MODEL_LITERAL_EVIDENCE_CHOICE_INVALID",
      });
    }
  });
  it("rejects changed original bytes or mutated source evidence options with no repair", () => {
    const frozen = freezeS2QuoteEvidenceOptions(text);
    expect(
      resolveS2QuoteEvidenceToken(text + "!", frozen, "SUPPORTS@Q1"),
    ).toMatchObject({
      decision: "INSUFFICIENT",
      reason: "MODEL_LITERAL_EVIDENCE_CHOICE_INVALID",
    });
    expect(
      resolveS2QuoteEvidenceToken(
        text,
        { ...frozen, options: [{ ...frozen.options[0]!, startUtf16: 1 }] },
        "SUPPORTS@Q1",
      ),
    ).toMatchObject({
      decision: "INSUFFICIENT",
      reason: "MODEL_LITERAL_EVIDENCE_CHOICE_INVALID",
    });
  });
  it("handles source quotes that yield multiple immutable token positions", () => {
    const source = "X".repeat(1400) + "\n" + "Y".repeat(700);
    const frozen = freezeS2QuoteEvidenceOptions(source);
    const menu = buildS2PairedQuoteEvidenceTokenFormat(source, frozen);
    expect(menu.properties.claimToken.enum).toContain("SUPPORTS@Q2");
    const review = resolveS2QuoteEvidenceToken(source, frozen, "SUPPORTS@Q2");
    expect(review).toMatchObject({
      decision: "SUPPORTS",
      evidenceSpan: {
        startUtf16: frozen.options[1]!.startUtf16,
        endUtf16: frozen.options[1]!.endUtf16,
      },
    });
  });
});
