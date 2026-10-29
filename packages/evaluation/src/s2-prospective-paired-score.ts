import { s2WilsonLower } from "./s2-source-span.js";
const fail = (x: string): never => {
  throw Error("S2_PAIRED_SCORE_" + x);
};
export type S2PairedAdjudicatedCase = {
  caseId: string;
  language: "en" | "es";
  publisherFamily: string;
  sourceGold: "ANSWERABLE_EXPLICIT" | "NOT_ANSWERABLE";
  /** External/prospective reviewer authority is checked out-of-band, NOT here. */
  outcomes: {
    DETERMINISTIC: S2EvaluatedArm;
    CANDIDATE: S2EvaluatedArm;
  };
};
export type S2EvaluatedArm = {
  /** Same immutable authorized candidate pool and code revision in BOTH arms. */
  authorizedPoolSha256: string;
  executedCommitSha: string;
  modelResidency: "COLD" | "WARM";
  admittedPassages: {
    id: string;
    sourceExact: boolean;
    semanticallySufficient: boolean;
  }[];
  /** Full final answer independently judged against original source. */
  finalAnswer:
    "CORRECT" | "INCORRECT" | "JUSTIFIED_ABSTENTION" | "UNNECESSARY_ABSTENTION";
  httpMs: number;
  providerDegraded: boolean;
  promptTokens: number | null;
  completionTokens: number | null;
  revokedOrUnauthorizedEvidence: boolean;
};
const rate = (n: number, d: number) => (d > 0 ? n / d : null);
const p95 = (v: number[]) =>
  v.length
    ? [...v].sort((a, b) => a - b)[Math.ceil(v.length * 0.95) - 1]!
    : null;
const summarize = (
  cases: readonly S2PairedAdjudicatedCase[],
  arm: "DETERMINISTIC" | "CANDIDATE",
) => {
  let admits = 0,
    supported = 0,
    incorrectClaims = 0,
    falseAdmissions = 0,
    negative = 0,
    correct = 0,
    unnecessary = 0,
    degraded = 0,
    unauthorized = 0;
  const durations: number[] = [];
  let prompt = 0,
    completion = 0,
    tokenCount = 0;
  for (const c of cases) {
    const x = c.outcomes[arm];
    durations.push(x.httpMs);
    degraded += Number(x.providerDegraded);
    unauthorized += Number(x.revokedOrUnauthorizedEvidence);
    correct += Number(
      (c.sourceGold === "ANSWERABLE_EXPLICIT" && x.finalAnswer === "CORRECT") ||
        (c.sourceGold === "NOT_ANSWERABLE" &&
          x.finalAnswer === "JUSTIFIED_ABSTENTION"),
    );
    unnecessary += Number(x.finalAnswer === "UNNECESSARY_ABSTENTION");
    if (c.sourceGold === "NOT_ANSWERABLE") {
      negative++;
      if (x.admittedPassages.length) falseAdmissions++;
    }
    admits += x.admittedPassages.length;
    supported += x.admittedPassages.filter(
      (p) => p.sourceExact && p.semanticallySufficient,
    ).length;
    incorrectClaims += x.admittedPassages.filter(
      (p) => !p.sourceExact || !p.semanticallySufficient,
    ).length;
    if (x.promptTokens !== null && x.completionTokens !== null) {
      prompt += x.promptTokens;
      completion += x.completionTokens;
      tokenCount++;
    }
  }
  return {
    questions: cases.length,
    negativeQuestions: negative,
    admittedPassages: admits,
    supportedSourceExactPassages: supported,
    unsupportedOrNonexactPassages: incorrectClaims,
    evidencePrecision: rate(supported, admits),
    evidencePrecisionWilson95Lower: s2WilsonLower(supported, admits),
    negativeFalseAdmissionQuestions: falseAdmissions,
    negativeFalseAdmissionRate: rate(falseAdmissions, negative),
    fullyCorrectOrJustifiedAnswers: correct,
    correctOrJustifiedRate: rate(correct, cases.length),
    unnecessaryAbstentions: unnecessary,
    degradedCalls: degraded,
    degradedCallRate: rate(degraded, cases.length),
    unauthorizedEvidenceCases: unauthorized,
    fullHttpP95Ms: p95(durations),
    actualModelTokenCoverage: tokenCount,
    promptTokensObserved: prompt,
    completionTokensObserved: completion,
  };
};
export function scoreS2PairedSemanticArms(
  cases: readonly S2PairedAdjudicatedCase[],
) {
  if (!cases.length || cases.length > 10000) fail("INVALID_COHORT_SIZE");
  const ids = new Set<string>(),
    families = new Set<string>();
  for (const c of cases) {
    if (
      !/^[a-zA-Z0-9._:-]{6,128}$/u.test(c.caseId) ||
      ids.has(c.caseId) ||
      !["en", "es"].includes(c.language) ||
      !/^[a-z0-9][a-z0-9.-]{1,70}$/u.test(c.publisherFamily) ||
      !["ANSWERABLE_EXPLICIT", "NOT_ANSWERABLE"].includes(c.sourceGold) ||
      !c.outcomes ||
      !c.outcomes.CANDIDATE ||
      !c.outcomes.DETERMINISTIC
    )
      fail("CASE_SCOPE_INVALID");
    if (
      c.outcomes.DETERMINISTIC.authorizedPoolSha256 !==
        c.outcomes.CANDIDATE.authorizedPoolSha256 ||
      c.outcomes.DETERMINISTIC.executedCommitSha !==
        c.outcomes.CANDIDATE.executedCommitSha ||
      c.outcomes.DETERMINISTIC.modelResidency !==
        c.outcomes.CANDIDATE.modelResidency
    )
      fail("ARMS_NOT_SOURCE_OR_RUNTIME_PAIRED");
    ids.add(c.caseId);
    families.add(c.publisherFamily);
    for (const a of ["CANDIDATE", "DETERMINISTIC"] as const) {
      const x = c.outcomes[a];
      if (
        !/^[a-f0-9]{64}$/u.test(x.authorizedPoolSha256) ||
        !/^[a-f0-9]{40}$/u.test(x.executedCommitSha) ||
        !["COLD", "WARM"].includes(x.modelResidency)
      )
        fail("ARM_EXECUTION_PIN_INVALID");
      if (c.sourceGold === "NOT_ANSWERABLE" && x.finalAnswer === "CORRECT")
        fail("NEGATIVE_CANNOT_HAVE_CORRECT_ASSERTED_ANSWER");
      if (
        !x ||
        !Array.isArray(x.admittedPassages) ||
        x.admittedPassages.length > 64 ||
        ![
          "CORRECT",
          "INCORRECT",
          "JUSTIFIED_ABSTENTION",
          "UNNECESSARY_ABSTENTION",
        ].includes(x.finalAnswer) ||
        (x.finalAnswer === "JUSTIFIED_ABSTENTION" &&
          c.sourceGold !== "NOT_ANSWERABLE") ||
        (x.finalAnswer === "UNNECESSARY_ABSTENTION" &&
          c.sourceGold !== "ANSWERABLE_EXPLICIT") ||
        !Number.isFinite(x.httpMs) ||
        x.httpMs < 0 ||
        x.httpMs > 600000 ||
        typeof x.providerDegraded !== "boolean" ||
        typeof x.revokedOrUnauthorizedEvidence !== "boolean" ||
        (x.promptTokens !== null &&
          (!Number.isSafeInteger(x.promptTokens) || x.promptTokens < 0)) ||
        (x.completionTokens !== null &&
          (!Number.isSafeInteger(x.completionTokens) ||
            x.completionTokens < 0)) ||
        (x.promptTokens === null) !== (x.completionTokens === null)
      )
        fail("ARM_OBSERVATION_INVALID");
      const citations = new Set<string>();
      for (const p of x.admittedPassages) {
        if (
          !p ||
          typeof p.id !== "string" ||
          !p.id ||
          p.id.length > 256 ||
          citations.has(p.id) ||
          typeof p.sourceExact !== "boolean" ||
          typeof p.semanticallySufficient !== "boolean"
        )
          fail("CITATION_JUDGMENT_INVALID");
        citations.add(p.id);
        if (c.sourceGold === "NOT_ANSWERABLE" && p.semanticallySufficient)
          fail("NEGATIVE_HAS_IMPOSSIBLE_SUFFICIENT_SUPPORT");
      }
    }
  }
  const baseline = summarize(cases, "DETERMINISTIC");
  const candidate = summarize(cases, "CANDIDATE");
  const byLanguage = Object.fromEntries(
    ["en", "es"].map((lang) => [
      lang,
      {
        baseline: summarize(
          cases.filter((c) => c.language === lang),
          "DETERMINISTIC",
        ),
        candidate: summarize(
          cases.filter((c) => c.language === lang),
          "CANDIDATE",
        ),
      },
    ]),
  );
  const byFamily = [...families].sort().map((f) => ({
    family: f,
    baseline: summarize(
      cases.filter((c) => c.publisherFamily === f),
      "DETERMINISTIC",
    ),
    candidate: summarize(
      cases.filter((c) => c.publisherFamily === f),
      "CANDIDATE",
    ),
  }));
  const leaveOneFamilyOut = [...families].sort().map((f) => {
    const selected = cases.filter((c) => c.publisherFamily !== f);
    return {
      excludedFamily: f,
      baseline: summarize(selected, "DETERMINISTIC"),
      candidate: summarize(selected, "CANDIDATE"),
    };
  });
  return {
    schemaVersion: "akp.s2.paired-semantic-metrics.v1" as const,
    status: "DESCRIPTIVE_PAIRED_METRICS_NOT_INDEPENDENT_GATE" as const,
    caseCount: cases.length,
    familyCount: families.size,
    baseline,
    candidate,
    byLanguage,
    byFamily,
    leaveOneFamilyOutSensitivity: leaveOneFamilyOut,
    candidateNotWorseOnNegativeFAR:
      candidate.negativeFalseAdmissionRate !== null &&
      baseline.negativeFalseAdmissionRate !== null &&
      candidate.negativeFalseAdmissionRate <=
        baseline.negativeFalseAdmissionRate,
    candidateNotWorseOnCorrectOrJustifiedAnswers:
      candidate.fullyCorrectOrJustifiedAnswers >=
      baseline.fullyCorrectOrJustifiedAnswers,
    /** The standalone score cannot independently authenticate real-world gold. */
    independentlyAuthenticatedReviewers: false as const,
    stratifiedConfidenceIntervalCertified: false as const,
    pairedManualObsidianBenchmarked: false as const,
    sourceReleasePermissionVerified: false as const,
    releaseGateAccepted: false as const,
  };
}
