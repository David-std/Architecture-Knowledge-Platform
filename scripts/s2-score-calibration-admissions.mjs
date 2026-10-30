/**
 * Post-hoc calibration-only comparison of ACTUAL application admissions
 * against the external, provisionally reconciled 288-pair human reference.
 *
 * The reader run and the source-rebinding audit MUST be completed first.
 * This script does not call a reader or modify a deployment; never pass the
 * reference file to a reader-facing process or present its score as an
 * independent S2 gate.
 *
 * node scripts/s2-score-calibration-admissions.mjs \
 *   --observations reports/ci/s2-live-route-layered-observations.json \
 *   --rebound reports/ci/s2-live-route-layered-rebound-audit.json \
 *   --reference /authorized/handoff/S2_PR38_REFERENCIA_288.jsonl \
 *   --cases evals/registered/s2-source-span-holdout.json \
 *   --output reports/ci/s2-live-route-layered-calibration-join.json
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function arg(name) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(
      `S2_CALIBRATION_JOIN_MISSING_${name.slice(2).toUpperCase()}`,
    );
  }
  return path.resolve(value);
}

const sha = (value) => createHash("sha256").update(value).digest("hex");
const [observationBytes, reboundBytes, referenceBytes, caseBytes] =
  await Promise.all(
    ["--observations", "--rebound", "--reference", "--cases"].map((key) =>
      readFile(arg(key)),
    ),
  );
const observations = JSON.parse(observationBytes.toString("utf8"));
const rebound = JSON.parse(reboundBytes.toString("utf8"));
const fixture = JSON.parse(caseBytes.toString("utf8"));
const referenceLines = referenceBytes
  .toString("utf8")
  .split(/\r?\n/u)
  .filter(Boolean);
const reference = referenceLines.map((line) => JSON.parse(line));

function rejectUnless(condition, code) {
  if (!condition) throw new Error("S2_CALIBRATION_JOIN_" + code);
}

rejectUnless(
  observations.schemaVersion === "akp.s2.observed-admission-run.v1" &&
    rebound.schemaVersion === "akp.s2.rebound-admission-report.v1" &&
    observations.runId === rebound.runId &&
    observations.executedCommitSha === rebound.executedCommitSha &&
    rebound.observationFileSha256 === sha(observationBytes) &&
    rebound.sourceProvenanceExternallyVerified === false &&
    rebound.goldLabelsUsed === false &&
    rebound.gateAccepted === false,
  "INVALID_RUN_OR_PROVENANCE",
);
rejectUnless(
  observations.observations.length === 48 &&
    rebound.observations.length === 48 &&
    rebound.observationCount === 48 &&
    fixture.cases.length === 48 &&
    reference.length === 288,
  "INCOMPLETE_48_X_6_CORPUS",
);

const casesByKey = new Map();
for (const question of fixture.cases) {
  const key = sha(question.query);
  rejectUnless(
    !casesByKey.has(key) &&
      ["en", "es"].includes(question.language) &&
      typeof question.answerable === "boolean",
    "INVALID_OR_DUPLICATE_QUESTION",
  );
  casesByKey.set(key, question);
}
const referenceByPair = new Map();
const verdictDistribution = {};
for (const row of reference) {
  const key = `${row.questionKey}:${row.passageSha256}`;
  rejectUnless(
    sha(row.query) === row.questionKey &&
      sha(row.passage) === row.passageSha256 &&
      casesByKey.has(row.questionKey) &&
      !referenceByPair.has(key) &&
      [
        "ANSWERS",
        "CONTRADICTS",
        "RELATED_NOT_ANSWERING",
        "INSUFFICIENT",
      ].includes(row.provisionalVerdict),
    "REFERENCE_NOT_FROZEN_OR_DUPLICATED",
  );
  referenceByPair.set(key, row);
  verdictDistribution[row.provisionalVerdict] =
    (verdictDistribution[row.provisionalVerdict] ?? 0) + 1;
}
rejectUnless(
  verdictDistribution.ANSWERS === 24 &&
    (verdictDistribution.CONTRADICTS ?? 0) === 0 &&
    verdictDistribution.RELATED_NOT_ANSWERING === 33 &&
    verdictDistribution.INSUFFICIENT === 231,
  "REFERENCE_DISTRIBUTION_UNEXPECTED",
);

const emptyBucket = () => ({
  questions: 0,
  positiveQuestions: 0,
  negativeQuestions: 0,
  positiveQuestionsWithHumanAnswerAdmission: 0,
  negativeQuestionsWithAnyAdmission: 0,
  admittedPassages: 0,
  admittedHumanAnswers: 0,
  admittedNonAnswers: 0,
  admittedSourceReboundSpans: 0,
});
const byLanguage = Object.fromEntries(
  ["en", "es"].map((language) => [language, emptyBucket()]),
);
const bySource = Object.fromEntries(
  fixture.sourceDocuments.map((source) => [source.id, emptyBucket()]),
);
const rejectedAdmittedVerdicts = {};
const nonAnswerAdmissions = [];
let matchedCandidatePairs = 0;
let admittedSpanContainsHumanQuote = 0;
let admittedSpanOverlapsHumanQuote = 0;
let admittedAnswerSpansWithHumanQuote = 0;
for (const [index, observation] of observations.observations.entries()) {
  const question = casesByKey.get(observation.querySha256);
  const rebinding = rebound.observations[index];
  rejectUnless(
    question &&
      rebinding.querySha256 === observation.querySha256 &&
      rebinding.scopeSha256 === observation.scopeSha256 &&
      observation.candidates.length === 6 &&
      rebinding.results.length === observation.candidates.length,
    "OBSERVATION_REFERENCE_OR_REBIND_MISMATCH",
  );
  const language = byLanguage[question.language];
  const source = bySource[question.sourceId];
  rejectUnless(source, "SOURCE_STRATUM_NOT_FOUND");
  const buckets = [language, source];
  for (const bucket of buckets) {
    bucket.questions += 1;
    if (question.answerable) bucket.positiveQuestions += 1;
    else bucket.negativeQuestions += 1;
  }
  let humanAnswerAdmitted = false;
  let anyAdmitted = false;
  for (const [candidateIndex, candidate] of observation.candidates.entries()) {
    const pair = `${observation.querySha256}:${candidate.excerptSha256}`;
    const row = referenceByPair.get(pair);
    const sourceResult = rebinding.results[candidateIndex];
    rejectUnless(
      row && sourceResult.candidateKeySha256 === candidate.candidateKeySha256,
      "UNMAPPED_OR_WRONG_SOURCE_CANDIDATE",
    );
    matchedCandidatePairs += 1;
    if (!candidate.admittedByApplication) {
      rejectUnless(sourceResult.status === "NOT_ADMITTED", "SHADOW_ADMITTED");
      continue;
    }
    anyAdmitted = true;
    for (const bucket of buckets) bucket.admittedPassages += 1;
    if (row.provisionalVerdict === "ANSWERS") {
      for (const bucket of buckets) bucket.admittedHumanAnswers += 1;
      humanAnswerAdmitted = true;
    } else {
      for (const bucket of buckets) bucket.admittedNonAnswers += 1;
      rejectedAdmittedVerdicts[row.provisionalVerdict] =
        (rejectedAdmittedVerdicts[row.provisionalVerdict] ?? 0) + 1;
      nonAnswerAdmissions.push({
        caseId: question.id,
        sourceId: question.sourceId,
        language: question.language,
        provisionalVerdict: row.provisionalVerdict,
        candidateKeySha256: candidate.candidateKeySha256,
      });
    }
    if (sourceResult.status !== "SOURCE_SPAN_REBOUND") continue;
    for (const bucket of buckets) bucket.admittedSourceReboundSpans += 1;
    const span = sourceResult.sourceSpan;
    rejectUnless(span, "REBOUND_SPAN_MISSING");
    if (row.provisionalVerdict !== "ANSWERS") continue;
    const humanStart = Number(row.provisionalQuoteStartOffsetUtf16);
    const humanEnd = Number(row.provisionalQuoteEndOffsetUtf16);
    if (
      !Number.isSafeInteger(humanStart) ||
      !Number.isSafeInteger(humanEnd) ||
      humanStart < 0 ||
      humanEnd <= humanStart ||
      humanEnd > row.passage.length
    ) {
      continue;
    }
    admittedAnswerSpansWithHumanQuote += 1;
    if (
      span.startOffsetUtf16 <= humanStart &&
      span.endOffsetUtf16 >= humanEnd
    ) {
      admittedSpanContainsHumanQuote += 1;
    }
    if (span.startOffsetUtf16 < humanEnd && span.endOffsetUtf16 > humanStart) {
      admittedSpanOverlapsHumanQuote += 1;
    }
  }
  if (question.answerable && humanAnswerAdmitted) {
    for (const bucket of buckets)
      bucket.positiveQuestionsWithHumanAnswerAdmission += 1;
  }
  if (!question.answerable && anyAdmitted) {
    for (const bucket of buckets) bucket.negativeQuestionsWithAnyAdmission += 1;
  }
}
rejectUnless(
  matchedCandidatePairs === 288 &&
    referenceByPair.size === matchedCandidatePairs,
  "NOT_ALL_REFERENCE_PAIRS_MATCHED",
);

const total = Object.values(byLanguage).reduce(
  (result, language) => {
    for (const key of Object.keys(result)) result[key] += language[key] ?? 0;
    return result;
  },
  Object.fromEntries(Object.keys(byLanguage.en).map((key) => [key, 0])),
);
rejectUnless(
  total.questions === 48 &&
    total.admittedPassages === rebound.admittedCount &&
    total.admittedSourceReboundSpans === rebound.sourceReboundSpanCount,
  "REBOUND_AGGREGATION_MISMATCH",
);
const output = {
  schemaVersion: "akp.s2.calibration-only-admission-join.v1",
  status: "POST_HOC_CALIBRATION_AGREEMENT_NOT_INDEPENDENT_S2_ACCURACY",
  runId: observations.runId,
  executedCommitSha: observations.executedCommitSha,
  sourceReboundVerifiedBeforeLabelJoin: true,
  originalAdmissionSha256: sha(observationBytes),
  sourceRebindReportSha256: sha(reboundBytes),
  externalProvisionalReferenceSha256: sha(referenceBytes),
  publicSyntheticFixtureSha256: sha(caseBytes),
  referenceDistribution: verdictDistribution,
  matchedCandidatePairs,
  total,
  byLanguage,
  bySource,
  admittedNonAnswerVerdicts: rejectedAdmittedVerdicts,
  nonAnswerAdmissions,
  humanQuoteSpanAlignment: {
    admittedAnswerSpansWithHumanQuote,
    admittedSpanContainsHumanQuote,
    admittedSpanOverlapsHumanQuote,
    // Overlap is textual alignment, NOT an independent semantic verdict.
  },
  humanReviewerIndependenceVerified: false,
  validIndependentHoldout: false,
  finalAnswersMeasured: false,
  gateAccepted: false,
};
const target = arg("--output");
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(output, null, 2) + "\n", "utf8");
process.stdout.write(
  JSON.stringify({
    observations: total.questions,
    joinedCandidates: matchedCandidatePairs,
    admittedPassages: total.admittedPassages,
    admittedHumanAnswerLabel: total.admittedHumanAnswers,
    admittedNonAnswerLabel: total.admittedNonAnswers,
    gateAccepted: false,
  }) + "\n",
);
