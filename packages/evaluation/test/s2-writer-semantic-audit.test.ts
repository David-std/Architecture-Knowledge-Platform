import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { auditWriterSemanticReviewPackets } from "../src/s2-writer-semantic-audit.js";
const sha = (x: Uint8Array) => createHash("sha256").update(x).digest("hex");
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
const doc = "---\r\ntitle: QA\r\n---\r\n## Fact\r\nThe answer is stated. 😀";
const frame = doc.indexOf("##");
const start = doc.indexOf("The answer");
const id = "a".repeat(64),
  key = "b".repeat(64),
  pin = "c".repeat(64),
  sourcePin = "d".repeat(64);
function fixture() {
  const packet = (reviewerAssignment: "X" | "Y") => ({
    schemaVersion: "akp.s2.writer-semantic-blind-packet.v1",
    reviewerAssignment,
    caseManifestSha256: pin,
    sourceManifestSha256: sourcePin,
    writerRunSha256: "e".repeat(64),
    instructions: "blind original-source review",
    sourceDocuments: [
      {
        documentKeySha256: id,
        sourceText: doc,
        sourceSha256: "f".repeat(64),
        bodyStartUtf16: frame,
        bodyEndUtf16: doc.length,
      },
    ],
    cases: [
      {
        responseKeySha256: key,
        language: "en",
        question: "What is stated?",
        sourceDocumentKeySha256: id,
        writerStatus: "ANSWER",
        writerAnswer: "The answer is stated.",
        reportedCitationIds: ["CIT1"],
        annotation: {
          sourceAnswerability: null,
          answerFaithfulness: null,
          abstention: null,
          exactOriginalQuoteSpans: [],
          note: null,
        },
      },
    ],
    armAllocationRevealed: false,
    originalReviewerVerdictsIncluded: false,
    fullModelCitationSourceMappingAvailable: false,
    originalSourceSemanticJudgmentsOnly: true,
    reviewerIndependenceAuthenticated: false,
    gateAccepted: false,
  });
  const packetXBytes = bytes(packet("X")),
    packetYBytes = bytes(packet("Y"));
  const receiptBytes = bytes({
    schemaVersion: "akp.s2.writer-semantic-review-packet-receipt.v1",
    packets: [
      {
        assignment: "X",
        file: "x.json",
        sha256: sha(packetXBytes),
        responseCount: 1,
      },
      {
        assignment: "Y",
        file: "y.json",
        sha256: sha(packetYBytes),
        responseCount: 1,
      },
    ],
    questionPacketPin: pin,
    sourceManifestPin: sourcePin,
    writerRunSha256: "e".repeat(64),
    modelCitationSourceMappingAvailable: false,
    independentReviewCompleted: false,
    gateAccepted: false,
  });
  const submission = (reviewerAssignment: "X" | "Y") => ({
    schemaVersion: "akp.s2.writer-semantic-review-submission.v1",
    reviewerAssignment,
    packetSha256: sha(reviewerAssignment === "X" ? packetXBytes : packetYBytes),
    cases: [
      {
        responseKeySha256: key,
        sourceAnswerability: "EXPLICITLY_DECIDABLE",
        answerFaithfulness: "FULLY_SUPPORTED",
        abstention: null,
        exactOriginalQuoteSpans: [
          {
            documentKeySha256: id,
            startUtf16: start,
            endUtf16: start + "The answer is stated.".length,
            quote: "The answer is stated.",
          },
        ],
        note: null,
      },
    ],
    answersFilled: true,
    independentReviewAttested: false,
  });
  return {
    receiptBytes,
    packetXBytes,
    packetYBytes,
    sourceManifestSha256: sourcePin,
    caseManifestSha256: pin,
    submissionX: submission("X"),
    submissionY: submission("Y"),
  };
}
describe("offline writer semantic original-file audit", () => {
  it("verifies packet receipts without claiming returned reviews", () => {
    const x = fixture();
    const r = auditWriterSemanticReviewPackets({
      ...x,
      submissionX: undefined,
      submissionY: undefined,
    });
    expect(r).toMatchObject({
      status: "PACKETS_VERIFIED_UNREVIEWED",
      caseCount: 1,
      sourceCount: 1,
      submissionsReceived: 0,
      gateAccepted: false,
      semanticSupportIndependentlyEstablished: false,
      rawModelPassageCitationMappingAvailable: false,
    });
  });
  it("counts exact source quote matches and two reviewer labels but not semantic truth", () => {
    const r = auditWriterSemanticReviewPackets(fixture());
    expect(r).toMatchObject({
      status: "TWO_SEMANTIC_SUBMISSIONS_STRUCTURALLY_VERIFIED",
      submissionsReceived: 2,
      reviewerLabelAgreement: 1,
      reviewerLabelDisagreement: 0,
      exactSourceQuoteSpansMatched: 2,
      semanticSupportIndependentlyEstablished: false,
      gateAccepted: false,
      actualAdmissionFalsePositiveRate: null,
    });
    expect(JSON.stringify(r)).not.toContain(doc);
  });
  it("rejects altered packet bytes and incorrect semantic label", () => {
    const x = fixture();
    const packet = JSON.parse(new TextDecoder().decode(x.packetYBytes));
    packet.cases[0].writerAnswer = "changed";
    expect(() =>
      auditWriterSemanticReviewPackets({ ...x, packetYBytes: bytes(packet) }),
    ).toThrow("PACKET_RECEIPT_HASH_MISMATCH");
    const y = fixture();
    y.submissionY.cases[0]!.answerFaithfulness = "invented";
    expect(() => auditWriterSemanticReviewPackets(y)).toThrow(
      "ANSWER_VERDICT_INVALID",
    );
  });
  it("rejects source-offset errors, fake quotes and missing required evidence", () => {
    const x = fixture();
    x.submissionX.cases[0]!.exactOriginalQuoteSpans[0]!.quote = "fabricated";
    expect(() => auditWriterSemanticReviewPackets(x)).toThrow(
      "QUOTE_NOT_LITERAL_ORIGINAL_UTF16",
    );
    const y = fixture();
    y.submissionX.cases[0]!.exactOriginalQuoteSpans = [];
    expect(() => auditWriterSemanticReviewPackets(y)).toThrow(
      "FULL_SUPPORT_WITHOUT_LITERAL_QUOTE",
    );
  });
  it("rejects partial reviewer submissions", () => {
    const x = fixture();
    expect(() =>
      auditWriterSemanticReviewPackets({ ...x, submissionY: undefined }),
    ).toThrow("INCOMPLETE_REVIEWERS");
  });
  it("reports label disagreement without automating an adjudication", () => {
    const x = fixture();
    x.submissionY.cases[0]!.answerFaithfulness = "PARTIALLY_SUPPORTED";
    const r = auditWriterSemanticReviewPackets(x);
    expect(r.reviewerLabelDisagreement).toBe(1);
    expect(r.semanticSupportIndependentlyEstablished).toBe(false);
  });
});
