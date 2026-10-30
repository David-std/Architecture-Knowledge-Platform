import { describe, it, expect } from "vitest";
import { summarizeDualAxisReviews } from "../src/s2-dual-axis.js";
const h = (id: string) => id.repeat(64).slice(0, 64);
const keys = [h("a"), h("b"), h("c"), h("d")];
const encode = (x: unknown) => new TextEncoder().encode(JSON.stringify(x));
const entry = (questionKey: string, answerability: string) => ({
  questionKey,
  answerability,
  answerText: "",
  quotes: [],
  note: null,
});
function fixture() {
  const labelsA = [
    "CONTRADICTED",
    "ANSWERABLE_EXPLICIT",
    "NOT_ANSWERABLE",
    "AMBIGUOUS",
  ];
  const labelsB = [
    "ANSWERABLE_EXPLICIT",
    "ANSWERABLE_EXPLICIT",
    "NOT_ANSWERABLE",
    "AMBIGUOUS",
  ];
  const maker = (reviewerAssignment: "A" | "B", labels: string[]) => ({
    schemaVersion: "akp.s2.section-blind-review-submission.v1",
    reviewerAssignment,
    packetSha256: h("1"),
    cases: keys.map((key, i) => entry(key, labels[i]!)),
  });
  return {
    submissionABytes: encode(maker("A", labelsA)),
    submissionBBytes: encode(maker("B", labelsB)),
    auditedQuestionKeys: keys,
    structuralAuditStatus: "TWO_SUBMISSIONS_STRUCTURALLY_VERIFIED" as const,
  };
}
describe("S2 two-axis reviewer labels remain provisional", () => {
  it("distinguishes refutation label disagreement from answerability agreement", () => {
    const result = summarizeDualAxisReviews(fixture());
    expect(result).toMatchObject({
      status: "PROVISIONAL_ANNOTATION_ONLY",
      caseCount: 4,
      exactFourWayAgreement: 3,
      evidenceDispositionAgreement: 4,
      resolvedExplicitlyDecidable: 2,
      resolvedNotSupported: 1,
      resolvedAmbiguous: 1,
      disputedEvidenceDisposition: 0,
      claimPolarityNeedsReview: 2,
      falseAdmissionRate: null,
      gateAccepted: false,
    });
    expect(result.cases[0]).toMatchObject({
      reviewerAOriginalVerdict: "CONTRADICTED",
      reviewerBOriginalVerdict: "ANSWERABLE_EXPLICIT",
      evidenceDisposition: "EXPLICITLY_DECIDABLE",
      claimPolarityReview: "MIXED_CONTRADICTED_AND_EXPLICIT",
      strictFourWayAgreement: false,
    });
    expect(result.cases[1]?.claimPolarityReview).toBe(
      "BOTH_MARKED_ANSWERABLE_EXPLICIT",
    );
    expect(result.semanticAnswersIndependentlyAdjudicated).toBe(false);
  });
  it("does not claim disposition agreement on ambiguous vs unsupported", () => {
    const x = fixture();
    const b = JSON.parse(new TextDecoder().decode(x.submissionBBytes));
    b.cases[3].answerability = "NOT_ANSWERABLE";
    x.submissionBBytes = encode(b);
    const r = summarizeDualAxisReviews(x);
    expect(r.disputedEvidenceDisposition).toBe(1);
    expect(r.evidenceDispositionAgreement).toBe(3);
    expect(r.cases[3]?.evidenceDisposition).toBe("DISPUTED");
  });
  it("fails closed if original structural audit has not succeeded", () => {
    const x = fixture();
    expect(() =>
      summarizeDualAxisReviews({
        ...x,
        structuralAuditStatus: "UNREVIEWED_PACKETS_VERIFIED" as never,
      }),
    ).toThrow("PRECONDITION_NOT_VERIFIED");
  });
  it("rejects foreign and missing case ids", () => {
    const x = fixture();
    expect(() =>
      summarizeDualAxisReviews({
        ...x,
        auditedQuestionKeys: [...keys.slice(1), h("e")],
      }),
    ).toThrow("CASE_SCOPE_MISMATCH");
    expect(() =>
      summarizeDualAxisReviews({
        ...x,
        auditedQuestionKeys: [...keys, keys[0]!],
      }),
    ).toThrow("CASE_SCOPE_MISMATCH");
  });
  it("rejects duplicate, unsupported and tampered labels", () => {
    const x = fixture();
    const b = JSON.parse(new TextDecoder().decode(x.submissionBBytes));
    b.cases[1].questionKey = b.cases[0].questionKey;
    expect(() =>
      summarizeDualAxisReviews({ ...x, submissionBBytes: encode(b) }),
    ).toThrow("INVALID_CASE");
    b.cases[1].questionKey = keys[1];
    b.cases[1].answerability = "TRUE";
    expect(() =>
      summarizeDualAxisReviews({ ...x, submissionBBytes: encode(b) }),
    ).toThrow("INVALID_CASE");
  });
  it("never infers affirmed polarity from ANSWERABLE_EXPLICIT alone", () => {
    const x = fixture();
    const r = summarizeDualAxisReviews(x);
    expect(r.cases[1]?.claimPolarityReview).not.toBe(
      "BOTH_MARKED_CONTRADICTED",
    );
    expect(
      r.cases.every((row) => !JSON.stringify(row).includes("AFFIRMED")),
    ).toBe(true);
  });
});
