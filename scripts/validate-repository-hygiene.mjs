import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const classificationPath = "REPOSITORY_FILE_CLASSIFICATION.json";
const categories = new Set([
  "PRODUCT_CODE",
  "PRODUCT_CONTRACT",
  "PRODUCT_TEST",
  "PRODUCT_EVAL",
  "PRODUCT_DOCUMENTATION",
  "MIGRATION",
  "FIXTURE_GENERIC",
  "FIXTURE_VAULT_SPECIFIC",
  "GENERATED_CANONICAL",
  "GENERATED_EPHEMERAL",
  "TEMPORARY_ITERATION_ARTIFACT",
  "OBSOLETE",
  "UNKNOWN",
]);

function repositoryFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  );
  const files = output
    .split(/\r?\n/)
    .map((file) => file.replaceAll("\\", "/"))
    .filter(Boolean)
    // `git ls-files --cached` also reports an unstaged deletion. A deleted
    // path is not a repository artifact and must not make the generated
    // inventory stale while a cleanup change is being reviewed.
    .filter((file) => existsSync(path.join(root, file)));
  if (!files.includes(classificationPath)) files.push(classificationPath);
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

function classify(file) {
  if (file === classificationPath) {
    return ["GENERATED_CANONICAL", "deterministic repository inventory"];
  }
  if (
    file === "REPOSITORY_HYGIENE_REPORT.md" ||
    file === "GENERICITY_AUDIT.md" ||
    file === "RESIDUAL_ARTIFACTS_REPORT.md"
  ) {
    return ["PRODUCT_DOCUMENTATION", "canonical hygiene or genericity report"];
  }
  if (/^db\/migrations\/\d+_.+\.sql$/.test(file)) {
    return ["MIGRATION", "append-only database migration"];
  }
  if (/^evals\/generic\//.test(file)) {
    return ["PRODUCT_EVAL", "generic product evaluation"];
  }
  if (/^evals\/fixtures\/architecture-knowledge-system\//.test(file)) {
    return [
      "FIXTURE_VAULT_SPECIFIC",
      "Architecture Knowledge System eval pack",
    ];
  }
  if (/^evals\/schemas\//.test(file)) {
    return ["PRODUCT_CONTRACT", "evaluation case schema contract"];
  }
  if (
    /^evals\/fixtures\//.test(file) ||
    /^test\/fixtures\/synthetic/.test(file)
  ) {
    return ["FIXTURE_GENERIC", "portable synthetic fixture"];
  }
  if (/^test\/fixtures\//.test(file)) {
    return ["FIXTURE_GENERIC", "generic integration fixture"];
  }
  if (/^docs\/archive\/iterations\//.test(file)) {
    return [
      "OBSOLETE",
      "archived iteration record excluded from normal retrieval",
    ];
  }
  if (
    /(^|\/)(test|tests)\//.test(file) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /^apps\/extractor\/tests\//.test(file)
  ) {
    return ["PRODUCT_TEST", "executable product test"];
  }
  if (/^contracts\//.test(file) || file === "pnpm-lock.yaml") {
    return ["PRODUCT_CONTRACT", "versioned interface or dependency contract"];
  }
  if (/^reports\//.test(file)) {
    return ["GENERATED_CANONICAL", "canonical reproducible report"];
  }
  if (
    /^(?:docs\/|README\.md$|AGENTS\.md$|ARCHITECTURE\.md$|CONTRIBUTING\.md$)/.test(
      file,
    ) ||
    /(?:_REPORT|_AUDIT|_BENCHMARK|_STATE|_LOG|_MATRIX|_GAPS|TRACEABILITY|CHANGELOG)\.md$/.test(
      file,
    )
  ) {
    return ["PRODUCT_DOCUMENTATION", "canonical product documentation"];
  }
  if (
    /^(?:apps|packages|scripts)\//.test(file) ||
    /^(?:dependency-cruiser\.cjs|docker-compose\.yml|turbo\.json|tsconfig\.base\.json)$/.test(
      file,
    )
  ) {
    return ["PRODUCT_CODE", "runtime, build or operational code"];
  }
  if (
    /^(?:policies\/|\.github\/|\.env\.example$|\.gitignore$|\.prettierignore$|package\.json$|pnpm-workspace\.yaml$)/.test(
      file,
    )
  ) {
    return ["PRODUCT_CONTRACT", "configuration or policy contract"];
  }
  return ["UNKNOWN", "no maintained classification rule"];
}

const iterationResidue = [
  /^GOAL_.*\.md$/i,
  /_GOAL\.md$/i,
  /_PROGRESS\.md$/i,
  /^PROGRESS_.*\.md$/i,
  /_ITERATION\.md$/i,
  /^ITERATION_.*\.md$/i,
  /_AMENDMENT\.md$/i,
  /_NEXT_STEPS\.md$/i,
  /^NEXT_STEPS\.md$/i,
  /^WORKLOG.*\.md$/i,
  /^SCRATCH.*\.md$/i,
  /^TEMP.*\.md$/i,
  /_DRAFT_PLAN\.md$/i,
  /_HANDOFF_TEMP\.md$/i,
  /^IMPLEMENTATION_NOTES_.*\.md$/i,
];

const files = repositoryFiles();
const entries = files.map((file) => {
  const [category, reason] = classify(file);
  return { path: file, category, reason };
});
const failures = [];
for (const entry of entries) {
  if (!categories.has(entry.category) || entry.category === "UNKNOWN") {
    failures.push(`UNCLASSIFIED ${entry.path}`);
  }
  const name = path.posix.basename(entry.path);
  const archived = entry.path.startsWith("docs/archive/iterations/");
  if (!archived && iterationResidue.some((pattern) => pattern.test(name))) {
    failures.push(`ITERATION_RESIDUE ${entry.path}`);
  }
}

const genericCore = files.filter(
  (file) =>
    /^(?:apps|packages|contracts|policies|evals\/generic)\//.test(file) &&
    !/(^|\/)(?:test|tests|fixtures)\//.test(file),
);
const leakagePattern =
  /\b(?:SI729|SI730|UPC|WF-DDD-END-TO-END|cqrs-capability-model|resources-is-layer)\b/i;
const fixedUuidPattern =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
for (const file of genericCore) {
  if (!/\.(?:[cm]?[jt]sx?|json|ya?ml|md|sql|py)$/.test(file)) continue;
  const content = readFileSync(path.join(root, file), "utf8");
  if (leakagePattern.test(content)) failures.push(`GENERICITY_LEAK ${file}`);
  if (
    /^(?:apps\/api\/src|apps\/mcp|apps\/cli|apps\/web)\//.test(file) &&
    fixedUuidPattern.test(content)
  ) {
    failures.push(`GENERICITY_FIXED_UUID ${file}`);
  }
}

const payload = `${JSON.stringify({ schemaVersion: 1, files: entries }, null, 2)}\n`;
const write = process.argv.includes("--write");
if (write) writeFileSync(path.join(root, classificationPath), payload, "utf8");
else {
  try {
    const current = readFileSync(path.join(root, classificationPath), "utf8");
    // Git may materialize CRLF on Windows even though the canonical generated
    // payload uses LF. Compare normalized text so a clean checkout remains
    // reproducible across the CI/Linux and desktop/Windows environments.
    if (current.replaceAll("\r\n", "\n") !== payload)
      failures.push(`${classificationPath} is stale; run with --write`);
  } catch {
    failures.push(`${classificationPath} is missing; run with --write`);
  }
}

if (failures.length > 0) {
  console.error(JSON.stringify({ status: "FAILED", failures }, null, 2));
  process.exitCode = 1;
} else {
  console.log(
    JSON.stringify(
      { status: "PASSED", files: entries.length, classificationPath },
      null,
      2,
    ),
  );
}
