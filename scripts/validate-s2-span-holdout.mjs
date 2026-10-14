import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const fixture = path.join(root, "evals/registered/s2-source-span-holdout.json");
const frozenBlob = "a61a24df46c0351115cd09e079ae0d8383033082";
const s1Baseline = "3969cd6f11bbd247981ccf630b2a7469ba78d306";
const thresholds = {
  precisionMin: 0.8,
  wilsonSimpleLowerDiagnosticMin: 0.7,
  falseAdmissionRateMax: 0.1,
  p95LatencyMsMax: 25000,
  degradedCallRateMax: 0.05,
  answerCorrectnessNonRegression: true,
};

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

export function inspectHoldout(data) {
  const failures = [];
  if (
    data.schemaVersion !== "akp.s2.source-span-holdout.v1" ||
    data.status !== "FROZEN_PRE_IMPLEMENTATION" ||
    data.frozenAt !== "2026-10-13" ||
    data.parentBaselineSha !== s1Baseline ||
    data.reviewStatus !== "AUTHOR_CONSTRUCTED_NOT_INDEPENDENTLY_ADJUDICATED" ||
    data.eligibleForTuning !== false ||
    data.privateCustomerDataIncluded !== false ||
    JSON.stringify(data.thresholdsPreRegistered) !== JSON.stringify(thresholds)
  ) {
    failures.push("HOLDOUT_FREEZE_METADATA_OR_GATE_CHANGED");
  }
  if (
    !Array.isArray(data.sourceDocuments) ||
    data.sourceDocuments.length !== 4
  ) {
    failures.push("HOLDOUT_SOURCE_COUNT_INVALID");
  }
  if (!Array.isArray(data.cases) || data.cases.length !== 48) {
    failures.push("HOLDOUT_CASE_COUNT_INVALID");
  }
  if (failures.length) return { failures, strata: {}, sourceHashes: [] };

  const sources = new Set();
  const domains = new Set();
  const units = new Map();
  const sourceHashes = [];
  for (const source of data.sourceDocuments) {
    if (
      typeof source.id !== "string" ||
      sources.has(source.id) ||
      typeof source.domain !== "string" ||
      domains.has(source.domain) ||
      source.format !== "text/markdown" ||
      !Array.isArray(source.units) ||
      source.units.length !== 6
    ) {
      failures.push("HOLDOUT_DUPLICATE_OR_MALFORMED_SOURCE");
      continue;
    }
    sources.add(source.id);
    domains.add(source.domain);
    for (const unit of source.units) {
      if (
        typeof unit.id !== "string" ||
        units.has(unit.id) ||
        typeof unit.text !== "string" ||
        unit.text.trim().length < 35
      ) {
        failures.push("HOLDOUT_DUPLICATE_OR_INVALID_UNIT");
        continue;
      }
      units.set(unit.id, { sourceId: source.id, text: unit.text });
    }
    sourceHashes.push({
      sourceId: source.id,
      sha256: sha256(
        source.units.map((unit) => unit.id + "\n" + unit.text).join("\n\n"),
      ),
      unitCount: source.units.length,
    });
  }

  const caseIds = new Set();
  const strata = Object.fromEntries(
    [...sources].map((sourceId) => [
      sourceId,
      { enPositive: 0, enNegative: 0, esPositive: 0, esNegative: 0 },
    ]),
  );
  for (const item of data.cases) {
    if (
      typeof item.id !== "string" ||
      caseIds.has(item.id) ||
      !sources.has(item.sourceId) ||
      !["en", "es"].includes(item.language) ||
      typeof item.query !== "string" ||
      item.query.trim().length < 20 ||
      typeof item.challenge !== "string" ||
      item.challenge.length < 5 ||
      typeof item.answerable !== "boolean" ||
      !Array.isArray(item.gold)
    ) {
      failures.push("HOLDOUT_INVALID_OR_UNSCOPED_CASE");
      continue;
    }
    caseIds.add(item.id);
    const category =
      item.language + (item.answerable ? "Positive" : "Negative");
    strata[item.sourceId][category] += 1;
    if (item.gold.length !== (item.answerable ? 1 : 0)) {
      failures.push("HOLDOUT_GOLD_LABEL_INCONSISTENT");
    }
    for (const gold of item.gold) {
      const unit = units.get(gold.unitId);
      if (
        !unit ||
        unit.sourceId !== item.sourceId ||
        typeof gold.quote !== "string" ||
        gold.quote.length < 16 ||
        !unit.text.includes(gold.quote)
      ) {
        failures.push("HOLDOUT_GOLD_NOT_SOURCE_EXACT");
      }
    }
  }
  if (sources.size !== 4 || units.size !== 24 || caseIds.size !== 48) {
    failures.push("HOLDOUT_IDENTITIES_INCOMPLETE");
  }
  if (
    Object.values(strata).some((group) =>
      Object.values(group).some((count) => count !== 3),
    )
  ) {
    failures.push("HOLDOUT_STRATA_UNBALANCED");
  }
  return { failures, strata, sourceHashes };
}

const raw = readFileSync(fixture, "utf8");
const gitBlobSha = createHash("sha1")
  .update("blob " + Buffer.byteLength(raw, "utf8") + "\0")
  .update(raw, "utf8")
  .digest("hex");
if (gitBlobSha !== frozenBlob) {
  throw new Error("S2_HOLDOUT_BYTES_CHANGED_AFTER_FREEZE");
}
const dataset = JSON.parse(raw);
const result = inspectHoldout(dataset);
if (process.argv.includes("--self-test")) {
  const edits = [
    (data) => {
      data.thresholdsPreRegistered.precisionMin = 0.5;
    },
    (data) => {
      data.cases[0].gold[0].quote = "invented";
    },
    (data) => {
      data.cases[0].sourceId = data.sourceDocuments[1].id;
    },
    (data) => {
      data.cases[1].id = data.cases[0].id;
    },
    (data) => {
      data.cases[0].answerable = false;
    },
    (data) => {
      data.eligibleForTuning = true;
    },
    (data) => {
      data.sourceDocuments[0].units[0].text = "";
    },
  ];
  for (const edit of edits) {
    const tampered = structuredClone(dataset);
    edit(tampered);
    if (inspectHoldout(tampered).failures.length === 0) {
      result.failures.push("HOLDOUT_MUTATION_SELF_TEST_FAILED");
    }
  }
}
if (result.failures.length > 0) {
  process.stderr.write(
    JSON.stringify({ status: "FAILED", failures: result.failures }) + "\n",
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    JSON.stringify(
      {
        status: "PASSED",
        evidenceLevel: "STRUCTURAL_ORACLE_VALIDATION_ONLY",
        retrievalPrecisionMeasured: false,
        independentlyAdjudicated: false,
        frozenGitBlobSha1: gitBlobSha,
        caseCount: dataset.cases.length,
        positives: dataset.cases.filter((item) => item.answerable).length,
        negatives: dataset.cases.filter((item) => !item.answerable).length,
        strata: result.strata,
        sourceHashes: result.sourceHashes,
        mutationSelfTest: process.argv.includes("--self-test"),
      },
      null,
      2,
    ) + "\n",
  );
}
