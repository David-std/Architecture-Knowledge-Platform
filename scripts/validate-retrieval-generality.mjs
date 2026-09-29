import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const baselinePath = path.join(
  root,
  "policies/retrieval-generality-baseline.json",
);
const monitored = {
  "packages/retrieval/src/support-verifier.ts": {
    functions: [
      "canonicalSemanticToken",
      "globalRelationScopePresent",
      "queryExplicitlyRequestsQuantity",
      "queryExplicitlyRequestsRule",
      "queryAnswerCues",
      "explicitlyLinkedContinuation",
      "queryPredicateAnchors",
      "queryYesNoRelationRoles",
      "quantitativeEvidenceMatches",
      "dateYearEvidenceMatches",
    ],
    constants: [
      "ANSWERABILITY_STOPWORDS",
      "QUERY_CUE_PATTERNS",
      "PASSAGE_CUE_PATTERNS",
      "QUESTION_SHAPE_TOKENS",
      "RELATION_GRAMMAR_TOKENS",
      "PREDICATE_GRAMMAR_TOKENS",
      "YES_NO_RELATION_PREDICATES",
      "CUE_TOKENS_THAT_REMAIN_PREDICATE_ANCHORS",
    ],
  },
  "packages/retrieval/src/query-planner.ts": {
    functions: ["looksLikeProjectCodeRequest", "classifyQueryShape"],
    constants: ["exactPattern", "codeShapePattern"],
  },
};

function literalsIn(node) {
  const literals = new Set();
  function visit(current) {
    if (
      ts.isStringLiteral(current) ||
      ts.isNoSubstitutionTemplateLiteral(current) ||
      ts.isRegularExpressionLiteral(current)
    ) {
      literals.add(current.getText());
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  return [...literals].sort();
}

function sourceDeclarations(file, watched) {
  const source = ts.createSourceFile(
    file,
    readFileSync(path.join(root, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  if (source.parseDiagnostics.length > 0) {
    throw new Error(`Cannot parse ${file}`);
  }

  const found = {};
  for (const statement of source.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name &&
      watched.functions.includes(statement.name.text)
    ) {
      found[`function:${statement.name.text}`] = literalsIn(statement);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isIdentifier(declaration.name) &&
          watched.constants.includes(declaration.name.text)
        ) {
          found[`constant:${declaration.name.text}`] = literalsIn(declaration);
        }
      }
    }
  }

  for (const name of watched.functions) {
    if (!Object.hasOwn(found, `function:${name}`)) {
      throw new Error(`Monitored function missing: ${file}:${name}`);
    }
  }
  for (const name of watched.constants) {
    if (!Object.hasOwn(found, `constant:${name}`)) {
      throw new Error(`Monitored constant missing: ${file}:${name}`);
    }
  }
  return found;
}

const current = Object.fromEntries(
  Object.entries(monitored).map(([file, watched]) => [
    file,
    sourceDeclarations(file, watched),
  ]),
);

if (process.argv.includes("--print-current")) {
  process.stdout.write(`${JSON.stringify(current, null, 2)}\n`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const failures = [];
for (const [file, declarations] of Object.entries(current)) {
  for (const [name, literals] of Object.entries(declarations)) {
    const allowed = baseline[file]?.[name];
    if (!Array.isArray(allowed)) {
      failures.push(`Missing baseline declaration: ${file}:${name}`);
      continue;
    }
    for (const literal of literals) {
      if (!allowed.includes(literal)) {
        failures.push(
          `New hard-coded query literal: ${file}:${name}: ${literal}`,
        );
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) process.stderr.write(`${failure}\n`);
  process.stderr.write(
    "Keep source-specific vocabulary in evaluation fixtures or explicit profiles, not generic retrieval runtime. See policies/retrieval-generality.md.\n",
  );
  process.exit(1);
}

process.stdout.write(
  "Retrieval generality policy passed: no new literals in monitored query heuristics.\n",
);
