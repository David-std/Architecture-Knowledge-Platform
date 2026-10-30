import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  prepareS2ReaderClaimReview,
  inspectS2ReaderReviewPacketPair,
  inspectS2ReaderClaimReviewSubmissions,
  type S2ReaderAdmittedReviewInput,
} from "../src/s2-reader-claim-review.js";
const passage =
  "The employee informs the pest company, not the other way around. 🐭";
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
const seed = new Uint8Array(32).fill(7);
const input: S2ReaderAdmittedReviewInput = {
  caseId: "sa-q33",
  language: "es",
  originalQuestion: "¿La empresa de plagas tiene que avisar al restaurante?",
  proposedAnswer: "no",
  sourcePassage: passage,
  sourcePassageSha256: sha(passage),
  evidenceQuote: passage,
  quoteStartUtf16: 0,
  quoteEndUtf16: passage.length,
};
describe("S2 historical source-bound reader claim review packets", () => {
  it("creates pinned, unbiased dual reviewer packets without developer gold or LLM verdicts", () => {
    const rows = [
      input,
      {
        ...input,
        caseId: "next-q1",
        originalQuestion: "Who notifies the pest company?",
        language: "en" as const,
        proposedAnswer: "the employee",
      },
    ];
    const output = prepareS2ReaderClaimReview(rows, seed);
    const audit = inspectS2ReaderReviewPacketPair(
      output.packetXBytes,
      output.packetYBytes,
      output.receiptBytes,
    );
    expect(audit).toEqual({
      status: "PACKETS_VERIFIED_UNREVIEWED",
      caseCount: 2,
      independentHumanReviewVerified: false,
      releaseGateAccepted: false,
    });
    const x = JSON.parse(output.packetXBytes.toString()) as Record<
      string,
      unknown
    >;
    const y = JSON.parse(output.packetYBytes.toString()) as Record<
      string,
      unknown
    >;
    expect(x.historicalUnitGoldIncluded).toBe(false);
    expect(y.modelAdmitVerdictsIncluded).toBe(false);
    expect(x.releaseGateAccepted).toBe(false);
    expect(output.privateMap).toHaveLength(2);
    const leaked =
      output.packetXBytes.toString() + output.packetYBytes.toString();
    expect(leaked).not.toContain("sa-q33");
    expect(leaked).not.toContain("expected");
    expect(leaked).not.toContain("goldLabel");
    expect(leaked).not.toContain("guardDecision");
    expect(output.submissionXBytes.toString()).toContain('"UNCERTAIN"');
    expect(output.submissionYBytes.toString()).toContain('"UNKNOWN"');
    expect(output.independentHumanReviewCompleted).toBe(false);
  });
  it("refuses poisoned excerpts, altered digests, split unicode offsets and duplicate case IDs", () => {
    expect(() =>
      prepareS2ReaderClaimReview(
        [{ ...input, sourcePassageSha256: sha("something else") }],
        seed,
      ),
    ).toThrow(/SOURCE_OR_SPAN/);
    expect(() =>
      prepareS2ReaderClaimReview(
        [{ ...input, evidenceQuote: "fabricated" }],
        seed,
      ),
    ).toThrow(/SOURCE_OR_SPAN/);
    const emojiStart = passage.indexOf("🐭");
    expect(() =>
      prepareS2ReaderClaimReview(
        [
          {
            ...input,
            evidenceQuote: passage.slice(0, emojiStart + 1),
            quoteEndUtf16: emojiStart + 1,
          },
        ],
        seed,
      ),
    ).toThrow(/SOURCE_OR_SPAN/);
    expect(() => prepareS2ReaderClaimReview([input, input], seed)).toThrow(
      /SOURCE_OR_SPAN/,
    );
    expect(() =>
      prepareS2ReaderClaimReview([input], new Uint8Array(8)),
    ).toThrow(/INPUT_INVALID/);
  });

  it("requires two complete, distinct, self-attested review submissions without certifying independence", () => {
    const o = prepareS2ReaderClaimReview([input], seed);
    const sX = JSON.parse(o.submissionXBytes.toString());
    const sY = JSON.parse(o.submissionYBytes.toString());
    sX.reviewerId = "reviewer-alpha";
    sY.reviewerId = "reviewer-beta";
    sX.reviewerSelfAttestedIndependent = true;
    sY.reviewerSelfAttestedIndependent = true;
    sX.cases[0].answerFaithfulness = "WRONG_OR_UNSUPPORTED";
    sY.cases[0].answerFaithfulness = "WRONG_OR_UNSUPPORTED";
    sX.cases[0].facets.direction = "CONFLICT";
    sY.cases[0].facets.direction = "CONFLICT";
    const bytes = (x: unknown) => Buffer.from(JSON.stringify(x));
    const report = inspectS2ReaderClaimReviewSubmissions({
      packetXBytes: o.packetXBytes,
      packetYBytes: o.packetYBytes,
      receiptBytes: o.receiptBytes,
      submissionXBytes: bytes(sX),
      submissionYBytes: bytes(sY),
    });
    expect(report).toMatchObject({
      status: "TWO_COMPLETE_SUBMISSIONS_STRUCTURALLY_VERIFIED",
      caseCount: 1,
      labelAgreements: 1,
      labelDisagreements: 0,
      bothWrongOrUnsupported: 1,
      reviewerIdentityAuthenticated: false,
      independentHumanReviewVerified: false,
      originalSourceCustodyAuthenticated: false,
      releaseGateAccepted: false,
    });
    expect(() =>
      inspectS2ReaderClaimReviewSubmissions({
        packetXBytes: o.packetXBytes,
        packetYBytes: o.packetYBytes,
        receiptBytes: o.receiptBytes,
        submissionXBytes: o.submissionXBytes,
        submissionYBytes: bytes(sY),
      }),
    ).toThrow(/METADATA_INVALID/);
    sY.reviewerId = sX.reviewerId;
    expect(() =>
      inspectS2ReaderClaimReviewSubmissions({
        packetXBytes: o.packetXBytes,
        packetYBytes: o.packetYBytes,
        receiptBytes: o.receiptBytes,
        submissionXBytes: bytes(sX),
        submissionYBytes: bytes(sY),
      }),
    ).toThrow(/REVIEWERS_NOT_DISTINCT/);
    sY.reviewerId = "reviewer-beta";
    sY.cases[0].facets.direction = "FABRICATED";
    expect(() =>
      inspectS2ReaderClaimReviewSubmissions({
        packetXBytes: o.packetXBytes,
        packetYBytes: o.packetYBytes,
        receiptBytes: o.receiptBytes,
        submissionXBytes: bytes(sX),
        submissionYBytes: bytes(sY),
      }),
    ).toThrow(/CASE_INVALID/);
  });
  it("does not mistake overall-label agreement for agreement on semantic roles", () => {
    // All data here are deterministic test fixtures, not human review data.
    const o = prepareS2ReaderClaimReview([input], seed);
    const x = JSON.parse(o.submissionXBytes.toString());
    const y = JSON.parse(o.submissionYBytes.toString());
    for (const [submission, reviewerId] of [
      [x, "reviewer-alpha"],
      [y, "reviewer-beta"],
    ] as const) {
      submission.reviewerId = reviewerId;
      submission.reviewerSelfAttestedIndependent = true;
      submission.cases[0].answerFaithfulness = "FULLY_SUPPORTED";
      for (const facet of Object.keys(submission.cases[0].facets))
        submission.cases[0].facets[facet] = "ALIGNED";
    }
    const audit = () =>
      inspectS2ReaderClaimReviewSubmissions({
        packetXBytes: o.packetXBytes,
        packetYBytes: o.packetYBytes,
        receiptBytes: o.receiptBytes,
        submissionXBytes: Buffer.from(JSON.stringify(x)),
        submissionYBytes: Buffer.from(JSON.stringify(y)),
      });
    expect(audit()).toMatchObject({
      labelAgreements: 1,
      facetDisagreementCases: 0,
      bothSupported: 1,
      unresolvedCases: 0,
      independentHumanReviewVerified: false,
      releaseGateAccepted: false,
    });

    // Reviewers agree on the overall label, yet one says the relation
    // direction matters and the other says it does not apply.
    y.cases[0].facets.direction = "NOT_APPLICABLE";
    expect(audit()).toMatchObject({
      labelAgreements: 1,
      labelDisagreements: 0,
      facetDisagreementCases: 1,
      facetDisagreementsByName: { direction: 1, subject: 0, answerRole: 0 },
      bothSupported: 0,
      unresolvedCases: 1,
    });

    // A FULLY_SUPPORTED answer with a self-declared conflicting or unknown
    // dimension is inconsistent even before comparing the other reviewer.
    y.cases[0].facets.direction = "CONFLICT";
    expect(audit).toThrow(/SUBMISSION_CASE_INVALID/);
    y.cases[0].facets.direction = "UNKNOWN";
    expect(audit).toThrow(/SUBMISSION_CASE_INVALID/);

    // The same hidden facet mismatch must remain unresolved for negative
    // judgments; it cannot be reported as unqualified negative consensus.
    x.cases[0].answerFaithfulness = "WRONG_OR_UNSUPPORTED";
    y.cases[0].answerFaithfulness = "WRONG_OR_UNSUPPORTED";
    y.cases[0].facets.direction = "CONFLICT";
    expect(audit()).toMatchObject({
      labelAgreements: 1,
      facetDisagreementCases: 1,
      bothWrongOrUnsupported: 0,
      unresolvedCases: 1,
    });
  });

  it("does not accept reviewer packets carrying added hidden gold even with a matching forged receipt hash", () => {
    const o = prepareS2ReaderClaimReview([input], seed);
    const tampered = JSON.parse(o.packetXBytes.toString());
    tampered.cases[0].historicalGoldLabel = "ANSWERS";
    const bytes = Buffer.from(JSON.stringify(tampered));
    const receipt = JSON.parse(o.receiptBytes.toString());
    receipt.packetXSha256 = createHash("sha256").update(bytes).digest("hex");
    expect(() =>
      inspectS2ReaderReviewPacketPair(
        bytes,
        o.packetYBytes,
        Buffer.from(JSON.stringify(receipt)),
      ),
    ).toThrow(/CASE_INVALID/);
  });
  it("detects post-freeze source mutations, reviewer packet substitution and mismatched case sets", () => {
    const o = prepareS2ReaderClaimReview([input], seed);
    const forged = JSON.parse(o.packetXBytes.toString());
    forged.cases[0].proposedAnswer = "yes";
    expect(() =>
      inspectS2ReaderReviewPacketPair(
        Buffer.from(JSON.stringify(forged)),
        o.packetYBytes,
        o.receiptBytes,
      ),
    ).toThrow(/BINDING_INVALID/);
    const replaced = prepareS2ReaderClaimReview(
      [{ ...input, proposedAnswer: "yes" }],
      seed,
    );
    expect(() =>
      inspectS2ReaderReviewPacketPair(
        o.packetXBytes,
        replaced.packetYBytes,
        o.receiptBytes,
      ),
    ).toThrow(/BINDING_INVALID/);
    expect(() =>
      inspectS2ReaderReviewPacketPair(
        o.packetYBytes,
        o.packetXBytes,
        o.receiptBytes,
      ),
    ).toThrow(/BINDING_INVALID/);
  });
});
