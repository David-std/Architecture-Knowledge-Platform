import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { attributeS2VerbatimQuote } from "../src/s2-exact-quote-attribution.js";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const bytes = Buffer.from(
  "## Synthetic\nThe cerulean beacon says ORBIT-73. 😀\n",
);
const orig = {
  assignedSourceId: "SRC1",
  sourceSha256: sha(bytes),
  exactUtf8Bytes: bytes,
  bodyStartUtf16: 0,
  bodyEndUtf16: new TextDecoder().decode(bytes).length,
};
const answer = (change: Record<string, unknown> = {}) => ({
  answerText: "ORBIT-73",
  evidenceQuote: "The cerulean beacon says ORBIT-73.",
  sourceId: "SRC1",
  abstained: false,
  ...change,
});
describe("S2 exact quote attribution shadow-only", () => {
  it("confirms the correct assigned source and literal UTF16 frame", () => {
    const out = attributeS2VerbatimQuote(answer(), [orig]);
    expect(out).toMatchObject({
      status: "VERBATIM_UNIQUE_SOURCE_BOUND",
      assignedSourceId: "SRC1",
      sourceSha256: sha(bytes),
      modelSourceIdConfirmed: true,
      modelSourceIdRepairedByLiteralProof: false,
      semanticEntailmentVerified: false,
      releaseGateAccepted: false,
    });
    expect(
      new TextDecoder().decode(bytes).slice(out.startUtf16!, out.endUtf16!),
    ).toBe(answer().evidenceQuote);
  });
  it("repairs a hallucinated source ID only from unique exact original quote", () => {
    const out = attributeS2VerbatimQuote(answer({ sourceId: "SRC11" }), [orig]);
    expect(out).toMatchObject({
      status: "VERBATIM_UNIQUE_SOURCE_BOUND",
      assignedSourceId: "SRC1",
      modelSourceId: "SRC11",
      modelSourceIdConfirmed: false,
      modelSourceIdRepairedByLiteralProof: true,
    });
  });
  it("rejects even a one-character paraphrase in the claimed evidenceQuote", () => {
    const out = attributeS2VerbatimQuote(
      answer({
        evidenceQuote: "The cerulean beacon says ORBIT-74.",
      }),
      [orig],
    );
    expect(out).toMatchObject({
      status: "REJECTED",
      reason: "NO_UNIQUE_VERBATIM_QUOTE_MATCH",
    });
  });
  it("rejects ambiguous quote repeated twice in one original", () => {
    const b = Buffer.from("Repeatable anchor text.\nRepeatable anchor text.\n");
    const o = {
      ...orig,
      exactUtf8Bytes: b,
      sourceSha256: sha(b),
      bodyEndUtf16: new TextDecoder().decode(b).length,
    };
    expect(
      attributeS2VerbatimQuote(
        answer({
          evidenceQuote: "Repeatable anchor text.",
        }),
        [o],
      ).reason,
    ).toBe("QUOTE_NOT_UNIQUE_IN_AUTHORIZED_SOURCES");
  });
  it("rejects the same quote across distinct authorized originals", () => {
    expect(
      attributeS2VerbatimQuote(answer(), [
        orig,
        { ...orig, assignedSourceId: "SRC2" },
      ]).reason,
    ).toBe("QUOTE_NOT_UNIQUE_IN_AUTHORIZED_SOURCES");
  });
  it("rejects tampered source sha before any positive claim", () => {
    expect(
      attributeS2VerbatimQuote(answer(), [
        { ...orig, sourceSha256: "0".repeat(64) },
      ]).reason,
    ).toBe("AUTHORITATIVE_SOURCE_PROVENANCE_INVALID");
  });
  it("requires structurally consistent empty abstention", () => {
    expect(
      attributeS2VerbatimQuote(
        {
          answerText: "",
          evidenceQuote: "",
          sourceId: "",
          abstained: true,
        },
        [orig],
      ).status,
    ).toBe("VALID_ABSTAIN");
    expect(
      attributeS2VerbatimQuote(
        {
          answerText: "no",
          evidenceQuote: "",
          sourceId: "",
          abstained: true,
        },
        [orig],
      ).reason,
    ).toBe("ABSTENTION_WITH_NONEMPTY_FIELDS");
  });
  it("fails closed on malformed source frame and absent originals", () => {
    expect(attributeS2VerbatimQuote(answer(), []).reason).toBe(
      "AUTHORITATIVE_ORIGINALS_MISSING_OR_UNBOUNDED",
    );
    expect(
      attributeS2VerbatimQuote(answer(), [
        { ...orig, bodyEndUtf16: orig.bodyEndUtf16 + 1 },
      ]).reason,
    ).toBe("AUTHORITATIVE_BODY_UTF16_FRAME_INVALID");
  });
  it("never proves semantic entailment merely from an exact quote", () => {
    const out = attributeS2VerbatimQuote(
      answer({
        answerText: "A totally different claim",
      }),
      [orig],
    );
    expect(out.status).toBe("VERBATIM_UNIQUE_SOURCE_BOUND");
    expect(out.semanticEntailmentVerified).toBe(false);
  });
});
