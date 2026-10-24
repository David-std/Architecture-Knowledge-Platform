import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { adaptWriterReviewSubmission } from "../src/s2-writer-review-compat.js";

const sha = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const bytes = (x: unknown) => Buffer.from(JSON.stringify(x));
const id = "a".repeat(64),
  rid = "b".repeat(64),
  r2 = "c".repeat(64);
const orig = "---\ntitle: Test\n---\n## Facts\nThe method returns UTC. 😀";
const quote = "The method returns UTC.";
const begin = orig.indexOf(quote);
function fixture(side: "X" | "Y" = "X") {
  const source = {
    documentKeySha256: id,
    sourceText: orig,
    sourceSha256: sha(orig),
    bodyStartUtf16: orig.indexOf("##"),
    bodyEndUtf16: orig.length,
  };
  const cases = [
    {
      responseKeySha256: rid,
      writerStatus: "ANSWER",
      sourceDocumentKeySha256: id,
    },
    {
      responseKeySha256: r2,
      writerStatus: "ABSTAIN",
      sourceDocumentKeySha256: id,
    },
  ];
  const packet = {
    schemaVersion: "akp.s2.writer-semantic-blind-packet.v1",
    reviewerAssignment: side,
    sourceDocuments: [source],
    cases,
  };
  const frozenPacketBytes = bytes(packet);
  const reviewerCases = [
    {
      responseKeySha256: rid,
      sourceAnswerability: "ANSWERABLE_EXPLICIT",
      answerFaithfulness: "FULL",
      abstention: null,
      note: null,
      exactOriginalQuoteSpans: [
        {
          ...(side === "X"
            ? { documentKeySha256: id, sourceSha256: sha(orig) }
            : {}),
          startUtf16: begin,
          endUtf16: begin + quote.length,
          quote,
        },
      ],
    },
    {
      responseKeySha256: r2,
      sourceAnswerability: "NOT_ANSWERABLE",
      answerFaithfulness: null,
      abstention: "JUSTIFIED",
      note: null,
      exactOriginalQuoteSpans: [],
    },
  ];
  const submission = {
    schemaVersion: "akp.s2.writer-semantic-review-submission.v1",
    reviewerAssignment: side,
    packetSha256: sha(frozenPacketBytes),
    cases: reviewerCases,
    answersFilled: true,
    independentReviewAttested: false,
  };
  const input = {
    rawSubmissionBytes: bytes(submission),
    frozenPacketBytes,
    expectedPacketSha256: sha(frozenPacketBytes),
    expectedReviewer: side,
  };
  return { input, packet, submission };
}
describe("S2 strict, reversible submitted-review compatibility", () => {
  it("accepts X's extra source SHA only if it equals frozen original", () => {
    const { input } = fixture("X");
    const r = adaptWriterReviewSubmission(input);
    expect(r.normalized.cases[0]?.sourceAnswerability).toBe(
      "EXPLICITLY_DECIDABLE",
    );
    expect(r.normalized.cases[0]?.answerFaithfulness).toBe("FULLY_SUPPORTED");
    expect(r.audit).toMatchObject({
      responseCount: 2,
      originalQuoteSpansVerified: 1,
      sourceShaFieldsVerified: 1,
      sourceDocumentKeysDerived: 0,
      gateAccepted: false,
      independentReviewAttested: false,
    });
    expect(JSON.stringify(r.normalized)).not.toContain("sourceSha256");
  });
  it("recovers missing Y quote document keys from its own pinned response, never by guessing", () => {
    const { input } = fixture("Y");
    const r = adaptWriterReviewSubmission(input);
    expect(r.audit.sourceDocumentKeysDerived).toBe(1);
    expect(
      r.normalized.cases[0]?.exactOriginalQuoteSpans[0]?.documentKeySha256,
    ).toBe(id);
  });
  it("rejects tampered packet and unsupported additional fields", () => {
    const a = fixture();
    expect(() =>
      adaptWriterReviewSubmission({
        ...a.input,
        expectedPacketSha256: sha("wrong"),
      }),
    ).toThrow("PACKET_HASH_MISMATCH");
    const b = fixture();
    (b.submission.cases[0] as Record<string, unknown>).invented = true;
    expect(() =>
      adaptWriterReviewSubmission({
        ...b.input,
        rawSubmissionBytes: bytes(b.submission),
      }),
    ).toThrow("REVIEWER_ROW_INVALID");
  });
  it("rejects alternate source identities and mismatched extra SHA", () => {
    const a = fixture();
    Object.assign(a.submission.cases[0]!.exactOriginalQuoteSpans[0]!, {
      sourceSha256: sha("foreign"),
    });
    expect(() =>
      adaptWriterReviewSubmission({
        ...a.input,
        rawSubmissionBytes: bytes(a.submission),
      }),
    ).toThrow("QUOTE_SOURCE_IDENTITY_INVALID");
    const b = fixture();
    Object.assign(b.submission.cases[0]!.exactOriginalQuoteSpans[0]!, {
      documentKeySha256: sha("foreign"),
    });
    expect(() =>
      adaptWriterReviewSubmission({
        ...b.input,
        rawSubmissionBytes: bytes(b.submission),
      }),
    ).toThrow("QUOTE_SOURCE_IDENTITY_INVALID");
  });
  it("rejects fabricated or inaccurate original quote offsets and duplicate spans", () => {
    const a = fixture();
    a.submission.cases[0]!.exactOriginalQuoteSpans[0]!.quote =
      "Not in the file";
    expect(() =>
      adaptWriterReviewSubmission({
        ...a.input,
        rawSubmissionBytes: bytes(a.submission),
      }),
    ).toThrow("QUOTE_NOT_EXACT_ORIGINAL_UTF16");
    const b = fixture();
    b.submission.cases[0]!.exactOriginalQuoteSpans[0]!.startUtf16 = 0;
    expect(() =>
      adaptWriterReviewSubmission({
        ...b.input,
        rawSubmissionBytes: bytes(b.submission),
      }),
    ).toThrow("QUOTE_NOT_EXACT_ORIGINAL_UTF16");
    const c = fixture();
    c.submission.cases[0]!.exactOriginalQuoteSpans.push({
      ...c.submission.cases[0]!.exactOriginalQuoteSpans[0]!,
    });
    expect(() =>
      adaptWriterReviewSubmission({
        ...c.input,
        rawSubmissionBytes: bytes(c.submission),
      }),
    ).toThrow("DUPLICATE_QUOTE");
  });
  it("rejects a split UTF-16 surrogate pair even if substring matches", () => {
    const x = fixture(),
      pos = orig.indexOf("😀");
    x.submission.cases[0]!.exactOriginalQuoteSpans[0] = {
      documentKeySha256: id,
      sourceSha256: sha(orig),
      startUtf16: pos + 1,
      endUtf16: pos + 2,
      quote: "\ude00",
    };
    expect(() =>
      adaptWriterReviewSubmission({
        ...x.input,
        rawSubmissionBytes: bytes(x.submission),
      }),
    ).toThrow("QUOTE_NOT_EXACT_ORIGINAL_UTF16");
  });
  it("rejects swapped records, duplicate IDs, and unknown labels", () => {
    const a = fixture();
    a.submission.cases[0]!.responseKeySha256 = r2;
    expect(() =>
      adaptWriterReviewSubmission({
        ...a.input,
        rawSubmissionBytes: bytes(a.submission),
      }),
    ).toThrow("ABSTAIN_LABEL_INVALID");
    const b = fixture();
    b.submission.cases[0]!.sourceAnswerability = "CONTRADICTED";
    expect(() =>
      adaptWriterReviewSubmission({
        ...b.input,
        rawSubmissionBytes: bytes(b.submission),
      }),
    ).toThrow("REVIEWER_ROW_INVALID");
    const c = fixture();
    c.submission.cases[0]!.answerFaithfulness = "PERFECT";
    expect(() =>
      adaptWriterReviewSubmission({
        ...c.input,
        rawSubmissionBytes: bytes(c.submission),
      }),
    ).toThrow("ANSWER_LABEL_INVALID");
  });
  it("requires literal evidence for fully supported and unnecessary abstention", () => {
    const a = fixture();
    a.submission.cases[0]!.exactOriginalQuoteSpans = [];
    expect(() =>
      adaptWriterReviewSubmission({
        ...a.input,
        rawSubmissionBytes: bytes(a.submission),
      }),
    ).toThrow("SUPPORTED_WITHOUT_SOURCE_QUOTE");
    const b = fixture();
    b.submission.cases[1]!.sourceAnswerability = "ANSWERABLE_EXPLICIT";
    b.submission.cases[1]!.abstention = "UNNECESSARY";
    expect(() =>
      adaptWriterReviewSubmission({
        ...b.input,
        rawSubmissionBytes: bytes(b.submission),
      }),
    ).toThrow("UNNECESSARY_WITHOUT_SOURCE_QUOTE");
  });
  it("does not interpret the reviewer's false independence attestation as gate acceptance", () => {
    const r = adaptWriterReviewSubmission(fixture().input);
    expect(r.audit.independentReviewAttested).toBe(false);
    expect(r.audit.semanticEntailmentIndependentlyCertified).toBe(false);
    expect(r.normalized.independentReviewAttested).toBe(false);
  });
});
