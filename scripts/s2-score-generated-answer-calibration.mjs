/**
 * Offline-only, after fixed generation: compare model-declared answer/abstain
 * statuses to exposed AUTHOR-CRAFTED question strata. Does NOT evaluate
 * answer correctness, semantic citation sufficiency, or independent S2 gates.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

function flag(name) {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value || value.startsWith("--"))
    throw new Error(`S2_SCORE_MISSING_${name.slice(2).toUpperCase()}`);
  return path.resolve(value);
}
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const [generationBytes, fixtureBytes] = await Promise.all([
  readFile(flag("--generated-report")),
  readFile(flag("--frozen-fixture")),
]);
const outputFile = flag("--output");
const generated = JSON.parse(generationBytes.toString("utf8"));
const fixture = JSON.parse(fixtureBytes.toString("utf8"));
const gitBlob = createHash("sha1")
  .update(`blob ${fixtureBytes.length}\0`)
  .update(fixtureBytes)
  .digest("hex");
if (
  generated.schemaVersion !== "akp.s2.synthetic-paired-answer-generation.v1" ||
  generated.sourceGitBlobSha1 !== gitBlob ||
  generated.selectedWithoutGoldLabels !== true ||
  generated.independentHoldout !== false ||
  generated.gateAccepted !== false ||
  generated.casesRun !== fixture.cases.length ||
  !Array.isArray(generated.rows) ||
  generated.rows.length !== fixture.cases.length ||
  new Set(generated.rows.map((row) => row.caseId)).size !== fixture.cases.length
) {
  throw new Error("S2_SCORE_GENERATION_OR_FIXTURE_PROVENANCE_INVALID");
}
const caseById = new Map(fixture.cases.map((item) => [item.id, item]));
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    mean:
      sorted.length > 0
        ? sorted.reduce((total, current) => total + current, 0) / sorted.length
        : null,
    p95: sorted.length > 0 ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
  };
}
const rows = generated.rows.map((row) => {
  const sourceCase = caseById.get(row.caseId);
  if (
    !sourceCase ||
    row.language !== sourceCase.language ||
    row.querySha256 !== sha256(sourceCase.query) ||
    !Array.isArray(row.outputs) ||
    row.outputs.length !== 2 ||
    new Set(row.outputs.map((output) => output.arm)).size !== 2 ||
    !row.outputs.some((output) => output.arm === "FULL_POOL") ||
    !row.outputs.some((output) => output.arm === "ADMITTED_SPANS") ||
    row.outputs.some(
      (output) =>
        !["ANSWER", "ABSTAIN", "INVALID_JSON_OR_SCHEMA"].includes(
          output.status,
        ) ||
        !Number.isSafeInteger(output.promptTokens) ||
        output.promptTokens <= 0 ||
        !Number.isSafeInteger(output.completionTokens) ||
        output.completionTokens <= 0 ||
        !Number.isFinite(output.elapsedMs) ||
        output.elapsedMs < 0 ||
        typeof output.validCitations !== "boolean" ||
        typeof output.outputShapeValid !== "boolean",
    )
  ) {
    throw new Error("S2_SCORE_CASE_IDENTITY_INVALID");
  }
  const byArm = Object.fromEntries(
    row.outputs.map((output) => [
      output.arm,
      {
        status: output.status,
        promptTokens: output.promptTokens,
        completionTokens: output.completionTokens,
        generationMs: output.elapsedMs,
        modelDeclaredAnswer: output.status === "ANSWER",
        modelDeclaredAbstain: output.status === "ABSTAIN",
        citationsSourceIdsValid: output.validCitations === true,
        shapeValid: output.outputShapeValid === true,
      },
    ]),
  );
  return {
    caseId: row.caseId,
    language: sourceCase.language,
    sourceId: sourceCase.sourceId,
    authorQuestionAnswerable: sourceCase.answerable,
    byArm,
  };
});
if (
  rows.filter((row) => row.authorQuestionAnswerable).length !== 24 ||
  rows.filter((row) => !row.authorQuestionAnswerable).length !== 24
) {
  throw new Error("S2_SCORE_EXPOSED_AUTHOR_STRATA_CHANGED");
}
const resultByArm = Object.fromEntries(
  ["FULL_POOL", "ADMITTED_SPANS"].map((arm) => {
    const metrics = (subset) => ({
      cases: subset.length,
      modelDeclaredAnswers: subset.filter(
        (row) => row.byArm[arm].modelDeclaredAnswer,
      ).length,
      modelDeclaredAbstentions: subset.filter(
        (row) => row.byArm[arm].modelDeclaredAbstain,
      ).length,
      invalidModelOutput: subset.filter((row) => !row.byArm[arm].shapeValid)
        .length,
      invalidSourceIdCitations: subset.filter(
        (row) => !row.byArm[arm].citationsSourceIdsValid,
      ).length,
      promptTokens: distribution(
        subset.map((row) => row.byArm[arm].promptTokens),
      ),
      completionTokens: distribution(
        subset.map((row) => row.byArm[arm].completionTokens),
      ),
      generationMs: distribution(
        subset.map((row) => row.byArm[arm].generationMs),
      ),
    });
    return [
      arm,
      {
        positives: metrics(rows.filter((row) => row.authorQuestionAnswerable)),
        negatives: metrics(rows.filter((row) => !row.authorQuestionAnswerable)),
        languages: Object.fromEntries(
          ["en", "es"].map((language) => [
            language,
            {
              positives: metrics(
                rows.filter(
                  (row) =>
                    row.language === language && row.authorQuestionAnswerable,
                ),
              ),
              negatives: metrics(
                rows.filter(
                  (row) =>
                    row.language === language && !row.authorQuestionAnswerable,
                ),
              ),
            },
          ]),
        ),
        sourceClusters: Object.fromEntries(
          [...new Set(rows.map((row) => row.sourceId))].sort().map((id) => [
            id,
            {
              positives: metrics(
                rows.filter(
                  (row) => row.sourceId === id && row.authorQuestionAnswerable,
                ),
              ),
              negatives: metrics(
                rows.filter(
                  (row) => row.sourceId === id && !row.authorQuestionAnswerable,
                ),
              ),
            },
          ]),
        ),
      },
    ];
  }),
);
const report = {
  schemaVersion: "akp.s2.synthetic-generated-answer-calibration-join.v1",
  generationSha256: sha256(generationBytes),
  frozenSourceGitBlobSha1: gitBlob,
  exposedCalibrationQuestionLabelsReadOnlyAfterGeneration: true,
  questionGoldNeverSentToGenerator: true,
  answerCorrectnessMeasured: false,
  semanticCitationSufficiencyMeasured: false,
  reviewerIndependenceVerified: false,
  independentHoldout: false,
  gateAccepted: false,
  interpretation:
    "Only compares unadjudicated model-declared JSON ANSWER/ABSTAIN to exposed author-created question strata after paired local generation. ANSWER emission is not a semantically correct answer; abstention is not verified task success. Neither arm is a production AKP final-answer endpoint.",
  byArm: resultByArm,
};
await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n", {
  flag: "wx",
});
process.stdout.write(
  JSON.stringify({ outputFile, byArm: resultByArm, gateAccepted: false }) +
    "\n",
);
