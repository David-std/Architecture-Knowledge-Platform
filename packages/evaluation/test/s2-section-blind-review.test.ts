import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  auditSectionBlindReviews,
  type BlindReviewerSubmission,
} from "../src/s2-section-blind-review.js";

const sha = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const bytes = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
const documentId = "10000000-0000-4000-8000-000000000001";
const srcKey = sha(documentId);
const file = "---\r\ntitle: QA\r\n---\r\n# Review\r\nAn audit is required. 😀";
const frame = "---\r\ntitle: QA\r\n---\r\n".length;
const q1 = "Is an audit required?";
const q2 = "Does an audit require a helicopter?";
const key1 = sha("en\0" + q1),
  key2 = sha("en\0" + q2);
const quote = "An audit is required.";
const start = file.indexOf(quote);
function fixture() {
  const sourceManifest = {
    schemaVersion: "akp.s2.section-frozen-manifest.v1",
    files: [
      {
        vaultId: "v1",
        documentId,
        revision: "frozen-1",
        path: "test/a.md",
        fileSha256: sha(file),
        bodyStartUtf16: frame,
        bodyEndUtf16: file.length,
      },
    ],
  };
  const sourceManifestBytes = bytes(sourceManifest);
  const sourceManifestSha256 = sha(sourceManifestBytes);
  const caseManifest = {
    schemaVersion: "akp.s2.section-paired-manifest.v1",
    executedCommitSha: "a".repeat(40),
    sourceManifestSha256,
    cases: [
      {
        caseKeySha256: key1,
        scopeSha256: sha("scope"),
        sourceFamilySha256: sha("family"),
        language: "en",
      },
      {
        caseKeySha256: key2,
        scopeSha256: sha("scope"),
        sourceFamilySha256: sha("family"),
        language: "en",
      },
    ],
  };
  const caseManifestBytes = bytes(caseManifest);
  const caseManifestSha256 = sha(caseManifestBytes);
  const source = {
    documentKey: srcKey,
    upstreamRevision: "frozen-1",
    sourceSha256: sha(file),
    sourceBodyStartUtf16: frame,
    sourceBodyEndUtf16: file.length,
    sourceText: file,
  };
  const cases = [
    {
      questionKey: key1,
      language: "en",
      question: q1,
      answerability: null,
      answerText: null,
      quotes: [],
      note: null,
    },
    {
      questionKey: key2,
      language: "en",
      question: q2,
      answerability: null,
      answerText: null,
      quotes: [],
      note: null,
    },
  ];
  const packet = (reviewerAssignment: "A" | "B") => ({
    schemaVersion: "akp.s2.section-new-mdn-blind-dev-review.v1",
    status: "UNREVIEWED_DEV_ONLY_NOT_INDEPENDENT_HOLDOUT",
    reviewerAssignment,
    caseManifestSha256,
    sourceManifestSha256,
    instructions: "Review independent sources",
    allowedAnswerability: [
      "ANSWERABLE_EXPLICIT",
      "NOT_ANSWERABLE",
      "AMBIGUOUS",
      "CONTRADICTED",
    ],
    originalSources: [source],
    cases: reviewerAssignment === "A" ? cases : [...cases].reverse(),
    goldIncluded: false,
    writerOutputsIncluded: false,
    independentReviewEstablished: false,
    gateAccepted: false,
  });
  const packetABytes = bytes(packet("A")),
    packetBBytes = bytes(packet("B"));
  const receipt = {
    schemaVersion: "akp.s2.section-dev-reviewer-packet-receipt.v1",
    casePin: caseManifestSha256,
    sourcePin: sourceManifestSha256,
    receipts: [
      {
        reviewer: "A",
        filename: "a.json",
        packetSha256: sha(packetABytes),
        cases: 2,
        sources: 1,
      },
      {
        reviewer: "B",
        filename: "b.json",
        packetSha256: sha(packetBBytes),
        cases: 2,
        sources: 1,
      },
    ],
    reviewerSubmissionsReceived: 0,
    independentReviewEstablished: false,
    gateAccepted: false,
  };
  const input = {
    receiptBytes: bytes(receipt),
    packetABytes,
    packetBBytes,
    sourceManifestBytes,
    sourceManifestSha256,
    caseManifestBytes,
    caseManifestSha256,
    sourceFiles: [{ documentId, bytes: new TextEncoder().encode(file) }],
  };
  const answer = (questionKey: string, positive: boolean) => ({
    questionKey,
    answerability: positive ? "ANSWERABLE_EXPLICIT" : "NOT_ANSWERABLE",
    answerText: positive ? "An audit is required." : "",
    quotes: positive
      ? [
          {
            documentKey: srcKey,
            startUtf16: start,
            endUtf16: start + quote.length,
            quote,
          },
        ]
      : [],
    note: null,
  });
  const subA: BlindReviewerSubmission = {
    schemaVersion: "akp.s2.section-blind-review-submission.v1",
    reviewerAssignment: "A",
    packetSha256: sha(packetABytes),
    cases: [
      answer(key1, true),
      answer(key2, false),
    ] as BlindReviewerSubmission["cases"],
  };
  const subB: BlindReviewerSubmission = {
    schemaVersion: "akp.s2.section-blind-review-submission.v1",
    reviewerAssignment: "B",
    packetSha256: sha(packetBBytes),
    cases: [
      answer(key2, false),
      answer(key1, true),
    ] as BlindReviewerSubmission["cases"],
  };
  return { input, subA, subB, receipt, packet, caseManifest, sourceManifest };
}
describe("SECTION blind-review original source and receipt auditor", () => {
  it("verifies immutable packets but never pretends submissions exist", () => {
    const { input } = fixture();
    const r = auditSectionBlindReviews(input);
    expect(r).toMatchObject({
      status: "UNREVIEWED_PACKETS_VERIFIED",
      caseCount: 2,
      sourceCount: 1,
      reviewerSubmissionsReceived: 0,
      reviewerIndependenceAuthenticated: false,
      originalCustodyIndependentlyAttested: false,
      gateAccepted: false,
      writerAnswerCorrectness: null,
      falseAdmissionRate: null,
    });
    expect(JSON.stringify(r)).not.toContain(quote);
    expect(JSON.stringify(r)).not.toContain(documentId);
  });
  it("checks two complete citations and aggregates without claiming semantic proof", () => {
    const { input, subA, subB } = fixture();
    const r = auditSectionBlindReviews({
      ...input,
      submissionA: subA,
      submissionB: subB,
    });
    expect(r).toMatchObject({
      status: "TWO_SUBMISSIONS_STRUCTURALLY_VERIFIED",
      reviewerSubmissionsReceived: 2,
      classificationAgreementCount: 2,
      classificationDisagreementCount: 0,
      originalFileQuotesMatched: 2,
      reviewerJudgmentsSemanticallyVerified: false,
      reviewerConsensusAdjudicated: false,
      gateAccepted: false,
    });
  });
  it("detects classification disagreement without manufacturing consensus", () => {
    const { input, subA, subB } = fixture();
    subB.cases[0]!.answerability = "AMBIGUOUS";
    const r = auditSectionBlindReviews({
      ...input,
      submissionA: subA,
      submissionB: subB,
    });
    expect(r.classificationDisagreementCount).toBe(1);
    expect(r.reviewerConsensusAdjudicated).toBe(false);
  });
  it("requires two reviewers or none", () => {
    const { input, subA } = fixture();
    expect(() =>
      auditSectionBlindReviews({ ...input, submissionA: subA }),
    ).toThrow("REVIEWER_SUBMISSIONS_INCOMPLETE");
  });
  it("rejects mutated original packets against immutable receipt", () => {
    const { input } = fixture();
    const packet = JSON.parse(new TextDecoder().decode(input.packetABytes));
    packet.cases[0].question = "What changed?";
    expect(() =>
      auditSectionBlindReviews({ ...input, packetABytes: bytes(packet) }),
    ).toThrow("PACKET_RECEIPT_MISMATCH");
  });
  it("rejects tampered source and altered case manifest despite self consistency", () => {
    const { input } = fixture();
    expect(() =>
      auditSectionBlindReviews({
        ...input,
        sourceFiles: [
          { documentId, bytes: new TextEncoder().encode(file + " changed") },
        ],
      }),
    ).toThrow("SOURCE_FILE_HASH_OR_SCOPE_MISMATCH");
    expect(() =>
      auditSectionBlindReviews({ ...input, caseManifestSha256: sha("wrong") }),
    ).toThrow("RECEIPT_INCONSISTENT");
  });
  it("rejects source ID switches and source framing changes", () => {
    const { input } = fixture();
    expect(() =>
      auditSectionBlindReviews({
        ...input,
        sourceFiles: [
          {
            documentId: "foreign-document",
            bytes: new TextEncoder().encode(file),
          },
        ],
      }),
    ).toThrow("SOURCE_FILE_HASH_OR_SCOPE_MISMATCH");
  });
  it("rejects fabricated quotes, unsupported document or out-of-range offsets", () => {
    const { input, subA, subB } = fixture();
    const tests = [
      { quote: "A lie." },
      { documentKey: sha("wrong") },
      { startUtf16: 0 },
      { endUtf16: file.length + 1 },
    ];
    for (const item of tests) {
      const fake = structuredClone(subA);
      Object.assign(fake.cases[0]!.quotes[0]!, item);
      expect(() =>
        auditSectionBlindReviews({
          ...input,
          submissionA: fake,
          submissionB: subB,
        }),
      ).toThrow();
    }
  });
  it("rejects UTF-16 surrogate splits", () => {
    const { input, subA, subB } = fixture();
    const fake = structuredClone(subA);
    const pos = file.indexOf("😀");
    fake.cases[0]!.quotes[0] = {
      documentKey: srcKey,
      startUtf16: pos + 1,
      endUtf16: pos + 2,
      quote: "\ude00",
    };
    expect(() =>
      auditSectionBlindReviews({
        ...input,
        submissionA: fake,
        submissionB: subB,
      }),
    ).toThrow("CITATION_NOT_EXACT_ORIGINAL_UTF16");
  });
  it("refuses positive labels with no citation or answer", () => {
    const { input, subA, subB } = fixture();
    subA.cases[0]!.quotes = [];
    expect(() =>
      auditSectionBlindReviews({
        ...input,
        submissionA: subA,
        submissionB: subB,
      }),
    ).toThrow("POSITIVE_WITHOUT_EXACT_EVIDENCE");
  });
  it("refuses negative labels that smuggle answer text", () => {
    const { input, subA, subB } = fixture();
    subA.cases[1]!.answerText = "Maybe";
    expect(() =>
      auditSectionBlindReviews({
        ...input,
        submissionA: subA,
        submissionB: subB,
      }),
    ).toThrow("NEGATIVE_MUST_ABSTAIN");
  });
  it("rejects missing and duplicate question judgments", () => {
    const { input, subA, subB } = fixture();
    subB.cases[1] = subB.cases[0]!;
    expect(() =>
      auditSectionBlindReviews({
        ...input,
        submissionA: subA,
        submissionB: subB,
      }),
    ).toThrow("SUBMISSION_CASE_INVALID");
  });
  it("rejects an invalid second reviewer packet digest", () => {
    const { input, subA, subB } = fixture();
    subB.packetSha256 = sha("wrong");
    expect(() =>
      auditSectionBlindReviews({
        ...input,
        submissionA: subA,
        submissionB: subB,
      }),
    ).toThrow("SUBMISSION_HEADER");
  });
  it("refuses label leakage into frozen packet even under a new receipt", () => {
    const { input } = fixture();
    const packet = JSON.parse(new TextDecoder().decode(input.packetABytes));
    packet.cases[0].answerability = "ANSWERABLE_EXPLICIT";
    const receipt = JSON.parse(new TextDecoder().decode(input.receiptBytes));
    const packetABytes = bytes(packet);
    receipt.receipts[0].packetSha256 = sha(packetABytes);
    expect(() =>
      auditSectionBlindReviews({
        ...input,
        receiptBytes: bytes(receipt),
        packetABytes,
      }),
    ).toThrow("PACKET_QUESTION_TAMPERED_OR_PRELABELED");
  });
});
