import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);
export class GitKnowledgeFileNotFoundError extends Error {
  constructor(revision: string, relativePath: string) {
    super(
      `Knowledge file is absent from revision ${revision}: ${relativePath}`,
    );
    this.name = "GitKnowledgeFileNotFoundError";
  }
}

function isMissingGitPathError(error: unknown): boolean {
  const failure = error as Error & { stderr?: string };
  const detail = `${failure?.message ?? ""}\n${failure?.stderr ?? ""}`;
  return /path .* does not exist|exists on disk, but not in|path .* not in .* tree/i.test(
    detail,
  );
}

export class GitKnowledgeStore {
  private activeWorktree: string | null = null;

  private readonly repositoryPath: string;

  constructor(repositoryPath: string) {
    this.repositoryPath = path.resolve(repositoryPath);
  }

  private async git(
    args: string[],
    workingTree = this.repositoryPath,
  ): Promise<string> {
    const result = await exec("git", ["-C", workingTree, ...args], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trim();
  }

  revision(): Promise<string> {
    return this.git(["rev-parse", "HEAD"]);
  }

  async ensureRepository(
    authorName: string,
    authorEmail: string,
  ): Promise<string> {
    await mkdir(this.repositoryPath, { recursive: true });
    try {
      await this.git(["checkout", "main"]);
      return await this.revision();
    } catch {
      await exec("git", ["init", "-b", "main", this.repositoryPath], {
        windowsHide: true,
      });
      await this.git(["config", "user.name", authorName]);
      await this.git(["config", "user.email", authorEmail]);
      await writeFile(
        path.join(this.repositoryPath, "README.md"),
        "# Managed Architecture Knowledge\n\nHuman-reviewed supplemental knowledge.\n",
        "utf8",
      );
      await this.git(["add", "--all"]);
      await this.git([
        "-c",
        `user.name=${authorName}`,
        "-c",
        `user.email=${authorEmail}`,
        "commit",
        "-m",
        "chore: initialize managed knowledge repository",
      ]);
      return this.revision();
    }
  }

  async createDraftBranch(
    reviewId: string,
    baseRevision: string,
  ): Promise<string> {
    const branch = `draft/${reviewId}`;
    const { draftsRoot, worktree } = this.draftLocation(branch);
    await mkdir(draftsRoot, { recursive: true });
    await this.removeExistingWorktreePath(worktree);
    await this.git(["worktree", "prune"]);
    await this.git(["worktree", "add", "-b", branch, worktree, baseRevision]);
    this.activeWorktree = worktree;
    return branch;
  }

  async writeDraftFile(relativePath: string, content: string): Promise<void> {
    const normalized = this.safePath(relativePath);
    if (!this.activeWorktree)
      throw new Error("No isolated draft worktree is active.");
    const destination = await this.safeDraftPath(
      this.activeWorktree,
      normalized,
      true,
    );
    await writeFile(destination, content, "utf8");
  }

  async commitAll(
    message: string,
    authorName: string,
    authorEmail: string,
  ): Promise<string> {
    if (!this.activeWorktree)
      throw new Error("No isolated draft worktree is active.");
    await this.git(["add", "--all"], this.activeWorktree);
    await this.git(
      [
        "-c",
        `user.name=${authorName}`,
        "-c",
        `user.email=${authorEmail}`,
        "commit",
        "--allow-empty",
        "-m",
        message,
      ],
      this.activeWorktree,
    );
    return this.git(["rev-parse", "HEAD"], this.activeWorktree);
  }

  async showFile(revision: string, relativePath: string): Promise<string> {
    const normalized = this.safePath(relativePath);
    try {
      await this.git(["cat-file", "-e", `${revision}:${normalized}`]);
    } catch (error) {
      if (isMissingGitPathError(error)) {
        throw new GitKnowledgeFileNotFoundError(revision, normalized);
      }
      throw error;
    }
    return this.git(["show", `${revision}:${normalized}`]);
  }

  /**
   * Tests the canonical Git tree rather than the current checkout.  Review
   * classification and rollback reconciliation must not infer existence from
   * a worktree, because a draft can be stale or already removed.
   */
  async hasFileAtRevision(
    revision: string,
    relativePath: string,
  ): Promise<boolean> {
    const normalized = this.safePath(relativePath);
    try {
      await this.git(["cat-file", "-e", `${revision}:${normalized}`]);
      return true;
    } catch (error) {
      if (isMissingGitPathError(error)) {
        return false;
      }
      throw error;
    }
  }

  async readWorkingFile(relativePath: string): Promise<string> {
    const normalized = this.safePath(relativePath);
    const root = this.activeWorktree ?? this.repositoryPath;
    const destination = await this.safeDraftPath(root, normalized, false);
    return readFile(destination, "utf8");
  }

  diff(baseRevision: string, headRevision = "HEAD"): Promise<string> {
    return this.git([
      "diff",
      "--no-ext-diff",
      `${baseRevision}..${headRevision}`,
    ]);
  }

  /**
   * Publish a draft only when both the main branch and the draft branch still
   * point at the revisions that were approved.  Cleanup is deliberately
   * separate so callers can retain the draft for recovery when publication or
   * downstream indexing fails.
   *
   * The five-argument overload is the secure form:
   *   mergeDraft(branch, expectedBase, expectedHead, authorName, authorEmail)
   *
   * The legacy four-argument form remains source-compatible for existing
   * callers while they migrate; it still resolves and merges the current
   * branch tip, but cannot protect against a branch move without an expected
   * head supplied by the caller.
   */
  async mergeDraft(
    branchName: string,
    expectedBase: string,
    expectedHead: string,
    authorName: string,
    authorEmail: string,
  ): Promise<string>;
  async mergeDraft(
    branchName: string,
    expectedBase: string,
    authorName: string,
    authorEmail: string,
  ): Promise<string>;
  async mergeDraft(
    branchName: string,
    expectedBase: string,
    expectedHeadOrAuthorName: string,
    authorNameOrEmail: string,
    authorEmailMaybe?: string,
  ): Promise<string> {
    this.assertDraftBranchName(branchName);
    const hasExpectedHead = authorEmailMaybe !== undefined;
    const expectedHead = hasExpectedHead ? expectedHeadOrAuthorName : null;
    const authorName = hasExpectedHead
      ? authorNameOrEmail
      : expectedHeadOrAuthorName;
    const authorEmail = hasExpectedHead ? authorEmailMaybe : authorNameOrEmail;

    const branchHead = await this.git([
      "rev-parse",
      "--verify",
      `${branchName}^{commit}`,
    ]);
    if (expectedHead !== null && branchHead !== expectedHead) {
      throw new Error(
        `DRAFT_HEAD_CONFLICT: expected ${expectedHead}, current ${branchHead}`,
      );
    }

    await this.git(["checkout", "main"]);
    const current = await this.revision();
    if (current !== expectedBase) {
      throw new Error(
        `OPTIMISTIC_BASE_CONFLICT: expected ${expectedBase}, current ${current}`,
      );
    }
    await this.git([
      "-c",
      `user.name=${authorName}`,
      "-c",
      `user.email=${authorEmail}`,
      "merge",
      "--squash",
      expectedHead ?? branchHead,
    ]);
    await this.git([
      "-c",
      `user.name=${authorName}`,
      "-c",
      `user.email=${authorEmail}`,
      "commit",
      "-m",
      `review: publish ${branchName}`,
    ]);
    return this.revision();
  }

  /**
   * Remove a draft worktree and its branch.  This is intentionally explicit;
   * mergeDraft leaves both resources available to callers for recovery and
   * audit until publication has completed successfully.
   */
  async cleanupDraft(branchName: string): Promise<void> {
    const { worktree } = this.draftLocation(branchName);
    await this.removeExistingWorktreePath(worktree);
    await this.git(["worktree", "prune"]);
    const branch = await this.git(["branch", "--list", branchName]);
    if (branch.trim()) {
      await this.git(["branch", "-D", branchName]);
    }
    if (this.activeWorktree === worktree) {
      this.activeWorktree = null;
    }
  }

  async cleanupDraftBranch(branchName: string): Promise<void> {
    return this.cleanupDraft(branchName);
  }

  async rollbackMain(commit: string): Promise<string> {
    await this.git(["checkout", "main"]);
    await this.git(["revert", "--no-edit", commit]);
    return this.revision();
  }

  private async safeDraftPath(
    root: string,
    normalized: string,
    createParent: boolean,
  ): Promise<string> {
    const rootPath = path.resolve(root);
    await this.assertDirectory(rootPath);
    const destination = path.resolve(rootPath, ...normalized.split("/"));
    const relative = path.relative(rootPath, destination);
    if (
      relative === "" ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Unsafe knowledge path");
    }

    const parent = path.dirname(destination);
    if (createParent) {
      await this.ensureDirectoryChain(rootPath, parent);
    } else {
      await this.assertNoSymlinkChain(rootPath, parent);
    }
    await this.assertNoSymlinkChain(rootPath, destination);
    return destination;
  }

  private async assertDirectory(directory: string): Promise<void> {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error("Unsafe draft worktree path");
    }
  }

  private async ensureDirectoryChain(
    root: string,
    directory: string,
  ): Promise<void> {
    const relative = path.relative(root, directory);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Unsafe knowledge path");
    }
    let current = root;
    for (const segment of relative ? relative.split(path.sep) : []) {
      current = path.join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink() || !info.isDirectory()) {
          throw new Error("Unsafe draft path");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        await mkdir(current);
      }
    }
  }

  private async assertNoSymlinkChain(
    root: string,
    target: string,
  ): Promise<void> {
    const relative = path.relative(root, target);
    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Unsafe knowledge path");
    }
    let current = root;
    for (const segment of relative ? relative.split(path.sep) : []) {
      current = path.join(current, segment);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new Error("Unsafe draft path: symbolic links are not allowed");
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          break;
        }
        throw error;
      }
    }
  }

  private async removeExistingWorktreePath(worktree: string): Promise<void> {
    const draftsRoot = path.resolve(`${this.repositoryPath}-drafts`);
    const relative = path.relative(draftsRoot, worktree);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Unsafe draft worktree path");
    }
    try {
      const info = await lstat(worktree);
      // Unlink a symlink itself; never recurse through it into an external
      // directory.  Git will recreate the worktree directory safely below.
      await rm(worktree, {
        recursive: !info.isSymbolicLink(),
        force: true,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }

  private draftLocation(branchName: string): {
    draftsRoot: string;
    worktree: string;
  } {
    this.assertDraftBranchName(branchName);
    const reviewId = branchName.slice("draft/".length);
    const draftsRoot = path.resolve(`${this.repositoryPath}-drafts`);
    const worktree = path.resolve(draftsRoot, ...reviewId.split("/"));
    const relative = path.relative(draftsRoot, worktree);
    if (
      !relative ||
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("Unsafe draft worktree path");
    }
    return { draftsRoot, worktree };
  }

  private assertDraftBranchName(branchName: string): void {
    if (
      !branchName.startsWith("draft/") ||
      branchName.length <= "draft/".length ||
      branchName.includes("\\") ||
      branchName.includes("\0")
    ) {
      throw new Error("Unsafe draft branch name");
    }
    const reviewId = branchName.slice("draft/".length);
    const normalized = path.posix.normalize(reviewId);
    if (
      normalized === "." ||
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized)
    ) {
      throw new Error("Unsafe draft branch name");
    }
  }

  private safePath(relativePath: string): string {
    const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
    if (
      normalized.startsWith("../") ||
      path.posix.isAbsolute(normalized) ||
      path.win32.isAbsolute(normalized) ||
      /^[A-Za-z]:/.test(normalized) ||
      normalized.includes("\0") ||
      normalized === "."
    ) {
      throw new Error("Unsafe knowledge path");
    }
    return normalized;
  }
}
