import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CodeGraphOptions,
  CodeGraphWarning,
  CodeSnapshot,
} from "@akp/contracts";

export const DEFAULT_CODE_GRAPH_EXCLUSIONS = [
  "**/node_modules/**",
  "**/vendor/**",
  "**/dist/**",
  "**/build/**",
  "**/generated/**",
  "**/coverage/**",
  "**/bin/**",
  "**/obj/**",
  "**/*.min.js",
  "**/*.min.css",
  "**/secrets/**",
  "**/*.pem",
  "**/*.key",
] as const;

export interface MaterializedCodeSnapshot {
  repositoryRoot: string;
  warnings: CodeGraphWarning[];
}

function graphifyError(code: string): Error {
  const value = new Error(code) as Error & { code?: string };
  value.code = code;
  return value;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitText(
  root: string,
  args: readonly string[],
  maxBuffer = 32 * 1024 * 1024,
) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer,
  });
}

function gitBuffer(root: string, args: readonly string[], maxBuffer: number) {
  return spawnSync("git", ["-C", root, ...args], {
    windowsHide: true,
    maxBuffer,
  });
}

function normalizeRelativePath(value: string): string {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    !normalized ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw graphifyError("CODE_GRAPH_PATH_ESCAPE");
  }
  return normalized.replace(/^\.\//, "");
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(".." + path.sep) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function escapeRegexCharacter(character: string): string {
  return "\\^$.*+?()[]{}|".includes(character) ? "\\" + character : character;
}

function globPattern(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let expression = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index]!;
    const next = normalized[index + 1];
    if (character === "*" && next === "*") {
      const after = normalized[index + 2];
      if (after === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
      continue;
    }
    if (character === "*") {
      expression += "[^/]*";
      continue;
    }
    if (character === "?") {
      expression += "[^/]";
      continue;
    }
    expression += escapeRegexCharacter(character);
  }
  expression += "$";
  return new RegExp(expression);
}

function excluded(relativePath: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globPattern(pattern).test(relativePath));
}

export async function materializeCodeSnapshot(
  snapshot: CodeSnapshot,
  options: CodeGraphOptions,
  workspace: string,
): Promise<MaterializedCodeSnapshot> {
  const repositoryPath = path.resolve(snapshot.repositoryPath);
  const verified = gitText(repositoryPath, [
    "rev-parse",
    "--verify",
    snapshot.commitSha + "^{commit}",
  ]);
  if (
    verified.status !== 0 ||
    String(verified.stdout).trim() !== snapshot.commitSha
  ) {
    throw graphifyError("CODE_SNAPSHOT_COMMIT_CHANGED");
  }

  const tree = gitText(repositoryPath, [
    "rev-parse",
    "--verify",
    snapshot.commitSha + "^{tree}",
  ]);
  if (tree.status !== 0 || String(tree.stdout).trim() !== snapshot.treeHash) {
    throw graphifyError("CODE_SNAPSHOT_TREE_CHANGED");
  }

  const listing = gitText(repositoryPath, [
    "ls-tree",
    "-r",
    "--full-tree",
    snapshot.commitSha,
  ]);
  if (listing.status !== 0) {
    throw graphifyError("CODE_SNAPSHOT_TREE_READ_FAILED");
  }
  const modes = new Map<string, string>();
  for (const line of String(listing.stdout).split(/\r?\n/).filter(Boolean)) {
    const match = /^(\d+)\s+\w+\s+[a-f0-9]+\t(.+)$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    modes.set(match[2].replaceAll("\\", "/"), match[1]);
  }

  const repositoryRoot = path.join(workspace, "repository");
  await mkdir(repositoryRoot, { recursive: true });
  const warnings: CodeGraphWarning[] = [];

  for (const file of [...snapshot.files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    const relativePath = normalizeRelativePath(file.path);
    if (excluded(relativePath, options.exclusions.patterns)) {
      warnings.push({
        code: "CODE_GRAPH_FILE_EXCLUDED",
        message: "File excluded by code graph policy.",
        path: relativePath,
      });
      continue;
    }
    if (file.bytes > options.exclusions.maxFileBytes) {
      warnings.push({
        code: "CODE_GRAPH_FILE_TOO_LARGE",
        message: "File exceeded the configured code graph size limit.",
        path: relativePath,
      });
      continue;
    }

    const mode = modes.get(relativePath);
    if (!mode) throw graphifyError("CODE_SNAPSHOT_FILE_MISSING");
    if (mode === "120000") {
      throw graphifyError("CODE_SNAPSHOT_SYMLINK_REJECTED");
    }
    if (mode !== "100644" && mode !== "100755") {
      throw graphifyError("CODE_SNAPSHOT_UNSUPPORTED_FILE_MODE");
    }

    const shown = gitBuffer(
      repositoryPath,
      ["show", snapshot.commitSha + ":" + relativePath],
      Math.max(options.exclusions.maxFileBytes + 1, 1024 * 1024),
    );
    if (shown.status !== 0 || !Buffer.isBuffer(shown.stdout)) {
      throw graphifyError("CODE_SNAPSHOT_BLOB_READ_FAILED");
    }
    if (shown.stdout.length > options.exclusions.maxFileBytes) {
      throw graphifyError("CODE_SNAPSHOT_BLOB_SIZE_CHANGED");
    }
    if (sha256(shown.stdout) !== file.contentHash) {
      throw graphifyError("CODE_SNAPSHOT_CONTENT_HASH_CHANGED");
    }

    const target = path.resolve(repositoryRoot, ...relativePath.split("/"));
    if (!pathInside(repositoryRoot, target)) {
      throw graphifyError("CODE_GRAPH_PATH_ESCAPE");
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, shown.stdout);
  }

  return { repositoryRoot, warnings };
}
