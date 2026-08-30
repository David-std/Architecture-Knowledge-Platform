import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export interface GoldCase {
  id: string;
  category: string;
  query: string;
  gold_documents: string[];
  /** Optional evidence-level labels for genuine evidence-recall scoring. */
  gold_evidence?: string[];
  /** Optional citation-level labels for genuine citation-precision scoring. */
  gold_citations?: string[];
  must_not_include?: string[];
  expect_no_answer?: boolean;
  critical?: boolean;
  slice?: string;
  /** Optional local fixture scope; absent for corpus-agnostic cases. */
  vault?: string;
}

/** Core slices that must remain present in the generic pack. */
export const REQUIRED_GENERIC_SLICES = Object.freeze([
  "exact-identifiers",
  "paraphrases",
  "synonyms",
  "cross-language",
  "comparisons",
  "workflow-selection",
  "source-verification",
  "code-evidence",
  "stale-data",
  "contradictions",
  "no-answer",
  "multi-vault-isolation",
  "global-synthesis",
  "vector-disabled",
] as const);

const safePackName = /^[a-z0-9][a-z0-9-]{1,62}$/;
const genericLeakageTerms = [
  ["SI", "729"].join(""),
  ["SI", "730"].join(""),
  ["U", "PC"].join(""),
  ["WF-DDD-END-", "TO-END"].join(""),
  ["cqrs-capability-", "model"].join(""),
  ["resources-is-", "layer"].join(""),
  "eventstorming",
];

function containsGenericLeakage(value: unknown): boolean {
  const serialized = JSON.stringify(value).toLocaleLowerCase();
  // Match both ordinary token spelling and separators inserted
  // into identifiers (e.g. `SI 729` or `event storming`).  This keeps the
  // generic pack portable without banning unrelated words that merely contain
  // a short token as a substring.
  const tokens = serialized.match(/[a-z0-9]+/g) ?? [];
  return genericLeakageTerms.some((term) => {
    const normalized = term.toLocaleLowerCase();
    const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const compactTarget = normalized.replace(/[^a-z0-9]+/g, "");
    const separatorInsensitive = tokens.some((_, index) =>
      tokens
        .slice(index, index + 4)
        .some(
          (__, offset) =>
            tokens.slice(index, index + offset + 1).join("") === compactTarget,
        ),
    );
    return (
      new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "i").test(
        serialized,
      ) || separatorInsensitive
    );
  });
}

async function jsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push(absolute);
    }
  };
  try {
    await visit(root);
  } catch (error) {
    // Some checked-in fixtures are kept flat so a constrained checkout can
    // add one pack without creating a directory entry.  The fallback is
    // prefix-scoped and never broadens a pack to unrelated JSONL files.
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
    const parent = path.dirname(root);
    const prefix = `${path.basename(root)}-`;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (
        entry.isFile() &&
        entry.name.startsWith(prefix) &&
        entry.name.endsWith(".jsonl")
      ) {
        files.push(path.join(parent, entry.name));
      }
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function validateCase(candidate: unknown, source: string): GoldCase {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(
      `Invalid evaluation case in ${source}: expected an object.`,
    );
  }
  const value = candidate as Record<string, unknown>;
  const allowedKeys = new Set([
    "id",
    "category",
    "query",
    "gold_documents",
    "gold_evidence",
    "gold_citations",
    "must_not_include",
    "expect_no_answer",
    "critical",
    "slice",
    "vault",
  ]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unknownKeys.length > 0) {
    throw new Error(
      `Invalid evaluation case fields in ${source}: ${unknownKeys.join(", ")}`,
    );
  }
  if (
    typeof value.id !== "string" ||
    typeof value.category !== "string" ||
    typeof value.query !== "string" ||
    !Array.isArray(value.gold_documents) ||
    !value.gold_documents.every((entry) => typeof entry === "string") ||
    new Set(value.gold_documents).size !== value.gold_documents.length
  ) {
    throw new Error(`Invalid evaluation case contract in ${source}.`);
  }
  if (
    value.must_not_include !== undefined &&
    (!Array.isArray(value.must_not_include) ||
      !value.must_not_include.every((entry) => typeof entry === "string") ||
      new Set(value.must_not_include).size !== value.must_not_include.length)
  ) {
    throw new Error(`Invalid negative expectations in ${source}.`);
  }
  for (const field of ["gold_evidence", "gold_citations"] as const) {
    const candidate = value[field];
    if (
      candidate !== undefined &&
      (!Array.isArray(candidate) ||
        !candidate.every((entry) => typeof entry === "string") ||
        new Set(candidate).size !== candidate.length)
    ) {
      throw new Error(`Invalid ${field} labels in ${source}.`);
    }
  }
  return {
    id: value.id,
    category: value.category,
    query: value.query,
    gold_documents: value.gold_documents,
    ...(Array.isArray(value.gold_evidence)
      ? { gold_evidence: value.gold_evidence as string[] }
      : {}),
    ...(Array.isArray(value.gold_citations)
      ? { gold_citations: value.gold_citations as string[] }
      : {}),
    ...(Array.isArray(value.must_not_include)
      ? { must_not_include: value.must_not_include as string[] }
      : {}),
    ...(typeof value.expect_no_answer === "boolean"
      ? { expect_no_answer: value.expect_no_answer }
      : {}),
    ...(typeof value.critical === "boolean"
      ? { critical: value.critical }
      : {}),
    ...(typeof value.slice === "string" ? { slice: value.slice } : {}),
    ...(typeof value.vault === "string" ? { vault: value.vault } : {}),
  };
}

export async function loadEvaluationPack(
  repositoryRoot: string,
  packName: string,
): Promise<GoldCase[]> {
  if (!safePackName.test(packName)) {
    throw new Error(`Invalid evaluation pack name: ${packName}`);
  }
  const packRoot =
    packName === "generic"
      ? path.join(repositoryRoot, "evals", "generic")
      : path.join(repositoryRoot, "evals", "fixtures", packName);
  const files = await jsonlFiles(packRoot);
  if (files.length === 0) {
    throw new Error(`Evaluation pack has no JSONL cases: ${packName}`);
  }
  const cases: GoldCase[] = [];
  const ids = new Set<string>();
  for (const file of files) {
    const lines = (await readFile(file, "utf8"))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const [index, line] of lines.entries()) {
      const source = `${path.relative(repositoryRoot, file)}:${index + 1}`;
      const parsed = validateCase(JSON.parse(line) as unknown, source);
      if (packName === "generic" && parsed.vault !== undefined) {
        throw new Error(
          `Generic evaluation case cannot declare a vault scope: ${source}`,
        );
      }
      if (packName === "generic" && containsGenericLeakage(parsed)) {
        throw new Error(
          `Generic evaluation case contains vault-specific data: ${source}`,
        );
      }
      if (ids.has(parsed.id))
        throw new Error(`Duplicate evaluation case id: ${parsed.id}`);
      ids.add(parsed.id);
      cases.push(parsed);
    }
  }
  if (packName === "generic") {
    const available = new Set(
      cases.map((testCase) => testCase.slice ?? testCase.category),
    );
    const missing = REQUIRED_GENERIC_SLICES.filter(
      (slice) => !available.has(slice),
    );
    if (missing.length > 0) {
      throw new Error(
        `Generic evaluation pack is missing required slices: ${missing.join(", ")}`,
      );
    }
  }
  return cases;
}
