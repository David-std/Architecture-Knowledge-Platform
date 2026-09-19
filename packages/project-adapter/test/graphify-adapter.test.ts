import {
  access,
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GraphifyCodeGraphAdapter,
  createCodeSnapshot,
  defaultCodeGraphOptions,
} from "../src/index.js";

const roots: string[] = [];

async function gitRepository(): Promise<{ root: string; commit: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "akp-graphify-test-"));
  roots.push(root);
  const run = (...args: string[]) =>
    spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });
  expect(run("init", "-b", "main").status).toBe(0);
  expect(run("config", "user.name", "AKP Graph Test").status).toBe(0);
  expect(run("config", "user.email", "akp-graph-test@localhost").status).toBe(
    0,
  );
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "generated"), { recursive: true });
  await writeFile(
    path.join(root, "src", "a.ts"),
    "export function a() { return b(); }\n",
  );
  await writeFile(
    path.join(root, "src", "b.ts"),
    "export function b() { return 1; }\n",
  );
  await writeFile(
    path.join(root, "generated", "ignored.ts"),
    "export const generated = true;\n",
  );
  expect(run("add", ".").status).toBe(0);
  expect(run("commit", "-m", "fixture").status).toBe(0);
  const commit = run("rev-parse", "HEAD").stdout.trim();
  return { root, commit };
}

async function fakeGraphify(
  root: string,
  graph: Record<string, unknown>,
): Promise<string> {
  const script = path.join(root, "fake-graphify.mjs");
  await writeFile(
    script,
    [
      'import { access, appendFile, mkdir, writeFile } from "node:fs/promises";',
      'import path from "node:path";',
      "const args = process.argv.slice(2);",
      "if (process.env.OPENAI_API_KEY) process.exit(42);",
      'if (args.includes("--version")) { console.log("graphify 0.9.99"); process.exit(0); }',
      'if (args[0] !== "extract" && args[0] !== "update") process.exit(43);',
      'await appendFile(new URL("./provider-command.log", import.meta.url), args[0] + "\\n");',
      'if (args[0] === "update") { try { await access(path.join(process.cwd(), "graphify-out", "graph.json")); } catch { process.exit(44); } }',
      'await mkdir(path.join(process.cwd(), "graphify-out"), { recursive: true });',
      `await writeFile(path.join(process.cwd(), "graphify-out", "graph.json"), ${JSON.stringify(
        JSON.stringify(graph),
      )});`,
    ].join("\n"),
  );
  return script;
}

afterEach(async () => {
  delete process.env.OPENAI_API_KEY;
  await Promise.all(
    roots
      .splice(0)
      .map((root) =>
        rm(root, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
});

describe("GraphifyCodeGraphAdapter", () => {
  it("analyzes only the verified immutable snapshot and normalizes provider output", async () => {
    const { root, commit } = await gitRepository();
    const snapshot = await createCodeSnapshot({
      repositoryPath: root,
      commit,
    });
    const script = await fakeGraphify(root, {
      directed: true,
      multigraph: true,
      nodes: [
        {
          id: "provider-a",
          label: "a",
          node_type: "function",
          source_file: "src/a.ts",
          source_location: "L1-L1",
          language: "TypeScript",
        },
        {
          id: "provider-b",
          label: "b",
          node_type: "function",
          source_file: "src/b.ts",
          source_location: "L1-L1",
          language: "TypeScript",
        },
      ],
      edges: [
        {
          id: "provider-edge",
          source: "provider-a",
          target: "provider-b",
          relation: "calls",
          confidence: "EXTRACTED",
          confidence_score: 0.99,
          source_file: "src/a.ts",
          source_location: "L1-L1",
        },
      ],
    });
    process.env.OPENAI_API_KEY = "must-not-reach-provider";

    const adapter = new GraphifyCodeGraphAdapter({
      executable: process.execPath,
      executableArgs: [script],
    });
    const artifact = await adapter.analyze(snapshot, defaultCodeGraphOptions());

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      commitSha: commit,
      provider: "graphify",
      providerVersion: "0.9.99",
      languages: ["TypeScript"],
    });
    expect(artifact.configurationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(artifact.nodes).toHaveLength(2);
    expect(artifact.nodes.every((node) => node.id.startsWith("CODE-"))).toBe(
      true,
    );
    expect(artifact.nodes.map((node) => node.path).sort()).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
    expect(artifact.edges).toHaveLength(1);
    expect(artifact.edges[0]).toMatchObject({
      relation: "CALLS",
      derivation: "EXTRACTED",
      locator: {
        commitSha: commit,
        path: "src/a.ts",
        lineStart: 1,
        lineEnd: 1,
      },
    });
    expect(artifact.edges[0]).not.toHaveProperty("confidence");
    expect(artifact.warnings).toContainEqual(
      expect.objectContaining({
        code: "CODE_GRAPH_FILE_EXCLUDED",
        path: "generated/ignored.ts",
      }),
    );
  });

  it("uses Graphify update only after a validated prior provider state", async () => {
    const { root, commit } = await gitRepository();
    const firstSnapshot = await createCodeSnapshot({
      repositoryPath: root,
      commit,
    });
    const graph = {
      directed: true,
      multigraph: true,
      nodes: [
        {
          id: "provider-a",
          label: "a",
          node_type: "function",
          source_file: "src/a.ts",
          source_location: "L1",
          language: "TypeScript",
        },
        {
          id: "provider-b",
          label: "b",
          node_type: "function",
          source_file: "src/b.ts",
          source_location: "L1",
          language: "TypeScript",
        },
      ],
      edges: [
        {
          id: "provider-edge",
          source: "provider-a",
          target: "provider-b",
          relation: "calls",
          confidence: "STATICALLY_RESOLVED",
          source_file: "src/a.ts",
          source_location: "L1",
        },
      ],
    };
    const script = await fakeGraphify(root, graph);
    const adapter = new GraphifyCodeGraphAdapter({
      executable: process.execPath,
      executableArgs: [script],
      incremental: true,
    });

    const first = await adapter.analyze(
      firstSnapshot,
      defaultCodeGraphOptions(),
    );
    expect(
      (first.extensions?.graphify as Record<string, unknown>).executionMode,
    ).toBe("FULL");

    await writeFile(
      path.join(root, "src", "b.ts"),
      "export function b() { return 2; }\n",
    );
    const run = (...args: string[]) =>
      spawnSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        windowsHide: true,
      });
    expect(run("add", "src/b.ts").status).toBe(0);
    expect(run("commit", "-m", "second fixture").status).toBe(0);
    const nextCommit = run("rev-parse", "HEAD").stdout.trim();
    const nextSnapshot = await createCodeSnapshot({
      repositoryPath: root,
      commit: nextCommit,
    });

    const second = await adapter.analyze(
      nextSnapshot,
      defaultCodeGraphOptions(),
    );
    expect(
      (second.extensions?.graphify as Record<string, unknown>).executionMode,
    ).toBe("INCREMENTAL");
    expect(
      (second.extensions?.graphify as Record<string, unknown>)
        .previousCommitSha,
    ).toBe(commit);
    expect(second.commitSha).toBe(nextCommit);
    expect(
      (await readFile(path.join(root, "provider-command.log"), "utf8"))
        .trim()
        .split(/\r?\n/),
    ).toEqual(["extract", "update"]);
  });

  it("rejects provider paths outside the verified snapshot", async () => {
    const { root, commit } = await gitRepository();
    const snapshot = await createCodeSnapshot({
      repositoryPath: root,
      commit,
    });
    const script = await fakeGraphify(root, {
      nodes: [
        {
          id: "escape",
          label: "escape",
          node_type: "function",
          source_file: "../outside.ts",
          source_location: "L1",
        },
      ],
      edges: [],
    });
    const adapter = new GraphifyCodeGraphAdapter({
      executable: process.execPath,
      executableArgs: [script],
    });

    await expect(
      adapter.analyze(snapshot, defaultCodeGraphOptions()),
    ).rejects.toThrow("CODE_GRAPH_PATH_ESCAPE");
  });

  it("fails closed when the provider exits nonzero", async () => {
    const { root, commit } = await gitRepository();
    const snapshot = await createCodeSnapshot({
      repositoryPath: root,
      commit,
    });
    const script = path.join(root, "failing-graphify.mjs");
    await writeFile(
      script,
      [
        "const args = process.argv.slice(2);",
        'if (args.includes("--version")) { console.log("graphify 0.9.99"); process.exit(0); }',
        'console.error("synthetic extraction failure");',
        "process.exit(23);",
      ].join("\n"),
    );
    const adapter = new GraphifyCodeGraphAdapter({
      executable: process.execPath,
      executableArgs: [script],
    });

    await expect(
      adapter.analyze(snapshot, defaultCodeGraphOptions()),
    ).rejects.toThrow("GRAPHIFY_PROCESS_FAILED");
  });

  it("rejects a Git symlink before provider extraction", async () => {
    const { root } = await gitRepository();
    await symlink("a.ts", path.join(root, "src", "linked.ts"));
    const run = (...args: string[]) =>
      spawnSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        windowsHide: true,
      });
    expect(run("add", "src/linked.ts").status).toBe(0);
    expect(run("commit", "-m", "symlink fixture").status).toBe(0);
    const commit = run("rev-parse", "HEAD").stdout.trim();
    const snapshot = await createCodeSnapshot({
      repositoryPath: root,
      commit,
    });
    const script = await fakeGraphify(root, { nodes: [], edges: [] });
    const adapter = new GraphifyCodeGraphAdapter({
      executable: process.execPath,
      executableArgs: [script],
    });

    await expect(
      adapter.analyze(snapshot, defaultCodeGraphOptions()),
    ).rejects.toThrow("CODE_SNAPSHOT_SYMLINK_REJECTED");
  });

  it("kills a provider that exceeds the bounded process output budget", async () => {
    const { root, commit } = await gitRepository();
    const snapshot = await createCodeSnapshot({
      repositoryPath: root,
      commit,
    });
    const script = path.join(root, "output-bomb-graphify.mjs");
    await writeFile(
      script,
      [
        "const args = process.argv.slice(2);",
        'if (args.includes("--version")) { console.log("graphify 0.9.99"); process.exit(0); }',
        'if (args[0] !== "extract") process.exit(43);',
        'process.stdout.write("x".repeat(4096));',
      ].join("\n"),
    );
    const adapter = new GraphifyCodeGraphAdapter({
      executable: process.execPath,
      executableArgs: [script],
    });

    await expect(
      adapter.analyze(snapshot, {
        ...defaultCodeGraphOptions(),
        maxProcessOutputBytes: 1024,
      }),
    ).rejects.toThrow("GRAPHIFY_PROCESS_OUTPUT_LIMIT");
  });
});
