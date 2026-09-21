import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeCodeCommitDelta } from "../src/code-delta.js";

const roots: string[] = [];

function git(root: string, ...args: string[]) {
  return spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
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

describe("code commit delta", () => {
  it("derives bounded changed files and symbols from immutable base/head commits", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-code-delta-"));
    roots.push(root);
    expect(git(root, "init", "-b", "main").status).toBe(0);
    expect(git(root, "config", "user.name", "AKP Delta Test").status).toBe(0);
    expect(git(root, "config", "user.email", "akp-delta@localhost").status).toBe(
      0,
    );
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "src", "service.ts"),
      [
        "export function keep() { return 1; }",
        "export function stableA() { return 10; }",
        "export function stableB() { return 20; }",
        "export function stableC() { return 30; }",
        "export function removed() { return 2; }",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "src", "helper.ts"),
      "export function helper() { return 1; }\n",
    );
    expect(git(root, "add", ".").status).toBe(0);
    expect(git(root, "commit", "-m", "base").status).toBe(0);
    const baseSha = git(root, "rev-parse", "HEAD").stdout.trim();

    expect(
      git(root, "mv", "src/service.ts", "src/renamed-service.ts").status,
    ).toBe(0);
    await writeFile(
      path.join(root, "src", "renamed-service.ts"),
      [
        "export function keep() { return 3; }",
        "export function stableA() { return 10; }",
        "export function stableB() { return 20; }",
        "export function stableC() { return 30; }",
        "export function added() { return 4; }",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "src", "helper.ts"),
      "export function helper() { return 2; }\n",
    );
    await writeFile(
      path.join(root, "src", "new.ts"),
      "export class NewService {}\n",
    );
    expect(git(root, "add", "-A").status).toBe(0);
    expect(git(root, "commit", "-m", "head").status).toBe(0);
    const headSha = git(root, "rev-parse", "HEAD").stdout.trim();

    const delta = computeCodeCommitDelta({
      repositoryPath: root,
      baseSha,
      headSha,
    });

    expect(delta).toMatchObject({
      baseSha,
      headSha,
      changeSet: {
        fromCommitSha: baseSha,
        toCommitSha: headSha,
        added: ["src/new.ts"],
        modified: ["src/helper.ts"],
        deleted: [],
        renamed: [
          {
            from: "src/service.ts",
            to: "src/renamed-service.ts",
          },
        ],
      },
      warnings: [],
    });
    expect(delta.changedSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/helper.ts",
          kind: "FUNCTION",
          name: "helper",
        }),
        expect.objectContaining({
          path: "src/renamed-service.ts",
          kind: "FUNCTION",
          name: "keep",
        }),
      ]),
    );
    expect(delta.removedSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/service.ts",
          name: "removed",
        }),
      ]),
    );
    expect(delta.addedSymbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/renamed-service.ts",
          name: "added",
        }),
        expect.objectContaining({
          path: "src/new.ts",
          kind: "CLASS",
          name: "NewService",
        }),
      ]),
    );
  });

  it("rejects invalid or identical immutable commit ranges", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-code-delta-"));
    roots.push(root);
    expect(git(root, "init", "-b", "main").status).toBe(0);
    expect(git(root, "config", "user.name", "AKP Delta Test").status).toBe(0);
    expect(git(root, "config", "user.email", "akp-delta@localhost").status).toBe(
      0,
    );
    await writeFile(path.join(root, "a.ts"), "export function a() {}\n");
    expect(git(root, "add", ".").status).toBe(0);
    expect(git(root, "commit", "-m", "base").status).toBe(0);
    const commit = git(root, "rev-parse", "HEAD").stdout.trim();

    expect(() =>
      computeCodeCommitDelta({
        repositoryPath: root,
        baseSha: "not-a-sha",
        headSha: commit,
      }),
    ).toThrow("CODE_DELTA_BASE_COMMIT_INVALID");
    expect(() =>
      computeCodeCommitDelta({
        repositoryPath: root,
        baseSha: commit,
        headSha: commit,
      }),
    ).toThrow("CODE_DELTA_COMMITS_IDENTICAL");
  });
});
