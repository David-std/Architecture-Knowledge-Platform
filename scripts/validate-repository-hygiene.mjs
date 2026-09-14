import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const classificationPath = "reports/repository-file-classification.json";
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

const allowedRootFiles = new Set([
  ".env.example",
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
  ".prettierrc.json",
  "AGENTS.md",
  "ARCHITECTURE.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "LICENSE",
  "LICENSE.md",
  "README.md",
  "dependency-cruiser.cjs",
  "docker-compose.yml",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  "turbo.json",
]);
const allowedRootDirectories = new Set([
  ".github",
  "apps",
  "contracts",
  "db",
  "docs",
  "evals",
  "ops",
  "packages",
  "policies",
  "reports",
  "scripts",
  "test",
]);
const historicalPrefixes = [
  "docs/archive/",
  "docs/assurance/archive/",
  "docs/assurance/releases/",
];

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
    .filter((file) => existsSync(path.join(root, file)));
  if (!files.includes(classificationPath)) files.push(classificationPath);
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

function classify(file) {
  if (file === classificationPath) {
    return ["GENERATED_CANONICAL", "deterministic repository inventory"];
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
      "explicit Architecture Knowledge System eval pack",
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
      "archived iteration record excluded from active documentation",
    ];
  }
  if (/^docs\/assurance\/(?:archive|releases)\//.test(file)) {
    return [
      "PRODUCT_DOCUMENTATION",
      "historical assurance snapshot excluded from active guidance",
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
    /^(?:docs\/|README\.md$|AGENTS\.md$|ARCHITECTURE\.md$|CONTRIBUTING\.md$|CHANGELOG\.md$)/.test(
      file,
    )
  ) {
    return ["PRODUCT_DOCUMENTATION", "active product documentation"];
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
    /^(?:ops\/|policies\/|\.github\/|\.env\.example$|\.gitattributes$|\.gitignore$|\.prettierignore$|\.prettierrc\.json$|package\.json$|pnpm-workspace\.yaml$|LICENSE(?:\.md)?$)/.test(
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

function isHistorical(file) {
  return historicalPrefixes.some((prefix) => file.startsWith(prefix));
}

function activeDocumentationOrConfiguration(file) {
  if (isHistorical(file)) return false;
  if (/^(?:README|AGENTS|ARCHITECTURE|CONTRIBUTING|CHANGELOG)\.md$/.test(file)) {
    return true;
  }
  if (/^docs\/.*\.md$/.test(file)) return true;
  if (file === ".env.example" || file === "docker-compose.yml") return true;
  if (/^(?:\.github|ops|policies)\/.*\.(?:md|json|ya?ml)$/.test(file)) {
    return true;
  }
  return false;
}

function normalizedPathText(content) {
  let normalized = content;
  while (normalized.includes("\\\\")) {
    normalized = normalized.replaceAll("\\\\", "\\");
  }
  return normalized;
}

function pathPolicyFailures(file, content) {
  const normalized = normalizedPathText(content);
  const failures = [];
  if (/\b[A-Za-z]:\\Users\\[^\\\r\n]+\\/i.test(normalized)) {
    failures.push(`PERSONAL_WINDOWS_PATH ${file}`);
  }
  if (/\/Users\/[^/\s]+(?:\/|$)/i.test(normalized)) {
    failures.push(`PERSONAL_MAC_PATH ${file}`);
  }
  for (const match of normalized.matchAll(/\/home\/([^/\s]+)(?:\/|$)/gi)) {
    const user = String(match[1]).toLowerCase();
    if (!["node", "runner", "root", "postgres", "app"].includes(user)) {
      failures.push(`PERSONAL_LINUX_PATH ${file}`);
      break;
    }
  }
  if (/\bfile:\/\//i.test(normalized)) {
    failures.push(`FILE_URI_IN_ACTIVE_DOC_OR_CONFIG ${file}`);
  }
  if (/Architecture-Knowledge-System/i.test(normalized)) {
    failures.push(`PERSONAL_VAULT_IN_ACTIVE_GUIDANCE ${file}`);
  }
  return failures;
}

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

  const [rootEntry] = entry.path.split("/", 1);
  if (!entry.path.includes("/")) {
    if (!allowedRootFiles.has(entry.path)) {
      failures.push(`ROOT_FILE_NOT_ALLOWED ${entry.path}`);
    }
  } else if (!allowedRootDirectories.has(rootEntry)) {
    failures.push(`ROOT_DIRECTORY_NOT_ALLOWED ${rootEntry}`);
  }

  const name = path.posix.basename(entry.path);
  if (!isHistorical(entry.path) && iterationResidue.some((pattern) => pattern.test(name))) {
    failures.push(`ITERATION_RESIDUE ${entry.path}`);
  }

  if (activeDocumentationOrConfiguration(entry.path)) {
    const content = readFileSync(path.join(root, entry.path), "utf8");
    failures.push(...pathPolicyFailures(entry.path, content));
  }
}

const genericCore = files.filter(
  (file) =>
    /^(?:apps|packages|contracts|policies|evals\/generic)\//.test(file) &&
    !/(^|\/)(?:test|tests|fixtures)\//.test(file) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file),
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

const payload = `${JSON.stringify({ schemaVersion: 2, files: entries }, null, 2)}\n`;
const write = process.argv.includes("--write");
if (write) writeFileSync(path.join(root, classificationPath), payload, "utf8");
else {
  try {
    const current = readFileSync(path.join(root, classificationPath), "utf8");
    if (current.replaceAll("\r\n", "\n") !== payload) {
      failures.push(`${classificationPath} is stale; run with --write`);
    }
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
