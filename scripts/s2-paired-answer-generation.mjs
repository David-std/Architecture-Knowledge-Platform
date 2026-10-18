/**
 * Opt-in S2 continuation experiment on already captured, source-bound reader
 * admissions. This is a synthetic calibration ablation, NOT a production
 * final-answer route, semantic accuracy measurement, or independent holdout.
 *
 * No author/human answer labels are loaded or sent to the generator. Raw
 * source/answer text stays in an explicitly local, ignored report file.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  if (i < 0) {
    if (fallback !== undefined) return fallback;
    throw new Error(`S2_MISSING_${name.slice(2).toUpperCase()}`);
  }
  const value = process.argv[i + 1];
  if (!value || value.startsWith("--")) throw new Error(`S2_BAD_${name}`);
  return value;
}
function requireCondition(condition, reason) {
  if (!condition) throw new Error(reason);
}
const observationsFile = path.resolve(flag("--observations"));
const sourcesFile = path.resolve(flag("--sources"));
const routeReportFile = path.resolve(flag("--route-report"));
const outputFile = path.resolve(flag("--output"));
const frozenFixtureFile = path.resolve(flag("--frozen-fixture"));
const baseUrl = flag("--base-url", "http://127.0.0.1:11434/v1");
const model = flag("--model", "qwen2.5:7b-instruct");
const maxCases = Number(flag("--max-cases", "48"));
const timeoutMs = Number(flag("--timeout-ms", "60000"));
requireCondition(
  baseUrl === "http://127.0.0.1:11434/v1" &&
    Number.isSafeInteger(maxCases) &&
    maxCases >= 1 &&
    maxCases <= 48 &&
    Number.isSafeInteger(timeoutMs) &&
    timeoutMs >= 1000 &&
    timeoutMs <= 120000,
  "S2_UNSAFE_OR_INVALID_EXPERIMENT_CONFIGURATION",
);
const [observationBytes, sourceBytes, reportBytes, fixtureBytes] =
  await Promise.all(
    [observationsFile, sourcesFile, routeReportFile, frozenFixtureFile].map(
      (file) => readFile(file),
    ),
  );
const observations = JSON.parse(observationBytes.toString("utf8"));
const sources = JSON.parse(sourceBytes.toString("utf8"));
const routeReport = JSON.parse(reportBytes.toString("utf8"));
requireCondition(
  observations.schemaVersion === "akp.s2.observed-admission-run.v1" &&
    sources.schemaVersion === "akp.s2.authorized-snapshot-batch.v1" &&
    routeReport.schemaVersion === "akp.s2.live-route-observation.v1" &&
    observations.runId === sources.runId &&
    observations.runId === routeReport.runId &&
    observations.executedCommitSha === routeReport.executedCommitSha &&
    sources.frozenSourceManifestSha256 === sha256(fixtureBytes) &&
    routeReport.providerMode === "LAYERED" &&
    observations.observations.length === 48 &&
    sources.snapshots.length === 48 &&
    routeReport.diagnostics.length === 48,
  "S2_PAIRED_RUN_PROVENANCE_MISMATCH",
);
const frozenBlob = createHash("sha1")
  .update(`blob ${fixtureBytes.length}\0`)
  .update(fixtureBytes)
  .digest("hex");
requireCondition(
  frozenBlob === "a61a24df46c0351115cd09e079ae0d8383033082" &&
    routeReport.frozenSourceBlobSha1 === frozenBlob,
  "S2_PAIRED_SOURCE_FREEZE_MISMATCH",
);
const key = (queryHash, scopeHash) => queryHash + ":" + scopeHash;
const byIdentity = new Map();
for (const snapshot of sources.snapshots) {
  const id = key(
    sha256(snapshot.query),
    sha256([...snapshot.authorizedVaultIds].sort().join("\0")),
  );
  requireCondition(!byIdentity.has(id), "S2_DUPLICATE_SOURCE_SNAPSHOT");
  byIdentity.set(id, snapshot);
}
const diagnostics = routeReport.diagnostics;
const normalized = observations.observations.map((observation, index) => {
  const diagnostic = diagnostics[index];
  const snapshot = byIdentity.get(
    key(observation.querySha256, observation.scopeSha256),
  );
  requireCondition(
    observation.schemaVersion === "akp.s2.admission-shadow.v1" &&
      observation.surface === "search" &&
      observation.admissionMode === "LAYERED" &&
      snapshot &&
      diagnostic &&
      diagnostic.admissionMode === "LAYERED" &&
      diagnostic.candidateCount === observation.candidates.length &&
      diagnostic.admittedCount === observation.admittedCandidateCount &&
      ["en", "es"].includes(diagnostic.language) &&
      snapshot.candidates.length === observation.candidates.length &&
      observation.candidates.length === 6,
    "S2_PAIRED_OBSERVATION_OR_SCOPE_MISMATCH",
  );
  const full = [];
  const compact = [];
  for (let j = 0; j < observation.candidates.length; j += 1) {
    const candidate = observation.candidates[j];
    const source = snapshot.candidates[j];
    requireCondition(
      source.vaultId === snapshot.authorizedVaultIds[0] &&
        sha256(source.documentId + ":" + source.unitId) ===
          candidate.candidateKeySha256 &&
        sha256(source.vaultId) === candidate.vaultIdSha256 &&
        sha256(source.unitId) === candidate.unitIdSha256 &&
        sha256(source.excerpt) === candidate.excerptSha256 &&
        sha256(source.sourceUnitText) === source.sourceUnitSha256 &&
        source.sourceUnitText === source.excerpt,
      "S2_PAIRED_SOURCE_BOUNDARY_FAILED",
    );
    const citation = `SRC${j + 1}`;
    full.push({ citation, text: source.sourceUnitText });
    if (candidate.admittedByApplication) {
      const span = candidate.evidenceSpan;
      const excerpt = source.excerpt.trim();
      requireCondition(
        span &&
          candidate.evidenceSpanStatus === "VALID_EXCERPT" &&
          Number.isSafeInteger(span.startOffsetUtf16) &&
          Number.isSafeInteger(span.endOffsetUtf16) &&
          span.startOffsetUtf16 >= 0 &&
          span.endOffsetUtf16 > span.startOffsetUtf16 &&
          span.endOffsetUtf16 <= excerpt.length,
        "S2_PAIRED_ADMITTED_SPAN_MISSING",
      );
      const quote = excerpt.slice(span.startOffsetUtf16, span.endOffsetUtf16);
      requireCondition(
        sha256(quote) === span.quoteSha256 &&
          source.sourceUnitText.includes(quote),
        "S2_PAIRED_SPAN_NOT_SOURCE_BOUND",
      );
      compact.push({ citation, text: quote });
    }
  }
  requireCondition(
    compact.length === observation.admittedCandidateCount &&
      compact.length === diagnostic.reboundCount &&
      diagnostic.admittedWithoutSourceSpan === 0,
    "S2_PAIRED_ADMISSION_COUNTS_MISMATCH",
  );
  return {
    caseId: diagnostic.caseId,
    language: diagnostic.language,
    query: snapshot.query,
    querySha256: observation.querySha256,
    scopeSha256: observation.scopeSha256,
    admittedPassages: compact.length,
    precedingSearchMs: diagnostic.requestElapsedMs,
    full,
    compact,
  };
});
requireCondition(
  new Set(normalized.map((item) => item.caseId)).size === 48 &&
    new Set(normalized.map((item) => item.querySha256)).size === 48,
  "S2_PAIRED_CASE_DUPLICATION",
);

const systemPrompt =
  "You are an evidence-limited answer writer. Use ONLY the supplied passages. " +
  "If they do not explicitly answer the question, abstain. Answer in the " +
  "language of the question. Reply with ONLY a JSON object of shape " +
  '{"status":"ANSWER|ABSTAIN","answer":"...","citations":["SRC1"]}. ' +
  "For ABSTAIN, use an empty answer and [] citations. For ANSWER, cite only " +
  "passage IDs actually provided; do not invent quantities, dates or sources.";
function prompt(caseRow, passages) {
  return (
    "Question:\n" +
    caseRow.query +
    "\n\nAuthorized evidence passages:\n" +
    (passages.length
      ? passages.map((row) => `[${row.citation}] ${row.text}`).join("\n\n")
      : "(none)")
  );
}
function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: sorted.length,
    mean: sorted.length ? sum / sorted.length : null,
    p50: sorted.length ? sorted[Math.ceil(sorted.length * 0.5) - 1] : null,
    p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
  };
}
async function generate(caseRow, arm) {
  const passages = arm === "FULL_POOL" ? caseRow.full : caseRow.compact;
  const body = {
    model,
    temperature: 0,
    seed: 1317,
    max_tokens: 160,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: prompt(caseRow, passages) },
    ],
  };
  const started = performance.now();
  const response = await fetch(baseUrl + "/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const elapsedMs = performance.now() - started;
  requireCondition(response.ok, `S2_MODEL_HTTP_${response.status}`);
  const json = await response.json();
  const usage = json.usage;
  requireCondition(
    usage &&
      Number.isSafeInteger(usage.prompt_tokens) &&
      Number.isSafeInteger(usage.completion_tokens) &&
      usage.prompt_tokens > 0 &&
      usage.completion_tokens > 0,
    "S2_MODEL_USAGE_NOT_REPORTED",
  );
  const raw = json.choices?.[0]?.message?.content;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const shapeValid =
    parsed &&
    ["ANSWER", "ABSTAIN"].includes(parsed.status) &&
    typeof parsed.answer === "string" &&
    Array.isArray(parsed.citations) &&
    parsed.citations.every((id) => typeof id === "string");
  const validCitations =
    shapeValid &&
    parsed.citations.every((id) => passages.some((p) => p.citation === id));
  const validAbstention =
    shapeValid &&
    (parsed.status !== "ABSTAIN" ||
      (parsed.answer.length === 0 && parsed.citations.length === 0));
  return {
    arm,
    passageCount: passages.length,
    elapsedMs,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    raw,
    status: shapeValid ? parsed.status : "INVALID_JSON_OR_SCHEMA",
    answer: shapeValid ? parsed.answer : null,
    citations: shapeValid ? parsed.citations : null,
    outputShapeValid: Boolean(shapeValid),
    validCitations: Boolean(validCitations),
    validAbstention: Boolean(validAbstention),
  };
}
const outputRows = [];
const checkpointFile = outputFile + ".partial.json";
for (const [index, caseRow] of normalized.slice(0, maxCases).entries()) {
  const reverse = parseInt(caseRow.querySha256.slice(0, 2), 16) % 2 === 1;
  const arms = reverse
    ? ["ADMITTED_SPANS", "FULL_POOL"]
    : ["FULL_POOL", "ADMITTED_SPANS"];
  const outputs = [];
  for (const arm of arms) outputs.push(await generate(caseRow, arm));
  outputRows.push({
    caseId: caseRow.caseId,
    language: caseRow.language,
    querySha256: caseRow.querySha256,
    scopeSha256: caseRow.scopeSha256,
    precedingSearchMs: caseRow.precedingSearchMs,
    admittedPassages: caseRow.admittedPassages,
    armOrder: arms,
    outputs,
  });
  await mkdir(path.dirname(outputFile), { recursive: true });
  await writeFile(
    checkpointFile,
    JSON.stringify({ rows: outputRows, incomplete: true }, null, 2) + "\n",
  );
  process.stdout.write(`S2_GENERATION_PROGRESS ${index + 1}/${maxCases}\n`);
}
const armStats = Object.fromEntries(
  ["FULL_POOL", "ADMITTED_SPANS"].map((arm) => {
    const rows = outputRows.map((row) =>
      row.outputs.find((output) => output.arm === arm),
    );
    return [
      arm,
      {
        calls: rows.length,
        promptTokens: distribution(rows.map((r) => r.promptTokens)),
        completionTokens: distribution(rows.map((r) => r.completionTokens)),
        generationMs: distribution(rows.map((r) => r.elapsedMs)),
        answerCount: rows.filter((r) => r.status === "ANSWER").length,
        abstentionCount: rows.filter((r) => r.status === "ABSTAIN").length,
        invalidShapeCount: rows.filter((r) => !r.outputShapeValid).length,
        badCitationCount: rows.filter((r) => !r.validCitations).length,
        malformedAbstentionCount: rows.filter((r) => !r.validAbstention).length,
      },
    ];
  }),
);
const pairedSavedTokens = outputRows.map((row) => {
  const full = row.outputs.find((r) => r.arm === "FULL_POOL");
  const compact = row.outputs.find((r) => r.arm === "ADMITTED_SPANS");
  return full.promptTokens - compact.promptTokens;
});
const report = {
  schemaVersion: "akp.s2.synthetic-paired-answer-generation.v1",
  evidenceLevel: "LOCAL_MODEL_POST_SEARCH_SIMULATION_ON_EXPOSED_CALIBRATION",
  sourceRunId: observations.runId,
  sourceGitBlobSha1: frozenBlob,
  sourceObservationSha256: sha256(observationBytes),
  sourceSnapshotSha256: sha256(sourceBytes),
  sourceRouteReportSha256: sha256(reportBytes),
  upstreamCommitSha: routeReport.executedCommitSha,
  experimentModel: model,
  provider: "ollama-loopback-openai-compatible",
  modelParameters: { temperature: 0, seed: 1317, maxTokens: 160 },
  promptTemplateSha256: sha256(systemPrompt),
  casesRun: outputRows.length,
  armStats,
  pairedPromptTokensSaved: distribution(pairedSavedTokens),
  selectedWithoutGoldLabels: true,
  independentHoldout: false,
  independentHumanScoring: false,
  productionAnswerRouteMeasured: false,
  observedSearchPlusGenerationAsOneRequest: false,
  measuredProviderPromptAndCompletionTokens: true,
  answerCorrectnessMeasured: false,
  manualObsidianMeasured: false,
  productionDefaultsChanged: false,
  gateAccepted: false,
  interpretation:
    "Only a synthetic local answer-generator continuation, not product final-answer quality, production end-to-end latency, or independent S2 acceptance. Reported model prompt tokens include each arm's exact submitted prompt; answer/abstain status is model-declared and unadjudicated.",
  rows: outputRows,
};
await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n", {
  flag: "wx",
});
process.stdout.write(
  JSON.stringify({
    status: "SYNTHETIC_SIMULATION_MEASURED_NOT_GATEABLE",
    cases: outputRows.length,
    armStats,
    pairedPromptTokensSaved: report.pairedPromptTokensSaved,
    outputFile,
    gateAccepted: false,
  }) + "\n",
);
