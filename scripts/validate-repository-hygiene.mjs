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
  "GENERATED_CANONICAL",
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
  ".dockerignore",
  "Dockerfile",
  "dependency-cruiser.cjs",
  "docker-compose.team-node.yml",
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
  return [...new Set(files)].sort((left, right) => left.localeCompare(right));
}

function classify(file) {
  if (file === classificationPath) {
    return ["GENERATED_CANONICAL", "generated repository inventory"];
  }
  if (/^db\/migrations\/\d+_.+\.sql$/.test(file)) {
    return ["MIGRATION", "append-only database migration"];
  }
  if (/^evals\/generic\//.test(file)) {
    return ["PRODUCT_EVAL", "corpus-agnostic product evaluation"];
  }
  if (/^evals\/registered\//.test(file)) {
    return ["PRODUCT_EVAL", "versioned registered product evaluation"];
  }
  if (/^evals\/schemas\//.test(file)) {
    return ["PRODUCT_CONTRACT", "evaluation case schema contract"];
  }
  if (/^evals\/fixtures\//.test(file) || /^test\/fixtures\//.test(file)) {
    return ["FIXTURE_GENERIC", "portable test or evaluation fixture"];
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
    return ["GENERATED_CANONICAL", "reproducible product report"];
  }
  if (
    /^(?:docs\/|README\.md$|AGENTS\.md$|ARCHITECTURE\.md$|CONTRIBUTING\.md$|CHANGELOG\.md$)/.test(
      file,
    )
  ) {
    return ["PRODUCT_DOCUMENTATION", "product documentation"];
  }
  if (
    /^(?:apps|packages|scripts)\//.test(file) ||
    /^(?:dependency-cruiser\.cjs|Dockerfile|docker-compose(?:\.[A-Za-z0-9-]+)?\.yml|turbo\.json|tsconfig\.base\.json)$/.test(
      file,
    )
  ) {
    return ["PRODUCT_CODE", "runtime, build or operational code"];
  }
  if (
    /^(?:ops\/|policies\/|\.github\/|\.env\.example$|\.dockerignore$|\.gitattributes$|\.gitignore$|\.prettierignore$|\.prettierrc\.json$|package\.json$|pnpm-workspace\.yaml$|LICENSE(?:\.md)?$)/.test(
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
  /^TEMP(?:[_.-].*)?\.md$/i,
  /_DRAFT_PLAN\.md$/i,
  /_HANDOFF_TEMP\.md$/i,
  /^IMPLEMENTATION_NOTES_.*\.md$/i,
];
const constructionDocumentName =
  /^(?:COMPETITIVE_AUDIT|DOCUMENT_INTELLIGENCE_BENCHMARK|EVENT_DRIVEN_VALIDATION_REPORT|GENERICITY_AUDIT|IMPLEMENTATION_REPORT|MIGRATION_REPORT|PROJECT_STATE|REMAINING_REAL_GAPS|REPOSITORY_HYGIENE_REPORT|RESEARCH_LOG|RETRIEVAL_BENCHMARK|SECURITY_REPORT|TRACEABILITY|VALIDATION_REPORT)\.md$/i;
const phasePathToken = /(?:^|[\/_.-])p\d+(?=$|[\/_.-])/i;
const phaseLabel = /\bP\d{1,2}\b/;
function activeGuidanceOrAutomation(file) {
  if (/^(?:README|AGENTS|ARCHITECTURE|CONTRIBUTING|CHANGELOG)\.md$/.test(file))
    return true;
  if (/^docs\/.*\.md$/.test(file)) return true;
  if (file === ".env.example" || file === "docker-compose.yml") return true;
  if (/^(?:\.github|ops|policies)\/.*\.(?:md|json|ya?ml)$/.test(file))
    return true;
  if (/^scripts\/.*\.(?:mjs|cjs|js|ts|ps1|py|sh)$/.test(file)) return true;
  return false;
}

function normalizedPathText(content) {
  let normalized = content;
  while (normalized.includes("\\\\")) {
    normalized = normalized.replaceAll("\\\\", "\\");
  }
  return normalized;
}

function portabilityFailures(file, content) {
  const normalized = normalizedPathText(content);
  const failures = [];
  if (/\b[A-Za-z]:\\Users\\[^\\\r\n]+\\/i.test(normalized))
    failures.push(`PERSONAL_WINDOWS_PATH ${file}`);
  if (/\/Users\/[^/\s]+(?:\/|$)/i.test(normalized))
    failures.push(`PERSONAL_MAC_PATH ${file}`);
  for (const match of normalized.matchAll(/\/home\/([^/\s]+)(?:\/|$)/gi)) {
    const user = String(match[1]).toLowerCase();
    if (!["node", "runner", "root", "postgres", "app"].includes(user)) {
      failures.push(`PERSONAL_LINUX_PATH ${file}`);
      break;
    }
  }
  if (/\bfile:\/\//i.test(normalized))
    failures.push(`FILE_URI_IN_GUIDANCE_OR_AUTOMATION ${file}`);
  return failures;
}

function isTextCandidate(file) {
  return (
    /\.(?:[cm]?[jt]sx?|json|ya?ml|md|sql|py|ps1|sh|txt)$/.test(file) ||
    file === ".env.example"
  );
}

const files = repositoryFiles();
const entries = files.map((file) => {
  const [category, reason] = classify(file);
  return { path: file, category, reason };
});
const failures = [];

for (const entry of entries) {
  if (!categories.has(entry.category) || entry.category === "UNKNOWN")
    failures.push(`UNCLASSIFIED ${entry.path}`);

  const [rootEntry] = entry.path.split("/", 1);
  if (!entry.path.includes("/")) {
    if (!allowedRootFiles.has(entry.path))
      failures.push(`ROOT_FILE_NOT_ALLOWED ${entry.path}`);
  } else if (!allowedRootDirectories.has(rootEntry)) {
    failures.push(`ROOT_DIRECTORY_NOT_ALLOWED ${rootEntry}`);
  }

  const name = path.posix.basename(entry.path);
  if (iterationResidue.some((pattern) => pattern.test(name)))
    failures.push(`ITERATION_RESIDUE ${entry.path}`);
  if (constructionDocumentName.test(name))
    failures.push(`CONSTRUCTION_DOCUMENT ${entry.path}`);
  if (/^docs\/(?:archive|assurance\/archive)\//.test(entry.path))
    failures.push(`CONSTRUCTION_ARCHIVE_IN_PRODUCT_TREE ${entry.path}`);
  if (
    entry.path.startsWith("docs/assurance/") &&
    entry.path !== "docs/assurance/README.md" &&
    !/^docs\/assurance\/releases\/v\d+\.\d+\.\d+\/README\.md$/.test(entry.path)
  )
    failures.push(`ASSURANCE_LAYOUT_NOT_RELEASE_ORIENTED ${entry.path}`);
  if (phasePathToken.test(entry.path))
    failures.push(`PHASE_CODED_PATH ${entry.path}`);
  if (/^reports\/.*\.json$/i.test(entry.path))
    failures.push(`GENERATED_REPORT_TRACKED ${entry.path}`);

  if (!isTextCandidate(entry.path)) continue;
  const content = readFileSync(path.join(root, entry.path), "utf8");

  if (activeGuidanceOrAutomation(entry.path)) {
    failures.push(...portabilityFailures(entry.path, content));
    if (
      entry.path !== "scripts/validate-repository-hygiene.mjs" &&
      phaseLabel.test(content)
    ) {
      failures.push(`PHASE_LABEL_IN_GUIDANCE_OR_AUTOMATION ${entry.path}`);
    }
  }
}

const fixedUuidPattern =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
for (const file of files.filter(
  (candidate) =>
    /^(?:apps\/api\/src|apps\/mcp|apps\/cli|apps\/web)\//.test(candidate) &&
    !/(^|\/)(?:test|tests)\//.test(candidate) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(candidate),
)) {
  if (!isTextCandidate(file)) continue;
  const content = readFileSync(path.join(root, file), "utf8");
  if (fixedUuidPattern.test(content))
    failures.push(`GENERICITY_FIXED_UUID ${file}`);
}

const payload = `${JSON.stringify({ schemaVersion: 3, files: entries }, null, 2)}\n`;
if (process.argv.includes("--write"))
  writeFileSync(path.join(root, classificationPath), payload, "utf8");

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
