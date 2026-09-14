import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const classificationPath = "reports/repository-file-classification.json";

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

const allowedCategories = new Set([
  "PRODUCT_CODE",
  "PRODUCT_CONTRACT",
  "PRODUCT_TEST",
  "PRODUCT_EVAL",
  "PRODUCT_DOCUMENTATION",
  "MIGRATION",
  "FIXTURE_GENERIC",
  "GENERATED_CANONICAL",
]);

const processResidueName =
  /(?:^|[-_.])(goal|progress|iteration|worklog|scratch|temp|draft-plan|handoff-temp|implementation-notes)(?:[-_.]|$)/i;
const phasePathToken = /(?:^|[\/_.-])p\d+(?=$|[\/_.-])/i;
const phaseLabel = /\bP\d{1,2}\b/;
const fixedUuid =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

function repositoryFiles() {
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" },
  );

  return [
    ...new Set(
      output
        .split(/\r?\n/)
        .map((file) => file.replaceAll("\\", "/"))
        .filter(Boolean)
        .filter((file) => existsSync(path.join(root, file))),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function isTestPath(file) {
  return (
    /(^|\/)(?:test|tests)\//.test(file) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
  );
}

function isTextFile(file) {
  return (
    /\.(?:[cm]?[jt]sx?|json|ya?ml|md|sql|py|ps1|sh|txt)$/.test(file) ||
    file === ".env.example"
  );
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
  if (/^evals\/schemas\//.test(file)) {
    return ["PRODUCT_CONTRACT", "evaluation schema contract"];
  }
  if (/^evals\/fixtures\//.test(file) || /^test\/fixtures\//.test(file)) {
    return ["FIXTURE_GENERIC", "portable test or evaluation fixture"];
  }
  if (isTestPath(file) || /^apps\/extractor\/tests\//.test(file)) {
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

function isActiveGuidanceOrAutomation(file) {
  return (
    /^(?:README|AGENTS|ARCHITECTURE|CONTRIBUTING|CHANGELOG)\.md$/.test(file) ||
    /^docs\/.*\.md$/.test(file) ||
    file === ".env.example" ||
    file === "docker-compose.yml" ||
    /^(?:\.github|ops|policies)\/.*\.(?:md|json|ya?ml)$/.test(file) ||
    /^scripts\/.*\.(?:mjs|cjs|js|ts|ps1|py|sh)$/.test(file)
  );
}

function portabilityFailures(file, content) {
  const failures = [];

  if (/\b[A-Za-z]:\\[^\\\r\n]+\\[^\\\r\n]+\\/.test(content)) {
    failures.push(`ABSOLUTE_WINDOWS_PATH ${file}`);
  }
  if (/\/Users\/[^/\s]+(?:\/|$)/.test(content)) {
    failures.push(`ABSOLUTE_MAC_HOME_PATH ${file}`);
  }
  for (const match of content.matchAll(/\/home\/([^/\s]+)(?:\/|$)/g)) {
    const user = String(match[1]).toLowerCase();
    if (!["app", "node", "postgres", "root", "runner"].includes(user)) {
      failures.push(`ABSOLUTE_LINUX_HOME_PATH ${file}`);
      break;
    }
  }
  if (/\bfile:\/\//i.test(content)) {
    failures.push(`FILE_URI_IN_GUIDANCE_OR_AUTOMATION ${file}`);
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
  if (!allowedCategories.has(entry.category)) {
    failures.push(`UNCLASSIFIED ${entry.path}`);
  }

  const rootEntry = entry.path.split("/", 1)[0];
  if (!entry.path.includes("/")) {
    if (!allowedRootFiles.has(entry.path)) {
      failures.push(`ROOT_FILE_NOT_ALLOWED ${entry.path}`);
    }
  } else if (!allowedRootDirectories.has(rootEntry)) {
    failures.push(`ROOT_DIRECTORY_NOT_ALLOWED ${rootEntry}`);
  }

  const name = path.posix.basename(entry.path);
  if (processResidueName.test(name)) {
    failures.push(`PROCESS_RESIDUE_NAME ${entry.path}`);
  }
  if (/^docs\/(?:archive|assurance\/archive)\//.test(entry.path)) {
    failures.push(`CONSTRUCTION_ARCHIVE_IN_PRODUCT_TREE ${entry.path}`);
  }
  if (
    entry.path.startsWith("docs/assurance/") &&
    entry.path !== "docs/assurance/README.md" &&
    !/^docs\/assurance\/releases\/v\d+\.\d+\.\d+\/README\.md$/.test(
      entry.path,
    )
  ) {
    failures.push(`ASSURANCE_LAYOUT_NOT_RELEASE_ORIENTED ${entry.path}`);
  }
  if (phasePathToken.test(entry.path)) {
    failures.push(`PHASE_CODED_PATH ${entry.path}`);
  }

  if (!isTextFile(entry.path)) continue;
  const content = readFileSync(path.join(root, entry.path), "utf8");

  if (isActiveGuidanceOrAutomation(entry.path)) {
    failures.push(...portabilityFailures(entry.path, content));
    if (
      entry.path !== "scripts/validate-repository-hygiene.mjs" &&
      phaseLabel.test(content)
    ) {
      failures.push(`PHASE_LABEL_IN_GUIDANCE_OR_AUTOMATION ${entry.path}`);
    }
  }

  if (
    /^(?:apps\/api\/src|apps\/mcp|apps\/cli|apps\/web)\//.test(entry.path) &&
    !isTestPath(entry.path) &&
    fixedUuid.test(content)
  ) {
    failures.push(`GENERICITY_FIXED_UUID ${entry.path}`);
  }
}

const payload = `${JSON.stringify({ schemaVersion: 3, files: entries }, null, 2)}\n`;
if (process.argv.includes("--write")) {
  writeFileSync(path.join(root, classificationPath), payload, "utf8");
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
