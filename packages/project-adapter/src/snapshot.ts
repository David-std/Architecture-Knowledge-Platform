import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import type { CodeEvidence, CodeLocator } from "./index.js";

export interface ProjectFileInventory {
  path: string;
  language: string;
  bytes: number;
  sha256: string;
  isTest: boolean;
}

export interface ProjectSymbolInventory {
  name: string;
  kind: string;
  locator: CodeLocator;
}

export interface ProjectDependencyEdge {
  fromPath: string;
  specifier: string;
  toPath: string | null;
  kind: "IMPORT" | "USING";
  line: number;
}

export interface ProjectTestLink {
  testPath: string;
  targetPath: string;
  evidence: "EXPLICIT_RELATIVE_IMPORT";
}

export interface ArchitectureRuleResult {
  rule: string;
  status: "PASSED" | "FAILED" | "WARNING";
  detail: string;
  paths: string[];
}

export interface ProjectSnapshot {
  repository: string;
  remote: string | null;
  commit: string;
  snapshotMode: "IMMUTABLE_GIT_COMMIT";
  files: ProjectFileInventory[];
  symbols: ProjectSymbolInventory[];
  dependencies: ProjectDependencyEdge[];
  testLinks: ProjectTestLink[];
  changedFiles: string[];
  architectureRules: ArchitectureRuleResult[];
  evidence: CodeEvidence[];
  truncated: boolean;
}

function git(root: string, args: string[], maxBuffer = 32 * 1024 * 1024) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
    maxBuffer,
  });
}

function language(file: string): string {
  const extension = path.posix.extname(file).toLowerCase();
  return (
    {
      ".java": "Java",
      ".cs": "CSharp",
      ".ts": "TypeScript",
      ".tsx": "TypeScriptReact",
      ".vue": "Vue",
      ".json": "JSON",
      ".xml": "XML",
      ".gradle": "Gradle",
      ".kts": "KotlinScript",
      ".csproj": "MSBuild",
    }[extension] ?? "BuildMetadata"
  );
}

function testFile(file: string): boolean {
  return /(^|\/)(__tests__|tests?|specs?)(\/|$)|(?:\.test|\.spec)\.[^.]+$|Test\.(java|cs)$/i.test(
    file,
  );
}

function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split(/\r?\n/).length;
}

function resolveRelativeImport(
  fromPath: string,
  specifier: string,
  files: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const unresolved = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromPath), specifier),
  );
  const candidates = [
    unresolved,
    ...[".ts", ".tsx", ".vue", ".java", ".cs"].map(
      (extension) => `${unresolved}${extension}`,
    ),
    ...["index.ts", "index.tsx", "index.vue"].map(
      (name) => `${unresolved}/${name}`,
    ),
  ];
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

export async function buildProjectSnapshot(input: {
  repositoryPath: string;
  commit: string;
  changedSince?: string;
}): Promise<ProjectSnapshot> {
  const root = path.resolve(input.repositoryPath);
  if (input.changedSince && !/^[a-f0-9]{40}$/i.test(input.changedSince)) {
    throw new Error("IMMUTABLE_CHANGED_SINCE_COMMIT_REQUIRED");
  }
  const verified = git(root, [
    "rev-parse",
    "--verify",
    `${input.commit}^{commit}`,
  ]);
  const commit = verified.status === 0 ? verified.stdout.trim() : "";
  if (!/^[a-f0-9]{40}$/i.test(commit))
    throw new Error("IMMUTABLE_GIT_COMMIT_REQUIRED");
  const changedSince = input.changedSince
    ? git(root, ["rev-parse", "--verify", `${input.changedSince}^{commit}`])
    : null;
  if (changedSince && changedSince.status !== 0) {
    throw new Error("IMMUTABLE_CHANGED_SINCE_COMMIT_REQUIRED");
  }
  const resolvedChangedSince = changedSince?.stdout.trim() || undefined;
  const listed = git(root, ["ls-tree", "-r", "--name-only", commit]);
  if (listed.status !== 0) throw new Error("PROJECT_TREE_READ_FAILED");
  const allFiles = listed.stdout
    .split(/\r?\n/)
    .filter((file) =>
      /(^|\/)(package\.json|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.csproj)$|\.(java|cs|ts|tsx|vue)$/i.test(
        file,
      ),
    )
    .sort();
  const selected = allFiles.slice(0, 5000);
  const fileSet = new Set(selected);
  const files: ProjectFileInventory[] = [];
  const symbols: ProjectSymbolInventory[] = [];
  const dependencies: ProjectDependencyEdge[] = [];
  for (const relativePath of selected) {
    const shown = git(
      root,
      ["show", `${commit}:${relativePath}`],
      16 * 1024 * 1024,
    );
    if (shown.status !== 0) continue;
    const content = shown.stdout;
    files.push({
      path: relativePath,
      language: language(relativePath),
      bytes: Buffer.byteLength(content),
      sha256: createHash("sha256").update(content).digest("hex"),
      isTest: testFile(relativePath),
    });
    const symbolPattern =
      /\b(class|interface|enum|type|function|record)\s+([A-Za-z_$][\w$]*)/g;
    for (const match of content.matchAll(symbolPattern)) {
      const startLine = lineAt(content, match.index ?? 0);
      symbols.push({
        name: String(match[2]),
        kind: String(match[1]).toUpperCase(),
        locator: {
          repository: root,
          commit,
          path: relativePath,
          startLine,
          endLine: startLine,
          symbol: String(match[2]),
        },
      });
    }
    const importPattern =
      /(?:\bfrom\s+|\bimport\s*\(|\brequire\s*\(|\bimport\s+)["']([^"']+)["']/g;
    for (const match of content.matchAll(importPattern)) {
      const specifier = String(match[1]);
      dependencies.push({
        fromPath: relativePath,
        specifier,
        toPath: resolveRelativeImport(relativePath, specifier, fileSet),
        kind: "IMPORT",
        line: lineAt(content, match.index ?? 0),
      });
    }
    const usingPattern = /^\s*using\s+([A-Za-z_][\w.]*)\s*;/gm;
    for (const match of content.matchAll(usingPattern)) {
      dependencies.push({
        fromPath: relativePath,
        specifier: String(match[1]),
        toPath: null,
        kind: "USING",
        line: lineAt(content, match.index ?? 0),
      });
    }
  }
  const testLinks = dependencies.flatMap((edge) =>
    testFile(edge.fromPath) && edge.toPath
      ? [
          {
            testPath: edge.fromPath,
            targetPath: edge.toPath,
            evidence: "EXPLICIT_RELATIVE_IMPORT" as const,
          },
        ]
      : [],
  );
  const changed = resolvedChangedSince
    ? git(root, ["diff", "--name-only", `${resolvedChangedSince}..${commit}`])
    : null;
  const changedFiles =
    changed?.status === 0
      ? changed.stdout.split(/\r?\n/).filter(Boolean).sort()
      : [];
  const productionTests = files.filter(
    (file) => file.isTest && /(^|\/)src\/(main|app)\//i.test(file.path),
  );
  const architectureRules: ArchitectureRuleResult[] = [
    {
      rule: "IMMUTABLE_GIT_COMMIT",
      status: "PASSED",
      detail: `All inventory content was read from ${commit}.`,
      paths: [],
    },
    {
      rule: "NO_TEST_FILES_IN_PRODUCTION_ROOT",
      status: productionTests.length ? "FAILED" : "PASSED",
      detail: productionTests.length
        ? "Test-named files were found under a production source root."
        : "No test-named files were found under a production source root.",
      paths: productionTests.map((file) => file.path),
    },
    {
      rule: "INVENTORY_LIMIT",
      status: allFiles.length > selected.length ? "WARNING" : "PASSED",
      detail: `${selected.length} of ${allFiles.length} eligible files inventoried.`,
      paths: [],
    },
  ];
  const remoteResult = git(root, ["config", "--get", "remote.origin.url"]);
  const { DeterministicProjectAdapter } = await import("./index.js");
  const evidence = await new DeterministicProjectAdapter().scan({
    ...input,
    commit,
    ...(resolvedChangedSince ? { changedSince: resolvedChangedSince } : {}),
  });
  return {
    repository: root,
    remote:
      remoteResult.status === 0 ? remoteResult.stdout.trim() || null : null,
    commit,
    snapshotMode: "IMMUTABLE_GIT_COMMIT",
    files,
    symbols,
    dependencies,
    testLinks,
    changedFiles,
    architectureRules,
    evidence,
    truncated: allFiles.length > selected.length,
  };
}
