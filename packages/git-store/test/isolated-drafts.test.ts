import { access, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GitKnowledgeStore } from "../src/index.js";

describe("isolated draft worktrees", () => {
  it("publishes only the approved review", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-git-store-"));
    const author = [
      "Architecture Knowledge Platform",
      "akp@localhost",
    ] as const;
    const first = new GitKnowledgeStore(root);
    const base = await first.ensureRepository(...author);
    await first.createDraftBranch("approved", base);
    await first.writeDraftFile("approved.md", "# approved");
    await first.commitAll("approved draft", ...author);

    const second = new GitKnowledgeStore(root);
    await second.ensureRepository(...author);
    await second.createDraftBranch("rejected", base);
    await second.writeDraftFile("rejected.md", "# rejected");
    await second.commitAll("rejected draft", ...author);

    await first.mergeDraft("draft/approved", base, ...author);
    await expect(
      readFile(path.join(root, "approved.md"), "utf8"),
    ).resolves.toContain("approved");
    await expect(
      readFile(path.join(root, "rejected.md"), "utf8"),
    ).rejects.toThrow();
    await first.cleanupDraft("draft/approved");
    await second.cleanupDraft("draft/rejected");
  });

  it("classifies file existence against an immutable revision", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-git-store-exists-"));
    const author = [
      "Architecture Knowledge Platform",
      "akp@localhost",
    ] as const;
    const store = new GitKnowledgeStore(root);
    const base = await store.ensureRepository(...author);
    expect(await store.hasFileAtRevision(base, "new-note.md")).toBe(false);

    await store.createDraftBranch("existence", base);
    await store.writeDraftFile("new-note.md", "# note");
    const draftRevision = await store.commitAll("add note", ...author);
    expect(await store.hasFileAtRevision(draftRevision, "new-note.md")).toBe(
      true,
    );
    expect(await store.hasFileAtRevision(base, "new-note.md")).toBe(false);
    await store.cleanupDraft("draft/existence");
  });

  it("rejects a draft branch whose reviewed head moved and cleans explicitly", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-git-store-head-"));
    const author = [
      "Architecture Knowledge Platform",
      "akp@localhost",
    ] as const;
    const store = new GitKnowledgeStore(root);
    const base = await store.ensureRepository(...author);
    const branch = await store.createDraftBranch("stable-head", base);
    await store.writeDraftFile("note.md", "# reviewed");
    const reviewedHead = await store.commitAll("reviewed draft", ...author);
    await store.writeDraftFile("note.md", "# changed after review");
    await store.commitAll("unreviewed mutation", ...author);

    await expect(
      store.mergeDraft(branch, base, reviewedHead, ...author),
    ).rejects.toThrow("DRAFT_HEAD_CONFLICT");
    await store.cleanupDraft(branch);
    await expect(
      access(path.join(`${root}-drafts`, "stable-head")),
    ).rejects.toThrow();
  });

  it("does not follow a symlink placed beneath an isolated draft", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "akp-git-store-symlink-"));
    const outside = await mkdtemp(
      path.join(tmpdir(), "akp-git-store-outside-"),
    );
    const author = [
      "Architecture Knowledge Platform",
      "akp@localhost",
    ] as const;
    const store = new GitKnowledgeStore(root);
    const base = await store.ensureRepository(...author);
    const branch = await store.createDraftBranch("symlink-guard", base);
    const link = path.join(`${root}-drafts`, "symlink-guard", "outside");
    try {
      await symlink(outside, link, "junction");
    } catch (error) {
      // Creating links can be disabled by Windows policy. The adapter still
      // receives direct coverage on systems where the adversarial fixture is
      // supported, without turning local policy into a false product failure.
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        await store.cleanupDraft(branch);
        return;
      }
      throw error;
    }
    await expect(
      store.writeDraftFile("outside/escape.md", "must not escape"),
    ).rejects.toThrow("Unsafe draft");
    await expect(
      readFile(path.join(outside, "escape.md"), "utf8"),
    ).rejects.toThrow();
    await store.cleanupDraft(branch);
  });
});
