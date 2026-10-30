import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const baselinePath = path.join(
  root,
  "policies/retrieval-generality-baseline.json",
);
const monitoredFiles = [
  "packages/retrieval/src/support-verifier.ts",
  "packages/retrieval/src/query-planner.ts",
  "packages/retrieval/src/assertion-recall.ts",
];

function sourceLiterals(file, content) {
  const source = ts.createSourceFile(
    file,
    content,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (source.parseDiagnostics.length > 0)
    throw new Error(`Cannot parse ${file}`);
  const literals = new Set();
  function visit(node) {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isRegularExpressionLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      literals.add(node.getText(source));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...literals].sort();
}

const current = Object.fromEntries(
  monitoredFiles.map((file) => [
    file,
    sourceLiterals(file, readFileSync(path.join(root, file), "utf8")),
  ]),
);

// Verify that adding a new helper declaration is inspected by the scan.
const probe = sourceLiterals(
  "probe.ts",
  'function newHelper() { return "NEW_QUERY_ALIAS"; }',
);
if (!probe.includes('"NEW_QUERY_ALIAS"')) {
  throw new Error("Generality scan failed to inspect a new helper declaration");
}

if (process.argv.includes("--print-current")) {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 2, files: current }, null, 2)}\n`,
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
if (baseline.schemaVersion !== 2)
  throw new Error("Retrieval generality baseline schema must be version 2");
const failures = [];
for (const [file, literals] of Object.entries(current)) {
  const allowed = baseline.files?.[file];
  if (!Array.isArray(allowed)) {
    failures.push(`Missing baseline file: ${file}`);
    continue;
  }
  const additions = literals.filter((literal) => !allowed.includes(literal));
  if (additions.length > 0) {
    failures.push(
      `${file}: ${additions.length} new literal(s) outside baseline`,
    );
    for (const literal of additions) {
      failures.push(`  + ${literal}`);
    }
  }
}
if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.stderr.write(
    "Do not add query-specific vocabulary to generic retrieval runtime. See policies/retrieval-generality.md.\n",
  );
  process.exit(1);
}
process.stdout.write(
  "Retrieval generality policy passed: no new literals in monitored runtime files.\n",
);
