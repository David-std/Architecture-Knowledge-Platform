import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  checkS2ClaimAnswerAnchor,
  traceS2ReaderAnswerSlotTransfer,
} from "../src/s2-claim-answer-anchor.js";

describe("answer-to-claim surface anchor (shadow diagnostic)", () => {
  it("binds a unique question answer to the original claim UTF-16 span", () => {
    const claim = "🔎 The access control proxy grants access to a resource.";
    const result = checkS2ClaimAnswerAnchor("access control proxy", claim);
    expect(result).toMatchObject({
      status: "UNIQUE_LITERAL_VALUE",
      claimEquivalenceVerified: false,
      sourceEntailmentVerified: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    });
    expect(claim.slice(result.startUtf16!, result.endUtf16!)).toBe(
      "access control proxy",
    );
    expect(result.startUtf16).toBe(claim.indexOf("access control proxy"));
  });
  it("exposes a projector that echoed the answer but substituted a different subject", () => {
    expect(
      checkS2ClaimAnswerAnchor(
        "TracerProvider",
        "The Tracer provides Tracers to clients.",
      ),
    ).toMatchObject({
      status: "LITERAL_VALUE_NOT_FOUND",
      startUtf16: null,
      claimEquivalenceVerified: false,
    });
  });
  it("does not match inside a larger identifier or a longer word", () => {
    expect(
      checkS2ClaimAnswerAnchor("no", "The node does not grant access."),
    ).toMatchObject({
      status: "BOOLEAN_VALUE_REQUIRES_SEMANTIC_REWRITE",
    });
    expect(
      checkS2ClaimAnswerAnchor(
        "Tracer",
        "The TracerProvider holds the configuration.",
      ),
    ).toMatchObject({ status: "LITERAL_VALUE_NOT_FOUND" });
    expect(checkS2ClaimAnswerAnchor("12", "The code is 312.")).toMatchObject({
      status: "LITERAL_VALUE_NOT_FOUND",
    });
  });
  it("requires independent verification for nonliteral yes/no or paraphrased values", () => {
    for (const answer of ["yes", "NO", "sí", "false"]) {
      const result = checkS2ClaimAnswerAnchor(
        answer,
        "The directives are case-insensitive.",
      );
      expect(result.status).toBe("BOOLEAN_VALUE_REQUIRES_SEMANTIC_REWRITE");
    }
    expect(
      checkS2ClaimAnswerAnchor(
        "case-insensitive",
        "The directives are not case sensitive.",
      ).status,
    ).toBe("LITERAL_VALUE_NOT_FOUND");
  });
  it("reports ambiguous repeated values without choosing a convenient mention", () => {
    expect(
      checkS2ClaimAnswerAnchor(
        "Cache-Control",
        "Cache-Control changes Cache-Control.",
      ),
    ).toMatchObject({
      status: "REPEATED_LITERAL_VALUE",
      startUtf16: null,
    });
  });
  it("supports case variations and regex metacharacters without inventing offsets", () => {
    const claim = "La cabecera usa X-Rate.Limit(v2) cuando está activa.";
    const res = checkS2ClaimAnswerAnchor("x-rate.limit(v2)", claim);
    expect(res.status).toBe("UNIQUE_LITERAL_VALUE");
    expect(claim.slice(res.startUtf16!, res.endUtf16!)).toBe(
      "X-Rate.Limit(v2)",
    );
  });
  it("rejects malformed strings or excessive lengths, always without release authority", () => {
    const invalid = checkS2ClaimAnswerAnchor(" ", "The claim is text.");
    expect(invalid.status).toBe("REJECTED");
    expect(invalid.releaseGateAccepted).toBe(false);
    expect(checkS2ClaimAnswerAnchor("x", "z".repeat(4097)).status).toBe(
      "REJECTED",
    );
  });
});

describe("S2 reader answer-source transfer shadow", () => {
  const content =
    "🔍 Faro-6 publishes B3 after tres reviews. The archive has six reviewers.";
  const original = {
    assignedSourceId: "source:faro",
    sourceSha256: createHash("sha256").update(content).digest("hex"),
    exactUtf8Bytes: Buffer.from(content),
    bodyStartUtf16: 0,
    bodyEndUtf16: content.length,
  };
  const quote = "🔍 Faro-6 publishes B3 after tres reviews.";
  const input = {
    question: "How many reviews does B3 require?",
    needed: "B3 publication review count",
    extractedAnswer: "tres",
    quote,
    answers: true,
  };
  it("pins reader value to original UTF-16 without granting semantic authority", () => {
    const result = traceS2ReaderAnswerSlotTransfer(input, original);
    expect(result.status).toBe("LITERAL_VALUE_BOUND_TO_ORIGINAL");
    expect(
      content.slice(result.answerValueStartUtf16!, result.answerValueEndUtf16!),
    ).toBe("tres");
    expect(result.actualQueryAnswerRoleVerified).toBe(false);
    expect(result.quantitativeEquivalenceVerified).toBe(false);
    expect(result.productionAdmission).toBe(false);
  });
  it("distinguishes a cross-language paraphrase from a verified literal", () => {
    const result = traceS2ReaderAnswerSlotTransfer(
      { ...input, extractedAnswer: "3" },
      original,
    );
    expect(result.status).toBe("EXTRACTED_VALUE_NOT_LITERAL_IN_QUOTE");
    expect(result.answerValueStartUtf16).toBe(null);
    expect(result.quantitativeEquivalenceVerified).toBe(false);
  });
  it("a digit in a document identifier remains semantically unverified", () => {
    const result = traceS2ReaderAnswerSlotTransfer(
      { ...input, extractedAnswer: "6" },
      original,
    );
    expect(result.status).toBe("LITERAL_VALUE_BOUND_TO_ORIGINAL");
    expect(result.actualQueryAnswerRoleVerified).toBe(false);
    expect(
      content.slice(result.answerValueStartUtf16!, result.answerValueEndUtf16!),
    ).toBe("6");
  });
  it("rejects invented evidence and modified original SHA", () => {
    expect(
      traceS2ReaderAnswerSlotTransfer(
        { ...input, quote: quote.replace("tres", "cinco") },
        original,
      ).status,
    ).toBe("INVALID_ORIGINAL_QUOTE");
    expect(
      traceS2ReaderAnswerSlotTransfer(input, {
        ...original,
        sourceSha256: "0".repeat(64),
      }).status,
    ).toBe("INVALID_ORIGINAL_QUOTE");
  });
  it("rejects ambiguous duplicated values and boolean answer interpretations", () => {
    const duplicated = "B3 needs three checks, and another three checks.";
    const source = {
      ...original,
      sourceSha256: createHash("sha256").update(duplicated).digest("hex"),
      exactUtf8Bytes: Buffer.from(duplicated),
      bodyEndUtf16: duplicated.length,
    };
    expect(
      traceS2ReaderAnswerSlotTransfer(
        {
          ...input,
          quote: duplicated,
          extractedAnswer: "three",
        },
        source,
      ).status,
    ).toBe("EXTRACTED_VALUE_AMBIGUOUS_IN_QUOTE");
    expect(
      traceS2ReaderAnswerSlotTransfer(
        { ...input, extractedAnswer: "No" },
        original,
      ).status,
    ).toBe("BOOLEAN_VALUE_NEEDS_RELATION_CHECK");
    expect(
      traceS2ReaderAnswerSlotTransfer({ ...input, answers: false }, original)
        .status,
    ).toBe("INVALID_READER_ANSWER");
  });
});
