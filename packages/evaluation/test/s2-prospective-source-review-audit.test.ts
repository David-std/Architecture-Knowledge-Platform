import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { auditS2ProspectiveSourceReview } from "../src/s2-prospective-source-review-audit.js";
const sha = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
const bytes = (x: unknown) => Buffer.from(JSON.stringify(x), "utf8");
const source =
  "The remote engineering review confirmed the 🔥 release after audit.";
const srcKey = sha("family-root-and-source");
const positive = () => {
  const answer = "The remote engineering review confirmed the release.";
  return {
    reviewCaseKey: "",
    sourceAnswerability: "ANSWERABLE_EXPLICIT",
    reviewerAnswer: answer,
    supportingQuoteSpans: [
      {
        sourceKeySha256: srcKey,
        startUtf16: 0,
        endUtf16: source.length,
        exactText: source,
      },
    ],
    wholeAuthorizedCorpusAbsenceChecked: false,
    reviewerNotes: null,
  };
};
const negative = () => ({
  reviewCaseKey: "",
  sourceAnswerability: "NOT_ANSWERABLE",
  reviewerAnswer: null,
  supportingQuoteSpans: [],
  wholeAuthorizedCorpusAbsenceChecked: true,
  reviewerNotes: null,
});
const cohort = () => {
  const doc = {
    sourceKeySha256: srcKey,
    originalSha256: sha(source),
    originalText: source,
    upstreamRepository: "publisher/private-repo",
    revision40Hex: "d".repeat(40),
    relativePath: "doc.md",
    authorizedVaultScope: "vault-1",
  };
  const cases = Array.from({ length: 240 }, (_, i) => ({
    reviewCaseKey: sha("blind-task-" + i),
    language: i % 2 ? "es" : "en",
    question: "Independent artificial task " + i + "?",
    sourceKeySha256: srcKey,
    sourceAnswerability: null,
    reviewerAnswer: null,
    supportingQuoteSpans: [],
    wholeAuthorizedCorpusAbsenceChecked: null,
    reviewerNotes: null,
  }));
  const mkPacket = (reviewer: "X" | "Y") => ({
    schemaVersion: "akp.s2.preinference-original-source-review.v1",
    reviewer,
    frozenIntakeSha256: sha("unseen-intake"),
    sourceDocs: [{ ...doc }],
    cases: cases.map((c) => ({ ...c, supportingQuoteSpans: [] })),
    expectedGoldIncluded: false,
    modelOutputsIncluded: false,
    reviewerIdentityAuthenticated: false,
    wholeAuthorizedCorpusAbsenceProven: false,
    independentGoldAdjudicated: false,
    releaseGateAccepted: false,
  });
  const pX = mkPacket("X"),
    pY = mkPacket("Y");
  const mkReview = (reviewer: "X" | "Y", p: unknown) => ({
    schemaVersion: "akp.s2.preinference-review-submission.v1",
    reviewer,
    packetSha256: sha(bytes(p)),
    cases: cases.map((c, i) => ({
      ...(i % 2 === 0 ? positive() : negative()),
      reviewCaseKey: c.reviewCaseKey,
    })),
  });
  const x = mkReview("X", pX),
    y = mkReview("Y", pY);
  const run = () =>
    auditS2ProspectiveSourceReview({
      packetXBytes: bytes(pX),
      packetXSha256: sha(bytes(pX)),
      packetYBytes: bytes(pY),
      packetYSha256: sha(bytes(pY)),
      submissionXBytes: bytes(x),
      submissionXSha256: sha(bytes(x)),
      submissionYBytes: bytes(y),
      submissionYSha256: sha(bytes(y)),
    });
  return { pX, pY, x, y, run };
};
describe("S2 pre-inference SOURCE-only X/Y submissions are not semantic gold", () => {
  it("checks 240 paired responses without manufacturing authenticated reviewer truth", () => {
    const a = cohort().run();
    expect(a).toMatchObject({
      status: "TWO_REVIEW_SUBMISSIONS_STRUCTURALLY_VERIFIED_NOT_ADJUDICATED",
      caseCount: 240,
      sourceCount: 1,
      agreement: {
        fullyAgreed: 240,
        explicitAgreed: 120,
        negativeAgreed: 120,
        disagreements: 0,
      },
      independentSourceGoldCertified: false,
      externalSourceAuthorityAuthenticated: false,
      completeCorpusAbsenceIndependentlyProven: false,
      releaseGateAccepted: false,
    });
    expect(a.zPacket.cases).toHaveLength(0);
  });
  it("sends differing source judgments to Z without X/Y answers or target stratum", () => {
    const a = cohort();
    const caseId = a.x.cases[0]!.reviewCaseKey;
    a.y.cases[0] = { ...negative(), reviewCaseKey: caseId };
    const x = a.run();
    expect(x.agreement).toMatchObject({ fullyAgreed: 239, disagreements: 1 });
    expect(x.zPacket.cases).toHaveLength(1);
    expect(x.zPacket).toMatchObject({
      reviewerXAndYAnswersIncluded: false,
      independentTruthCertified: false,
      releaseGateAccepted: false,
    });
    expect(x.zPacket.cases[0]).toMatchObject({
      reviewCaseKey: caseId,
      sourceAnswerability: null,
      supportingQuoteSpans: [],
      wholeAuthorizedCorpusAbsenceChecked: null,
    });
    expect(JSON.stringify(x.zPacket)).not.toContain("targetStratum");
  });
  it("refuses a positive answer whose cited UTF-16 raw original is altered", () => {
    const a = cohort();
    a.x.cases[0]!.supportingQuoteSpans[0]!.exactText = "unrelated SOURCE";
    expect(a.run).toThrow(/QUOTE_RAW_SOURCE_SPAN_INVALID/);
  });
  it("requires negative whole-authorized-corpus review rather than inferred absence", () => {
    const a = cohort();
    a.x.cases[1]!.wholeAuthorizedCorpusAbsenceChecked = false;
    expect(a.run).toThrow(/NEGATIVE_WITHOUT_WHOLE_CORPUS_ATTESTATION/);
  });
  it("rejects a missing reviewer case, duplicate case, and fake packet identity", () => {
    const a = cohort();
    a.y.cases.pop();
    expect(a.run).toThrow(/SUBMISSION_STRUCTURE/);
    const b = cohort();
    b.x.cases[1]!.reviewCaseKey = b.x.cases[0]!.reviewCaseKey;
    expect(b.run).toThrow(/SUBMISSION_CASE_INVALID/);
    const c = cohort();
    c.x.packetSha256 = "a".repeat(64);
    expect(c.run).toThrow(/SUBMISSION_STRUCTURE/);
  });
  it("rejects a mismatched X/Y frozen question source even with repinned bytes", () => {
    const a = cohort();
    a.pY.cases[0]!.question = "Another question";
    a.y.packetSha256 = sha(bytes(a.pY));
    expect(a.run).toThrow(/REVIEW_QUESTION_OR_SOURCE_DIFFERENCE/);
  });
  it("refuses unpinned submission and forged original source digest", () => {
    const a = cohort();
    const b = a.run();
    expect(b.submissionHashes.X).toMatch(/^[a-f0-9]{64}$/u);
    a.pY.sourceDocs[0]!.originalSha256 = "a".repeat(64);
    a.y.packetSha256 = sha(bytes(a.pY));
    expect(a.run).toThrow(/PACKET_SOURCE_INVALID/);
  });
});

describe("S2 packet reviewer scope equality", () => {
  it("rejects different frozen SOURCE revision, path and vault in Y despite same original text", () => {
    const a = cohort();
    a.pY.sourceDocs[0]!.revision40Hex = "e".repeat(40);
    a.y.packetSha256 = sha(bytes(a.pY));
    expect(a.run).toThrow(/REVIEW_SOURCE_DOCUMENT_DIFFERENCE/);
    const b = cohort();
    b.pY.sourceDocs[0]!.authorizedVaultScope = "wrong-vault";
    b.y.packetSha256 = sha(bytes(b.pY));
    expect(b.run).toThrow(/REVIEW_SOURCE_DOCUMENT_DIFFERENCE/);
  });
});
