import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CodeGraphArtifact as CodeGraphArtifactSchema,
  CodeLocator as CodeLocatorSchema,
  CodeRuntimeCoverageArtifact as CodeRuntimeCoverageArtifactSchema,
  CodeRuntimeCoverageLink as CodeRuntimeCoverageLinkSchema,
  CodeSnapshot as CodeSnapshotSchema,
} from "@akp/contracts";
import type {
  CodeGraphArtifact,
  CodeGraphWarning,
  CodeLocator,
  CodeRuntimeCoverageArtifact,
  CodeRuntimeCoverageLink,
  CodeSnapshot,
} from "@akp/contracts";

interface V8Range {
  startOffset?: unknown;
  endOffset?: unknown;
  count?: unknown;
}

interface V8Function {
  functionName?: unknown;
  ranges?: unknown;
}

interface V8Script {
  url?: unknown;
  functions?: unknown;
}

interface V8CoverageFile {
  result?: unknown;
}

function coverageError(code: string): Error {
  const value = new Error(code) as Error & { code?: string };
  value.code = code;
  return value;
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

function normalizedRelativePath(root: string, candidate: string): string {
  const absolute = path.resolve(candidate);
  if (!pathInside(root, absolute)) {
    throw coverageError("CODE_RUNTIME_COVERAGE_PATH_ESCAPE");
  }
  const relative = path.relative(root, absolute).replaceAll("\\", "/");
  if (!relative || relative === ".") {
    throw coverageError("CODE_RUNTIME_COVERAGE_FILE_REQUIRED");
  }
  return relative;
}

function positiveCount(value: unknown): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
    ? value
    : 0;
}

function parseCoverageFile(value: unknown): V8Script[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw coverageError("CODE_RUNTIME_COVERAGE_JSON_INVALID");
  }
  const result = (value as V8CoverageFile).result;
  if (!Array.isArray(result)) {
    throw coverageError("CODE_RUNTIME_COVERAGE_RESULT_INVALID");
  }
  return result.filter(
    (entry): entry is V8Script =>
      Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
  );
}

export interface NodeV8CoverageInput {
  snapshot: CodeSnapshot;
  coverageDirectory: string;
  executedTest: CodeLocator;
  providerVersion?: string;
  maxCoverageBytes?: number;
}

export async function readNodeV8Coverage(
  rawInput: NodeV8CoverageInput,
): Promise<CodeRuntimeCoverageArtifact> {
  const snapshot = CodeSnapshotSchema.parse(rawInput.snapshot);
  const executedTest = CodeLocatorSchema.parse(rawInput.executedTest);
  if (
    executedTest.repository !== snapshot.repository ||
    executedTest.commitSha !== snapshot.commitSha
  ) {
    throw coverageError("CODE_RUNTIME_REVISION_MISMATCH");
  }
  const testFile = snapshot.files.find(
    (file) => file.path === executedTest.path.replaceAll("\\", "/"),
  );
  if (!testFile) {
    throw coverageError("CODE_RUNTIME_TEST_OUTSIDE_SNAPSHOT");
  }
  if (
    executedTest.contentHash &&
    executedTest.contentHash !== testFile.contentHash
  ) {
    throw coverageError("CODE_RUNTIME_TEST_HASH_MISMATCH");
  }

  const coverageDirectory = path.resolve(rawInput.coverageDirectory);
  const entries = await readdir(coverageDirectory, { withFileTypes: true });
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(coverageDirectory, entry.name))
    .sort();
  if (jsonFiles.length === 0) {
    throw coverageError("CODE_RUNTIME_COVERAGE_EMPTY");
  }
  const maxCoverageBytes = rawInput.maxCoverageBytes ?? 64 * 1024 * 1024;
  let totalBytes = 0;
  const fileByPath = new Map(
    snapshot.files.map((file) => [file.path.replaceAll("\\", "/"), file]),
  );
  const aggregate = new Map<
    string,
    {
      path: string;
      contentHash: string;
      functionName: string;
      executionCount: number;
      coveredRanges: number;
    }
  >;
  const warnings: CodeGraphWarning[] = [];

  for (const filePath of jsonFiles) {
    const metadata = await stat(filePath);
    totalBytes += metadata.size;
    if (totalBytes > maxCoverageBytes) {
      throw coverageError("CODE_RUNTIME_COVERAGE_SIZE_LIMIT");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, "utf8"));
    } catch (cause) {
      const failure = coverageError(
        "CODE_RUNTIME_COVERAGE_JSON_INVALID",
      ) as Error & { cause?: unknown };
      failure.cause = cause;
      throw failure;
    }

    for (const script of parseCoverageFile(parsed)) {
      if (typeof script.url !== "string" || !script.url.startsWith("file:")) {
        continue;
      }
      let absoluteScript: string;
      try {
        absoluteScript = fileURLToPath(script.url);
      } catch {
        warnings.push({
          code: "CODE_RUNTIME_COVERAGE_URL_INVALID",
          message: "Coverage entry used an invalid file URL.",
        });
        continue;
      }
      if (!pathInside(path.resolve(snapshot.repositoryPath), absoluteScript)) {
        continue;
      }
      const relativePath = normalizedRelativePath(
        path.resolve(snapshot.repositoryPath),
        absoluteScript,
      );
      const snapshotFile = fileByPath.get(relativePath);
      if (!snapshotFile) continue;
      if (!Array.isArray(script.functions)) continue;

      for (const rawFunction of script.functions as V8Function[]) {
        if (
          !rawFunction ||
          typeof rawFunction !== "object" ||
          Array.isArray(rawFunction) ||
          typeof rawFunction.functionName !== "string"
        ) {
          continue;
        }
        const functionName = rawFunction.functionName.trim();
        if (!functionName || !Array.isArray(rawFunction.ranges)) continue;
        const executedRanges = (rawFunction.ranges as V8Range[])
          .map((range) => positiveCount(range?.count))
          .filter((count) => count > 0);
        if (executedRanges.length === 0) continue;
        const executionCount = executedRanges.reduce(
          (total, count) => total + count,
          0,
        );
        const key = relativePath + "\0" + functionName;
        const previous = aggregate.get(key);
        aggregate.set(key, {
          path: relativePath,
          contentHash: snapshotFile.contentHash,
          functionName,
          executionCount:
            (previous?.executionCount ?? 0) + executionCount,
          coveredRanges:
            (previous?.coveredRanges ?? 0) + executedRanges.length,
        });
      }
    }
  }

  return CodeRuntimeCoverageArtifactSchema.parse({
    schemaVersion: 1,
    repository: snapshot.repository,
    commitSha: snapshot.commitSha,
    provider: "node-v8",
    providerVersion: rawInput.providerVersion ?? process.version,
    generatedAt: new Date().toISOString(),
    executedTest: {
      ...executedTest,
      contentHash: testFile.contentHash,
    },
    functions: [...aggregate.values()].sort((left, right) =>
      (left.path + "|" + left.functionName).localeCompare(
        right.path + "|" + right.functionName,
      ),
    ),
    warnings,
  });
}

export interface RuntimeCoverageLinkResult {
  links: CodeRuntimeCoverageLink[];
  warnings: CodeGraphWarning[];
}

export function linkRuntimeCoverage(
  rawGraph: CodeGraphArtifact,
  rawCoverage: CodeRuntimeCoverageArtifact,
): RuntimeCoverageLinkResult {
  const graph = CodeGraphArtifactSchema.parse(rawGraph);
  const coverage = CodeRuntimeCoverageArtifactSchema.parse(rawCoverage);
  if (
    graph.repository !== coverage.repository ||
    graph.commitSha !== coverage.commitSha
  ) {
    throw coverageError("CODE_RUNTIME_REVISION_MISMATCH");
  }

  const warnings: CodeGraphWarning[] = [...coverage.warnings];
  const links: CodeRuntimeCoverageLink[] = [];
  for (const covered of coverage.functions) {
    const matches = graph.nodes.filter(
      (node) =>
        node.path === covered.path &&
        (node.name === covered.functionName ||
          node.qualifiedName === covered.functionName),
    );
    if (matches.length === 0) {
      warnings.push({
        code: "CODE_RUNTIME_SYMBOL_NOT_FOUND",
        message:
          "Executed function could not be mapped to a canonical code symbol.",
        path: covered.path,
        extensions: { functionName: covered.functionName },
      });
      continue;
    }
    if (matches.length > 1) {
      warnings.push({
        code: "CODE_RUNTIME_SYMBOL_AMBIGUOUS",
        message:
          "Executed function matched multiple canonical symbols and was not upgraded.",
        path: covered.path,
        extensions: {
          functionName: covered.functionName,
          candidateNodeIds: matches.map((node) => node.id),
        },
      });
      continue;
    }
    links.push(
      CodeRuntimeCoverageLinkSchema.parse({
        nodeId: matches[0]!.id,
        tier: "RUNTIME_COVERED",
        repository: graph.repository,
        commitSha: graph.commitSha,
        executedTest: coverage.executedTest,
        executionCount: covered.executionCount,
      }),
    );
  }
  return {
    links: links.sort((left, right) => left.nodeId.localeCompare(right.nodeId)),
    warnings,
  };
}
