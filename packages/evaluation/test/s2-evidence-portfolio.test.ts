import { createHash } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import {
  assessS2ClaimEvidencePortfolio,
  assessS2MultiGranularityClaim,
} from "../src/s2-evidence-portfolio.js";
const source =
  "## Controls\n\nThe gateway checks access permissions.\n\nThe operator revokes expired keys.\n";
const original = () => {
  const bytes = Buffer.from(source, "utf8");
  return {
    assignedSourceId: "SRC1",
    sourceSha256: createHash("sha256").update(bytes).digest("hex"),
    exactUtf8Bytes: bytes,
    bodyStartUtf16: 0,
    bodyEndUtf16: source.length,
  };
};
const window = (quote: string) => {
  const o = original(),
    start = source.indexOf(quote);
  return {
    sourceId: o.assignedSourceId,
    sourceSha256: o.sourceSha256,
    startUtf16: start,
    endUtf16: start + quote.length,
    exactText: quote,
    productionAdmission: false as const,
  };
};
const probe = (
  name: string,
  decision: (quote: string) => "SUPPORTS" | "INSUFFICIENT" | "CONTRADICTS",
) => ({
  id: name + "@v1",
  verify: vi.fn(async (input: { exactQuote: string }) => {
    const result = decision(input.exactQuote);
    return {
      decision: result,
      reason: "PORTFOLIO_PROBE_" + result,
      ...(result === "INSUFFICIENT"
        ? {}
        : {
            evidenceSpan: {
              startUtf16: 0,
              endUtf16: Math.min(12, input.exactQuote.length),
            },
          }),
    };
  }),
});
const config = (
  relevant: (quote: string) => "SUPPORTS" | "INSUFFICIENT" | "CONTRADICTS",
  claim: (quote: string) => "SUPPORTS" | "INSUFFICIENT" | "CONTRADICTS",
) => ({
  semantic: {
    questionRelevanceProbe: probe("question", relevant),
    claimEntailmentProbe: probe("entailment", claim),
  },
});
const question = "Who checks access permissions?",
  claim = "The gateway checks access permissions.";
const quotes = [
  "The operator revokes expired keys.",
  "The gateway checks access permissions.",
];
describe("portfolio of authorized source-bound evidence windows", () => {
  it("recovers a later relevant window without accepting the first irrelevant one", async () => {
    const c = config(
      () => "SUPPORTS",
      (t) => (t.includes("gateway") ? "SUPPORTS" : "INSUFFICIENT"),
    );
    const result = await assessS2ClaimEvidencePortfolio(
      question,
      claim,
      [original()],
      quotes.map(window),
      c,
    );
    expect(result).toMatchObject({
      status: "SUPPORTED_CANDIDATE",
      supportedEvidence: 1,
      contradictedEvidence: 0,
      completeAnswerVerified: false,
      productionAdmission: false,
    });
    expect(result.checks.map((x) => x.status)).toEqual([
      "INSUFFICIENT",
      "SUPPORTED_CANDIDATE",
    ]);
    expect(c.semantic.claimEntailmentProbe.verify).toHaveBeenCalledTimes(2);
  });
  it("exposes conflicting quote verifications instead of silently picking a favorable one", async () => {
    const c = config(
      () => "SUPPORTS",
      (t) => (t.includes("operator") ? "CONTRADICTS" : "SUPPORTS"),
    );
    const result = await assessS2ClaimEvidencePortfolio(
      question,
      claim,
      [original()],
      quotes.map(window),
      c,
    );
    expect(result).toMatchObject({
      status: "CONFLICTING_EVIDENCE",
      supportedEvidence: 1,
      contradictedEvidence: 1,
    });
  });
  it("rejects exploratory or fabricated source IDs before any probe", async () => {
    const c = config(
      () => "SUPPORTS",
      () => "SUPPORTS",
    );
    const f = window(quotes[1]);
    const result = await assessS2ClaimEvidencePortfolio(
      question,
      claim,
      [original()],
      [{ ...f, sourceId: "SRC2" }],
      c,
    );
    expect(result.status).toBe("REJECTED");
    expect(c.semantic.questionRelevanceProbe.verify).not.toHaveBeenCalled();
    expect(
      (
        await assessS2ClaimEvidencePortfolio(
          question,
          claim,
          [original()],
          [{ ...f, productionAdmission: true as never }],
          c,
        )
      ).status,
    ).toBe("REJECTED");
  });
  it("rejects a tampered UTF16 span and duplicate evidence with no positive authority", async () => {
    const c = config(
      () => "SUPPORTS",
      () => "SUPPORTS",
    );
    const good = window(quotes[1]);
    expect(
      (
        await assessS2ClaimEvidencePortfolio(
          question,
          claim,
          [original()],
          [{ ...good, endUtf16: good.endUtf16 - 3 }],
          c,
        )
      ).status,
    ).toBe("REJECTED");
    const repeated = await assessS2ClaimEvidencePortfolio(
      question,
      claim,
      [original()],
      [good, good],
      c,
    );
    expect(repeated.status).toBe("REJECTED");
    expect(repeated.productionAdmission).toBe(false);
  });
  it("never promotes a source-bound but unsupported claim", async () => {
    const c = config(
      () => "SUPPORTS",
      () => "INSUFFICIENT",
    );
    const x = await assessS2ClaimEvidencePortfolio(
      question,
      claim,
      [original()],
      [window(quotes[1])],
      c,
    );
    expect(x).toMatchObject({
      status: "INSUFFICIENT",
      supportedEvidence: 0,
      productionAdmission: false,
      releaseGateAccepted: false,
      independentEvaluation: false,
    });
  });
  it("combines sentence and Markdown candidates with the same pinned token counter", async () => {
    const c = config(
      () => "SUPPORTS",
      (t) => (t.includes("gateway") ? "SUPPORTS" : "INSUFFICIENT"),
    );
    const tokenizer = vi.fn(
      async (_premise: string, _hypothesis: string) => 25,
    );
    const result = await assessS2MultiGranularityClaim(
      original(),
      question,
      claim,
      {
        tokenizerId: "regression-tokenizer@v1",
        countTokens: tokenizer,
        maxTokens: 150,
        maxWindows: 4,
        maxSentencesPerWindow: 2,
        maxMarkdownBlocksPerWindow: 2,
        diversityMode: "NON_REDUNDANT",
      },
      c,
    );
    expect(tokenizer).toHaveBeenCalled();
    expect(result.status, result.reason).toBe("SUPPORTED_CANDIDATE");
    expect(result.checks.length).toBeGreaterThan(0);
    expect(result.checks.every((c) => c.sourceId === "SRC1")).toBe(true);
    expect(result.productionAdmission).toBe(false);
  });
});
