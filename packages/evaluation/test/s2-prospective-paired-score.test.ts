import { describe, expect, it } from "vitest";
import {
  scoreS2PairedSemanticArms,
  type S2PairedAdjudicatedCase,
} from "../src/s2-prospective-paired-score.js";
const outcome = (citation: boolean, correct: boolean, negative: boolean) => {
  return {
    authorizedPoolSha256: "b".repeat(64),
    executedCommitSha: "c".repeat(40),
    modelResidency: "WARM" as const,
    admittedPassages: citation
      ? [{ id: "SEC1", sourceExact: correct, semanticallySufficient: correct }]
      : [],
    finalAnswer: negative
      ? citation
        ? "INCORRECT"
        : "JUSTIFIED_ABSTENTION"
      : correct
        ? "CORRECT"
        : "UNNECESSARY_ABSTENTION",
    httpMs: 1000,
    providerDegraded: false,
    promptTokens: 42,
    completionTokens: 17,
    revokedOrUnauthorizedEvidence: false,
  } as const;
};
const example = (): S2PairedAdjudicatedCase[] => [
  {
    caseId: "positive-en-001",
    language: "en",
    publisherFamily: "sourcemark-one",
    sourceGold: "ANSWERABLE_EXPLICIT",
    outcomes: {
      DETERMINISTIC: outcome(true, true, false),
      CANDIDATE: outcome(true, true, false),
    },
  },
  {
    caseId: "negative-en-001",
    language: "en",
    publisherFamily: "sourcemark-one",
    sourceGold: "NOT_ANSWERABLE",
    outcomes: {
      DETERMINISTIC: outcome(false, true, true),
      CANDIDATE: outcome(true, false, true),
    },
  },
  {
    caseId: "positive-es-001",
    language: "es",
    publisherFamily: "sourcemark-two",
    sourceGold: "ANSWERABLE_EXPLICIT",
    outcomes: {
      DETERMINISTIC: outcome(false, false, false),
      CANDIDATE: outcome(true, true, false),
    },
  },
  {
    caseId: "negative-es-001",
    language: "es",
    publisherFamily: "sourcemark-two",
    sourceGold: "NOT_ANSWERABLE",
    outcomes: {
      DETERMINISTIC: outcome(false, true, true),
      CANDIDATE: outcome(false, true, true),
    },
  },
];
describe("S2 paired semantic outcomes are diagnostic, not independent release gold", () => {
  it("correctly separates evidence precision, FAR, abstentions, full latency, paired correctness", () => {
    const score = scoreS2PairedSemanticArms(example());
    expect(score).toMatchObject({
      status: "DESCRIPTIVE_PAIRED_METRICS_NOT_INDEPENDENT_GATE",
      caseCount: 4,
      familyCount: 2,
      candidateNotWorseOnNegativeFAR: false,
      candidateNotWorseOnCorrectOrJustifiedAnswers: true,
      independentlyAuthenticatedReviewers: false,
      stratifiedConfidenceIntervalCertified: false,
      releaseGateAccepted: false,
    });
    expect(score.baseline.negativeFalseAdmissionRate).toBe(0);
    expect(score.candidate.negativeFalseAdmissionRate).toBe(0.5);
    expect(score.candidate.evidencePrecision).toBeCloseTo(2 / 3);
    expect(score.candidate.evidencePrecisionWilson95Lower).toBeLessThan(0.7);
    expect(score.baseline.unnecessaryAbstentions).toBe(1);
    expect(score.candidate.unnecessaryAbstentions).toBe(0);
    expect(score.candidate.fullHttpP95Ms).toBe(1000);
    expect(score.byLanguage.en?.candidate.negativeFalseAdmissionRate).toBe(1);
    expect(score.byLanguage.es?.candidate.negativeFalseAdmissionRate).toBe(0);
    expect(score.leaveOneFamilyOutSensitivity).toHaveLength(2);
  });
  it("never calls zero false admission 'certified zero risk'", () => {
    const onlyNegative = example().filter(
      (c) => c.sourceGold === "NOT_ANSWERABLE",
    );
    for (const c of onlyNegative)
      c.outcomes.CANDIDATE = outcome(false, true, true);
    const result = scoreS2PairedSemanticArms(onlyNegative);
    expect(result.candidate.negativeFalseAdmissionRate).toBe(0);
    expect(result.releaseGateAccepted).toBe(false);
  });
  it("refuses ambiguous labels, repeated cases, fabricated citation or missing tokens", () => {
    const invalid = example();
    invalid[1]!.outcomes.CANDIDATE.admittedPassages[0]!.id = "";
    expect(() => scoreS2PairedSemanticArms(invalid)).toThrow(
      /CITATION_JUDGMENT_INVALID/,
    );
    const duplicated = example();
    duplicated[1]!.caseId = duplicated[0]!.caseId;
    expect(() => scoreS2PairedSemanticArms(duplicated)).toThrow(
      /CASE_SCOPE_INVALID/,
    );
    const mislabeled = example();
    mislabeled[1]!.sourceGold = "UNDETERMINED" as never;
    expect(() => scoreS2PairedSemanticArms(mislabeled)).toThrow(
      /CASE_SCOPE_INVALID/,
    );
  });
  it("blocks deceptively paired arms using different SOURCE pools, runtime revisions or cold/warm conditions", () => {
    const x = example();
    x[1]!.outcomes.CANDIDATE.authorizedPoolSha256 = "d".repeat(64);
    expect(() => scoreS2PairedSemanticArms(x)).toThrow(
      /ARMS_NOT_SOURCE_OR_RUNTIME_PAIRED/,
    );
    const y = example();
    y[0]!.outcomes.CANDIDATE.modelResidency = "COLD";
    expect(() => scoreS2PairedSemanticArms(y)).toThrow(
      /ARMS_NOT_SOURCE_OR_RUNTIME_PAIRED/,
    );
  });
  it("rejects logically contradictory gold and source-claim labels", () => {
    const a = example();
    a[1]!.outcomes.CANDIDATE.admittedPassages[0]!.semanticallySufficient = true;
    expect(() => scoreS2PairedSemanticArms(a)).toThrow(
      /NEGATIVE_HAS_IMPOSSIBLE_SUFFICIENT_SUPPORT/,
    );
    const b = example();
    b[3]!.outcomes.CANDIDATE.finalAnswer = "CORRECT";
    expect(() => scoreS2PairedSemanticArms(b)).toThrow(
      /NEGATIVE_CANNOT_HAVE_CORRECT_ASSERTED_ANSWER/,
    );
  });
  it("rejects invalid answerability and unknown degraded conditions", () => {
    const x = example();
    x[0]!.outcomes.CANDIDATE.finalAnswer = "JUSTIFIED_ABSTENTION" as never;
    expect(() => scoreS2PairedSemanticArms(x)).toThrow(
      /ARM_OBSERVATION_INVALID/,
    );
    const z = example();
    z[2]!.outcomes.CANDIDATE.providerDegraded = "no" as never;
    expect(() => scoreS2PairedSemanticArms(z)).toThrow(
      /ARM_OBSERVATION_INVALID/,
    );
  });
});

describe("S2 family-stratified paired bootstrap cannot manufacture release confidence", () => {
  it("reports same-family paired regression with bounded reproducible intervals", () => {
    const cases: S2PairedAdjudicatedCase[] = [];
    for (let i = 0; i < 12; i++)
      for (const c of example()) {
        cases.push({
          ...c,
          caseId: c.caseId + "-family" + i,
          publisherFamily: "sourcefamily-" + String(i).padStart(2, "0"),
        });
      }
    const x = scoreS2PairedSemanticArms(cases);
    const b = x.exploratoryClusterBootstrap;
    if (b.status !== "EXPLORATORY_STRATIFIED_CLUSTER_BOOTSTRAP_NOT_CERTIFIED")
      throw Error("BOOTSTRAP_UNEXPECTEDLY_UNAVAILABLE");
    expect(b.sourceFamilyCount).toBe(12);
    expect(b.clusterConfidenceIntervalCertified).toBe(false);
    expect(b.releaseGateAccepted).toBe(false);
    expect(
      b.rateIntervals.negativeFar.candidateMinusDeterministic.lower95,
    ).toBeGreaterThan(0);
    expect(
      scoreS2PairedSemanticArms(cases).exploratoryClusterBootstrap,
    ).toEqual(b);
  });
  it("refuses to interpret four author-tuned families as a source cluster confidence interval", () => {
    const x = scoreS2PairedSemanticArms(example());
    expect(x.exploratoryClusterBootstrap.status).toBe(
      "INSUFFICIENT_FAMILY_CLUSTERS",
    );
    expect(x.releaseGateAccepted).toBe(false);
  });
});
