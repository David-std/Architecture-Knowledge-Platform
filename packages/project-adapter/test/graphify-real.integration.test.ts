import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GraphifyCodeGraphAdapter,
  createCodeSnapshot,
  defaultCodeGraphOptions,
} from "../src/index.js";

const roots: string[] = [];
const realGraphifyEnabled = process.env.AKP_REAL_GRAPHIFY === "1";

async function fixtureRepository(): Promise<{ root: string; commit: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "akp-real-graphify-"));
  roots.push(root);

  const git = (...args: string[]) =>
    spawnSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      windowsHide: true,
    });

  expect(git("init", "-b", "main").status).toBe(0);
  expect(git("config", "user.name", "AKP Graphify CI").status).toBe(0);
  expect(git("config", "user.email", "akp-graphify@localhost").status).toBe(0);

  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "generated"), { recursive: true });
  await writeFile(
    path.join(root, "src", "math.ts"),
    [
      "export function add(left: number, right: number): number {",
      "  return left + right;",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "src", "index.ts"),
    [
      'import { add } from "./math.js";',
      "",
      "export function total(): number {",
      "  return add(2, 3);",
      "}",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "generated", "ignored.ts"),
    "export const generatedSecret = 'must-not-enter-code-graph';\n",
  );

  expect(git("add", ".").status).toBe(0);
  expect(git("commit", "-m", "graphify fixture").status).toBe(0);
  const commit = git("rev-parse", "HEAD").stdout.trim();
  expect(commit).toMatch(/^[a-f0-9]{40}$/);
  return { root, commit };
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) =>
        rm(root, { recursive: true, force: true }).catch(() => undefined),
      ),
  );
});

describe("GraphifyCodeGraphAdapter real provider", () => {
  it.skipIf(!realGraphifyEnabled)(
    "normalizes a pinned real Graphify code-only extraction from an immutable commit",
    async () => {
      const executable = process.env.AKP_GRAPHIFY_EXECUTABLE ?? "graphify";
      const { root, commit } = await fixtureRepository();
      const snapshot = await createCodeSnapshot({
        repositoryPath: root,
        commit,
      });

      const adapter = new GraphifyCodeGraphAdapter({
        executable,
        incremental: true,
      });
      const artifact = await adapter.analyze(snapshot, {
        ...defaultCodeGraphOptions(),
        timeoutMs: 180_000,
      });

      expect(artifact).toMatchObject({
        schemaVersion: 1,
        repository: snapshot.repository,
        commitSha: commit,
        provider: "graphify",
        providerVersion: "0.9.63",
      });
      expect(artifact.nodes.length).toBeGreaterThan(0);
      expect(artifact.edges.length).toBeGreaterThan(0);
      expect(
        artifact.nodes.every(
          (node) =>
            node.id.startsWith("CODE-") &&
            ["src/index.ts", "src/math.ts"].includes(node.path),
        ),
      ).toBe(true);
      expect(new Set(artifact.nodes.map((node) => node.path))).toEqual(
        new Set(["src/index.ts", "src/math.ts"]),
      );
      expect(
        artifact.edges.some((edge) =>
          ["CALLS", "IMPORTS", "REFERENCES"].includes(edge.relation),
        ),
      ).toBe(true);
      expect(
        artifact.warnings.some(
          (warning) =>
            warning.code === "CODE_GRAPH_FILE_EXCLUDED" &&
            warning.path === "generated/ignored.ts",
        ),
      ).toBe(true);
      expect(
        artifact.nodes.some((node) => node.path === "generated/ignored.ts"),
      ).toBe(false);
      expect(
        (artifact.extensions?.graphify as Record<string, unknown>)
          .executionMode,
      ).toBe("FULL");

      await writeFile(
        path.join(root, "src", "math.ts"),
        [
          "export function add(left: number, right: number): number {",
          "  return left + right;",
          "}",
          "",
          "export function multiply(left: number, right: number): number {",
          "  return left * right;",
          "}",
          "",
        ].join("\n"),
      );
      const git = (...args: string[]) =>
        spawnSync("git", ["-C", root, ...args], {
          encoding: "utf8",
          windowsHide: true,
        });
      expect(git("add", "src/math.ts").status).toBe(0);
      expect(git("commit", "-m", "incremental graphify fixture").status).toBe(
        0,
      );
      const nextCommit = git("rev-parse", "HEAD").stdout.trim();
      const nextSnapshot = await createCodeSnapshot({
        repositoryPath: root,
        commit: nextCommit,
      });
      const updated = await adapter.analyze(nextSnapshot, {
        ...defaultCodeGraphOptions(),
        timeoutMs: 180_000,
      });

      expect(updated.commitSha).toBe(nextCommit);
      expect(
        (updated.extensions?.graphify as Record<string, unknown>).executionMode,
      ).toBe("INCREMENTAL");
      expect(
        (updated.extensions?.graphify as Record<string, unknown>)
          .previousCommitSha,
      ).toBe(commit);
      expect(
        updated.nodes.some(
          (node) =>
            node.name === "multiply" ||
            node.qualifiedName?.includes("multiply") === true,
        ),
      ).toBe(true);
    },
    240_000,
  );
});
