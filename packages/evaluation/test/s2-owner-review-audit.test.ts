import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { auditOwnerReviewPackets } from "../src/s2-owner-review-audit.js";
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const buf = (x: unknown) => Buffer.from(JSON.stringify(x), "utf8");
const source = "## Evidence\nA claim is verified. 😀";
const doc = sha("source");
const q = "Does the document verify the claim?";
const id = sha("en\0" + q);
const start = source.indexOf("A claim is verified.");
function fixture() {
  const make = (assignment: "X" | "Y") => ({
    schemaVersion: "akp.s2.owner-holdout-reviewer-packet.v1",
    reviewerAssignment: assignment,
    candidateManifestSha256: sha("sources"),
    caseManifestSha256: sha("cases"),
    originals: [
      {
        sourceKeySha256: doc,
        sourceSha256: sha(source),
        publisherFamily: "nodejs",
        relativePath: "api/test.md",
        sourceText: source,
      },
    ],
    cases: Array.from({ length: 8 }, (_, i) => ({
      questionKeySha256: i === 0 ? id : sha("en\0" + q + i),
      question: i === 0 ? q : q + i,
      language: "en",
      sourceKeySha256: doc,
      reviewerDisposition: null,
      reviewerAnswer: null,
      supportingQuotes: [],
    })),
    ownerProposedGoldIncluded: false,
    writerOutputsIncluded: false,
    custodianMode: "OWNER_CONTROLLED",
    independentlyCredentialedReview: false,
    gateAccepted: false,
  });
  const x = make("X"),
    y = make("Y"),
    packetXBytes = buf(x),
    packetYBytes = buf(y);
  const receiptBytes = buf({
    schemaVersion: "akp.s2.owner-review-packets-receipt.v1",
    sourceManifestSha256: sha("sources"),
    caseManifestSha256: sha("cases"),
    packets: [
      {
        assignment: "X",
        packetFile: "x.json",
        packetSha256: sha(packetXBytes),
        caseCount: 8,
      },
      {
        assignment: "Y",
        packetFile: "y.json",
        packetSha256: sha(packetYBytes),
        caseCount: 8,
      },
    ],
    ownerControlled: true,
    externalIndependenceCertified: false,
    evaluationsReceived: 0,
    gateAccepted: false,
  });
  const makeSub = (side: "X" | "Y") => ({
    schemaVersion: "akp.s2.owner-reviewer-submission.v1",
    reviewerAssignment: side,
    packetSha256: sha(side === "X" ? packetXBytes : packetYBytes),
    cases: x.cases.map((c, i) => ({
      questionKeySha256: c.questionKeySha256,
      answerability: i === 0 ? "ANSWERABLE_EXPLICIT" : "NOT_ANSWERABLE",
      answerText: i === 0 ? "Yes." : "",
      exactSourceQuotes:
        i === 0
          ? [
              {
                sourceKeySha256: doc,
                startUtf16: start,
                endUtf16: start + "A claim is verified.".length,
                quote: "A claim is verified.",
              },
            ]
          : [],
      note: null,
    })),
    reviewerIndependenceSelfReported: false,
    externallyCredentialed: false,
  });
  return {
    receiptBytes,
    packetXBytes,
    packetYBytes,
    reviewerX: makeSub("X"),
    reviewerY: makeSub("Y"),
  };
}
describe("owner-managed blind reviewer audit", () => {
  it("accepts frozen packet preflight but no fabricated reviews", () => {
    const r = auditOwnerReviewPackets({
      ...fixture(),
      reviewerX: undefined,
      reviewerY: undefined,
    });
    expect(r).toMatchObject({
      status: "OWNER_PACKETS_VERIFIED_UNREVIEWED",
      totalQuestions: 8,
      submittedReviewers: 0,
      gateAccepted: false,
      independentlyAuthenticatedReviewers: false,
    });
  });
  it("accepts complete exact quotes and label agreement without semantic release claims", () => {
    const r = auditOwnerReviewPackets(fixture());
    expect(r).toMatchObject({
      status: "OWNER_TWO_SUBMISSIONS_STRUCTURALLY_VERIFIED",
      totalQuestions: 8,
      submittedReviewers: 2,
      literalOriginalQuoteSpans: 2,
      exactLabelAgreement: 8,
      labelDisagreements: 0,
      externallyAccreditedCustodian: false,
      negativeAbsenceIndependentlyEstablished: false,
      semanticCorrectnessAdjudicated: false,
      gateAccepted: false,
    });
  });
  it("rejects modified packet bytes", () => {
    const x = fixture();
    x.packetYBytes = Buffer.concat([x.packetYBytes, Buffer.from(" ")]);
    expect(() => auditOwnerReviewPackets(x)).toThrow(
      "PACKET_RECEIPT_HASH_MISMATCH",
    );
  });
  it("rejects one reviewer only", () => {
    const x = fixture();
    expect(() =>
      auditOwnerReviewPackets({ ...x, reviewerY: undefined }),
    ).toThrow("INCOMPLETE_REVIEWERS");
  });
  it("rejects changed quote and offset", () => {
    const x = fixture();
    x.reviewerX.cases[0]!.exactSourceQuotes[0]!.quote = "fabricated";
    expect(() => auditOwnerReviewPackets(x)).toThrow(
      "QUOTE_NOT_LITERAL_FROZEN_ORIGINAL_UTF16",
    );
  });
  it("rejects ungrounded positive answers", () => {
    const x = fixture();
    x.reviewerY.cases[0]!.exactSourceQuotes = [];
    expect(() => auditOwnerReviewPackets(x)).toThrow(
      "EXPLICIT_ANSWER_NEEDS_EVIDENCE",
    );
  });
  it("rejects unsupported labels that present an answer", () => {
    const x = fixture();
    x.reviewerX.cases[2]!.answerText = "guessed";
    expect(() => auditOwnerReviewPackets(x)).toThrow(
      "UNSUPPORTED_ANSWER_MUST_ABSTAIN",
    );
  });
});
