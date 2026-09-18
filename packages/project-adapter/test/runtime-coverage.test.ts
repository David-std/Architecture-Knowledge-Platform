import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CodeGraphArtifact } from "@akp/contracts";
import {
  createCodeSnapshot,
  linkRuntimeCoverage,
  readNodeV8Coverage,
} from "../src/index.js";

const roots: string[] = [];

async function runtimeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "akp-runtime-coverage-"));
  roots.push(root);
  const run = (...args: string[]) =>
    spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  expect(run("init", "-b", "main").status).toBe(0);
  expect(run("config", "user.name", "AKP Coverage Test").status).toBe(0);
  expect(run("config", "user.email", "akp-coverage@localhost").status).toBe(0);

  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(
    path.join(root, "src", "math.js"),
    "export function add(a, b) { return a + b; }\n",
  );
  await writeFile(
    path.join(root, "test", "run.js"),
    [
      'import { add } from "../src/math.js";',
      "if (add(2, 3) !== 5) process.exit(9);",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  expect(run("add", ".").status).toBe(0);
  expect(run("commit", "-m", "runtime fixture").status).toBe(0);
  const commit = run("rev-parse", "HEAD").stdout.trim();
  const snapshot = await createCodeSnapshot({
    repositoryPath: root,
    commit,
  });
  const coverageDirectory = path.join(root, ".coverage");
  await mkdir(coverageDirectory, { recursive: true });
  const executed = spawnSync(process.execPath, ["test/run.js"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_V8_COVERAGE: coverageDirectory,
    },
  });
  expect(executed.status, executed.stderr).toBe(0);
  return { root, commit, snapshot, coverageDirectory };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true }).catch(() => undefined),
    ),
  );
});

describe("runtime coverage evidence", () => {
  it("upgrades one unambiguous symbol only after executed coverage at the same revision", async () => {
    const fixture = await runtimeFixture();
    const testFile = fixture.snapshot.files.find(
      (file) => file.path === "test/run.js",
    );
    const sourceFile = fixture.snapshot.files.find(
      (file) => file.path === "src/math.js",
    );
    expect(testFile).toBeDefined();
    expect(sourceFile).toBeDefined();

    const coverage = await readNodeV8Coverage({
      snapshot: fixture.snapshot,
      coverageDirectory: fixture.coverageDirectory,
      executedTest: {
        repository: fixture.snapshot.repository,
        commitSha: fixture.commit,
        path: "test/run.js",
        startLine: 1,
        endLine: 2,
        contentHash: testFile!.contentHash,
      },
    });
    expect(coverage.functions).toContainEqual(
      expect.objectContaining({
        path: "src/math.js",
        functionName: "add",
        contentHash: sourceFile!.contentHash,
      }),
    );

    const graph: CodeGraphArtifact = {
      schemaVersion: 1,
      repository: fixture.snapshot.repository,
      commitSha: fixture.commit,
      provider: "graphify",
      providerVersion: "fixture",
      configurationHash: "a".repeat(64),
      generatedAt: new Date().toISOString(),
      languages: ["JavaScript"],
      nodes: [
        {
          id: "CODE-" + "1".repeat(32),
          kind: "FUNCTION",
          name: "add",
          qualifiedName: "add",
          language: "JavaScript",
          path: "src/math.js",
          lineStart: 1,
          lineEnd: 1,
          contentHash: sourceFile!.contentHash,
        },
      ],
      edges: [],
      warnings: [],
    };
    const linked = linkRuntimeCoverage(graph, coverage);
    expect(linked.links).toEqual([
      expect.objectContaining({
        nodeId: graph.nodes[0]!.id,
        tier: "RUNTIME_COVERED",
        repository: graph.repository,
        commitSha: fixture.commit,
      }),
    ]);
    expect(linked.links[0]!.executionCount).toBeGreaterThan(0);

    expect(() =>
      linkRuntimeCoverage(
        { ...graph, commitSha: "f".repeat(40) },
        coverage,
      ),
    ).toThrow("CODE_RUNTIME_REVISION_MISMATCH");
  });

  it("does not upgrade ambiguous same-file symbols", async () => {
    const fixture = await runtimeFixture();
    const coverage = await readNodeV8Coverage({
      snapshot: fixture.snapshot,
      coverageDirectory: fixture.coverageDirectory,
      executedTest: {
        repository: fixture.snapshot.repository,
        commitSha: fixture.commit,
        path: "test/run.js",
      },
    });
    const sourceFile = fixture.snapshot.files.find(
      (file) => file.path === "src/math.js",
    )!;
    const graph: CodeGraphArtifact = {
      schemaVersion: 1,
      repository: fixture.snapshot.repository,
      commitSha: fixture.commit,
      provider: "graphify",
      providerVersion: "fixture",
      configurationHash: "b".repeat(64),
      generatedAt: new Date().toISOString(),
      languages: ["JavaScript"],
      nodes: [1, 2].map((index) => ({
        id: "CODE-" + String(index).repeat(32),
        kind: "FUNCTION" as const,
        name: "add",
        qualifiedName: "add",
        signature: index === 1 ? "add(number,number)" : "add(any,any)",
        language: "JavaScript",
        path: "src/math.js",
        lineStart: 1,
        lineEnd: 1,
        contentHash: sourceFile.contentHash,
      })),
      edges: [],
      warnings: [],
    };

    const linked = linkRuntimeCoverage(graph, coverage);
    expect(linked.links).toHaveLength(0);
    expect(linked.warnings).toContainEqual(
      expect.objectContaining({
        code: "CODE_RUNTIME_SYMBOL_AMBIGUOUS",
        path: "src/math.js",
      }),
    );
  });
});
