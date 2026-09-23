import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  CodeChangeSet as CodeChangeSetSchema,
  type CodeChangeSet,
} from "@akp/contracts";

const COMMIT = /^[a-f0-9]{40}$/i;
const MAX_DIFF_BYTES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_CHANGED_FILES = 2_000;

export interface CodeDeltaSymbol {
  path: string;
  kind: string;
  name: string;
  lineStart: number;
}

export interface CodeCommitDelta {
  baseSha: string;
  headSha: string;
  changeSet: CodeChangeSet;
  changedSymbols: CodeDeltaSymbol[];
  removedSymbols: CodeDeltaSymbol[];
  addedSymbols: CodeDeltaSymbol[];
  warnings: string[];
}

function deltaError(code: string): Error {
  const error = new Error(code) as Error & { code?: string };
  error.code = code;
  return error;
}

function git(root: string, args: string[], maxBuffer = MAX_DIFF_BYTES) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer,
  });
}

function verifiedCommit(root: string, value: string, code: string): string {
  if (!COMMIT.test(value)) throw deltaError(code);
  const result = git(root, ["rev-parse", "--verify", `${value}^{commit}`]);
  const resolved = result.status === 0 ? result.stdout.trim() : "";
  if (!COMMIT.test(resolved)) throw deltaError(code);
  return resolved.toLowerCase();
}

function safePath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized) ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw deltaError("CODE_DELTA_PATH_INVALID");
  }
  return path.posix.normalize(normalized);
}

function parseNameStatus(value: string): CodeChangeSet {
  const tokens = value.split("\0");
  if (tokens.at(-1) === "") tokens.pop();
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];

  let index = 0;
  while (index < tokens.length) {
    const status = tokens[index++] ?? "";
    if (!status) throw deltaError("CODE_DELTA_STATUS_INVALID");
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const from = tokens[index++];
      const to = tokens[index++];
      if (from === undefined || to === undefined) {
        throw deltaError("CODE_DELTA_STATUS_INVALID");
      }
      renamed.push({ from: safePath(from), to: safePath(to) });
      continue;
    }
    const file = tokens[index++];
    if (file === undefined) throw deltaError("CODE_DELTA_STATUS_INVALID");
    const normalized = safePath(file);
    if (kind === "A") added.push(normalized);
    else if (kind === "D") deleted.push(normalized);
    else if (kind === "M" || kind === "T") modified.push(normalized);
    else throw deltaError("CODE_DELTA_STATUS_UNSUPPORTED");
  }

  const total =
    added.length + modified.length + deleted.length + renamed.length;
  if (total > MAX_CHANGED_FILES) {
    throw deltaError("CODE_DELTA_FILE_COUNT_LIMIT");
  }
  return CodeChangeSetSchema.parse({
    fromCommitSha: "0".repeat(40),
    toCommitSha: "0".repeat(40),
    added: [...new Set(added)].sort(),
    modified: [...new Set(modified)].sort(),
    deleted: [...new Set(deleted)].sort(),
    renamed: renamed
      .filter(
        (entry, position, values) =>
          values.findIndex(
            (candidate) =>
              candidate.from === entry.from && candidate.to === entry.to,
          ) === position,
      )
      .sort(
        (left, right) =>
          left.from.localeCompare(right.from) ||
          left.to.localeCompare(right.to),
      ),
  });
}

function sourceAt(
  root: string,
  commit: string,
  file: string,
): { content: string | null; warning?: string } {
  const result = git(root, ["show", `${commit}:${file}`], MAX_SOURCE_BYTES);
  if (result.status !== 0) {
    return { content: null, warning: `SOURCE_UNAVAILABLE:${file}` };
  }
  if (Buffer.byteLength(result.stdout) > MAX_SOURCE_BYTES) {
    return { content: null, warning: `SOURCE_LIMIT:${file}` };
  }
  return { content: result.stdout };
}

function symbols(pathValue: string, content: string): CodeDeltaSymbol[] {
  const found: CodeDeltaSymbol[] = [];
  const pattern =
    /\b(class|interface|enum|type|function|record)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of content.matchAll(pattern)) {
    found.push({
      path: pathValue,
      kind: String(match[1]).toUpperCase(),
      name: String(match[2]),
      lineStart: content.slice(0, match.index ?? 0).split(/\r?\n/).length,
    });
  }
  return found.sort((left, right) =>
    [left.path, left.kind, left.name, left.lineStart]
      .join("|")
      .localeCompare(
        [right.path, right.kind, right.name, right.lineStart].join("|"),
      ),
  );
}

function key(symbol: Pick<CodeDeltaSymbol, "kind" | "name">): string {
  return `${symbol.kind}\0${symbol.name}`;
}

export function computeCodeCommitDelta(input: {
  repositoryPath: string;
  baseSha: string;
  headSha: string;
}): CodeCommitDelta {
  const root = path.resolve(input.repositoryPath);
  const baseSha = verifiedCommit(
    root,
    input.baseSha,
    "CODE_DELTA_BASE_COMMIT_INVALID",
  );
  const headSha = verifiedCommit(
    root,
    input.headSha,
    "CODE_DELTA_HEAD_COMMIT_INVALID",
  );
  if (baseSha === headSha) throw deltaError("CODE_DELTA_COMMITS_IDENTICAL");

  const diff = git(root, [
    "diff",
    "--name-status",
    "-z",
    "--find-renames=50%",
    "--no-ext-diff",
    baseSha,
    headSha,
    "--",
  ]);
  if (diff.status !== 0) throw deltaError("CODE_DELTA_GIT_DIFF_FAILED");
  const parsed = parseNameStatus(diff.stdout);
  const changeSet = CodeChangeSetSchema.parse({
    ...parsed,
    fromCommitSha: baseSha,
    toCommitSha: headSha,
  });

  const warnings: string[] = [];
  const changedSymbols: CodeDeltaSymbol[] = [];
  const removedSymbols: CodeDeltaSymbol[] = [];
  const addedSymbols: CodeDeltaSymbol[] = [];

  for (const file of changeSet.modified) {
    const [before, after] = [
      sourceAt(root, baseSha, file),
      sourceAt(root, headSha, file),
    ];
    if (before.warning) warnings.push(before.warning);
    if (after.warning) warnings.push(after.warning);
    if (before.content === null || after.content === null) continue;
    const beforeSymbols = symbols(file, before.content);
    const afterSymbols = symbols(file, after.content);
    const beforeKeys = new Set(beforeSymbols.map(key));
    const afterKeys = new Set(afterSymbols.map(key));
    changedSymbols.push(
      ...afterSymbols.filter((symbol) => beforeKeys.has(key(symbol))),
    );
    removedSymbols.push(
      ...beforeSymbols.filter((symbol) => !afterKeys.has(key(symbol))),
    );
    addedSymbols.push(
      ...afterSymbols.filter((symbol) => !beforeKeys.has(key(symbol))),
    );
  }

  for (const file of changeSet.deleted) {
    const before = sourceAt(root, baseSha, file);
    if (before.warning) warnings.push(before.warning);
    if (before.content !== null)
      removedSymbols.push(...symbols(file, before.content));
  }
  for (const file of changeSet.added) {
    const after = sourceAt(root, headSha, file);
    if (after.warning) warnings.push(after.warning);
    if (after.content !== null)
      addedSymbols.push(...symbols(file, after.content));
  }
  for (const rename of changeSet.renamed) {
    const [before, after] = [
      sourceAt(root, baseSha, rename.from),
      sourceAt(root, headSha, rename.to),
    ];
    if (before.warning) warnings.push(before.warning);
    if (after.warning) warnings.push(after.warning);
    if (before.content === null || after.content === null) continue;
    const beforeSymbols = symbols(rename.from, before.content);
    const afterSymbols = symbols(rename.to, after.content);
    const beforeKeys = new Set(beforeSymbols.map(key));
    const afterKeys = new Set(afterSymbols.map(key));
    changedSymbols.push(
      ...afterSymbols.filter((symbol) => beforeKeys.has(key(symbol))),
    );
    removedSymbols.push(
      ...beforeSymbols.filter((symbol) => !afterKeys.has(key(symbol))),
    );
    addedSymbols.push(
      ...afterSymbols.filter((symbol) => !beforeKeys.has(key(symbol))),
    );
  }

  const unique = (values: CodeDeltaSymbol[]) =>
    values
      .filter(
        (value, position, all) =>
          all.findIndex(
            (candidate) =>
              candidate.path === value.path &&
              candidate.kind === value.kind &&
              candidate.name === value.name &&
              candidate.lineStart === value.lineStart,
          ) === position,
      )
      .sort((left, right) =>
        [left.path, left.kind, left.name, left.lineStart]
          .join("|")
          .localeCompare(
            [right.path, right.kind, right.name, right.lineStart].join("|"),
          ),
      );

  return {
    baseSha,
    headSha,
    changeSet,
    changedSymbols: unique(changedSymbols),
    removedSymbols: unique(removedSymbols),
    addedSymbols: unique(addedSymbols),
    warnings: [...new Set(warnings)].sort(),
  };
}
