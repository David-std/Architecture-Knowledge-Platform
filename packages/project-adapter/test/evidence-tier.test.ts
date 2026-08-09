import { mkdtemp, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeterministicProjectAdapter,
  buildProjectSnapshot,
  maySupportVerifiedClaim,
} from "../src/index.js";

describe("project evidence tiers", () => {
  it("does not promote a regex annotation to verified evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-project-"));
    await writeFile(
      path.join(root, "Example.java"),
      "@Service class Example {}",
      "utf8",
    );
    const evidence = await new DeterministicProjectAdapter().scan({
      repositoryPath: root,
      commit: "fixture",
    });
    expect(evidence[0]?.tier).toBe("NO_SIGNAL");
    expect(evidence[0] && maySupportVerifiedClaim(evidence[0])).toBe(false);
  });

  it("reads an immutable commit instead of a subsequently changed worktree", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-project-git-"));
    const run = (...args: string[]) =>
      spawnSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        windowsHide: true,
      });
    expect(run("init").status).toBe(0);
    expect(run("config", "user.name", "AKP Test").status).toBe(0);
    expect(run("config", "user.email", "akp-test@localhost").status).toBe(0);
    await writeFile(
      path.join(root, "Example.java"),
      "@Service class Example {}",
      "utf8",
    );
    expect(run("add", "Example.java").status).toBe(0);
    expect(run("commit", "-m", "fixture").status).toBe(0);
    const commit = run("rev-parse", "HEAD").stdout.trim();
    await writeFile(
      path.join(root, "Example.java"),
      "@RestController class Changed {}",
      "utf8",
    );

    const evidence = await new DeterministicProjectAdapter().scan({
      repositoryPath: root,
      commit,
    });
    expect(evidence.map((item) => item.behavior)).toContain(
      "Spring application service stereotype is present.",
    );
    expect(evidence.map((item) => item.behavior)).not.toContain(
      "Spring REST adapter is present.",
    );
    expect(evidence[0]?.metadata.snapshotMode).toBe("IMMUTABLE_GIT_COMMIT");
    const snapshot = await buildProjectSnapshot({
      repositoryPath: root,
      commit,
    });
    expect(snapshot.files).toHaveLength(1);
    expect(snapshot.symbols.map((symbol) => symbol.name)).toContain("Example");
    expect(snapshot.commit).toBe(commit);
    expect(snapshot.architectureRules[0]?.status).toBe("PASSED");
  });
});
