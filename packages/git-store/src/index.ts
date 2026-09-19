import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  SourceConnectorCheckpoint,
  SourceConnectorDescriptor,
  SourceConnectorFetchInput,
  SourceConnectorObject,
  SourceConnectorPort,
  SourceConnectorPullInput,
  SourceConnectorPullPage,
  SourceConnectorPullRequest,
  SourceConnectorScope,
} from "@akp/domain";

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

  private async gitRaw(
    args: string[],
    workingTree = this.repositoryPath,
  ): Promise<string> {
    const result = await exec("git", ["-C", workingTree, ...args], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout;
  }

  private async git(
    args: string[],
    workingTree = this.repositoryPath,
  ): Promise<string> {
    return (await this.gitRaw(args, workingTree)).trim();
  }

  revision(): Promise<string> {
    return this.git(["rev-parse", "HEAD"]);
  }

  async listTreeEntries(
    revision = "HEAD",
  ): Promise<Array<{ path: string; blob: string; mode: string }>> {
    const output = await this.gitRaw([
      "ls-tree",
      "-r",
      "-z",
      "--full-tree",
      `${revision}^{tree}`,
    ]);
    return output
      .split("\0")
      .filter(Boolean)
      .flatMap((record) => {
        const tab = record.indexOf("\t");
        if (tab < 0) return [];
        const header = record.slice(0, tab).split(" ");
        const relativePath = record.slice(tab + 1);
        const [mode, type, blob] = header;
        if (!mode || type !== "blob" || !blob || !relativePath) return [];
        const normalized = this.safePath(relativePath);
        return [{ path: normalized, blob, mode }];
      });
  }

  async commitMetadata(revision = "HEAD"): Promise<{
    revision: string;
    parents: string[];
    tree: string;
    subject: string;
  }> {
    const output = await this.git([
      "show",
      "-s",
      "--format=%H%x00%P%x00%T%x00%s",
      `${revision}^{commit}`,
    ]);
    const [resolved, parents = "", tree = "", subject = ""] =
      output.split("\0");
    if (!resolved || !tree) throw new Error("GIT_COMMIT_METADATA_INVALID");
    return {
      revision: resolved,
      parents: parents.split(" ").filter(Boolean),
      tree,
      subject,
    };
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

export interface LocalGitSourceConnectorOptions {
  connectorId?: string;
  includeExtensions?: string[];
  maxObjectBytes?: number;
}

type GitConnectorCursor = {
  from: string | null;
  target: string;
  offset: number;
};

function encodeGitConnectorCursor(cursor: GitConnectorCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeGitConnectorCursor(value: string): GitConnectorCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error("SOURCE_CONNECTOR_CURSOR_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("SOURCE_CONNECTOR_CURSOR_INVALID");
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    (candidate.from !== null && typeof candidate.from !== "string") ||
    typeof candidate.target !== "string" ||
    !Number.isSafeInteger(candidate.offset) ||
    Number(candidate.offset) < 0
  ) {
    throw new Error("SOURCE_CONNECTOR_CURSOR_INVALID");
  }
  return {
    from: candidate.from as string | null,
    target: candidate.target,
    offset: Number(candidate.offset),
  };
}

export class LocalGitSourceConnector implements SourceConnectorPort {
  private readonly connectorId: string;
  private readonly includeExtensions: Set<string>;
  private readonly maxObjectBytes: number;

  constructor(
    private readonly store: GitKnowledgeStore,
    options: LocalGitSourceConnectorOptions = {},
  ) {
    this.connectorId = options.connectorId?.trim() || "local-git";
    this.includeExtensions = new Set(
      (options.includeExtensions ?? [".md", ".markdown"]).map((extension) =>
        extension.toLowerCase(),
      ),
    );
    this.maxObjectBytes = options.maxObjectBytes ?? 1_000_000;
    if (
      !Number.isSafeInteger(this.maxObjectBytes) ||
      this.maxObjectBytes < 1 ||
      this.maxObjectBytes > 10_000_000
    ) {
      throw new Error("SOURCE_CONNECTOR_MAX_OBJECT_BYTES_INVALID");
    }
  }

  describe(): SourceConnectorDescriptor {
    return {
      schemaVersion: 1,
      connectorId: this.connectorId,
      sourceSystem: "git-local",
      objectTypes: ["MARKDOWN_FILE"],
      incremental: { cursor: true, webhook: false },
      permissionFidelity: "WORKSPACE_WIDE",
      replication: "FULL_MIRROR",
      dataResidency: "LOCAL",
      attachments: { supported: false },
      rateLimit: { kind: "NONE" },
      checkpointModel: "REVISION",
      deletionPropagation: "TOMBSTONE",
      sourceVersioning: true,
      contentTrust: "UNTRUSTED_EXTERNAL",
    };
  }

  async checkpoint(
    _scope: SourceConnectorScope = {},
  ): Promise<SourceConnectorCheckpoint> {
    return { kind: "REVISION", value: await this.store.revision() };
  }

  private assertRevisionCheckpoint(
    checkpoint: SourceConnectorCheckpoint,
  ): string {
    if (
      checkpoint.kind !== "REVISION" ||
      !/^[a-f0-9]{40,64}$/iu.test(checkpoint.value)
    ) {
      throw new Error("SOURCE_CONNECTOR_CHECKPOINT_INVALID");
    }
    return checkpoint.value;
  }

  private includedPath(relativePath: string): boolean {
    return this.includeExtensions.has(
      path.posix.extname(relativePath).toLowerCase(),
    );
  }

  private async objectAt(
    revision: string,
    entry: { path: string; blob: string; mode: string },
  ): Promise<SourceConnectorObject | null> {
    // Git symlinks are blobs with mode 120000. Never turn their target text
    // into mirrored source content.
    if (
      !["100644", "100755"].includes(entry.mode) ||
      !this.includedPath(entry.path)
    ) {
      return null;
    }
    const content = await this.store.showFile(revision, entry.path);
    if (Buffer.byteLength(content, "utf8") > this.maxObjectBytes) {
      throw new Error("SOURCE_CONNECTOR_OBJECT_TOO_LARGE");
    }
    return {
      objectId: entry.path,
      objectType: "MARKDOWN_FILE",
      sourceSystem: "git-local",
      sourceVersion: entry.blob,
      operation: "UPSERT",
      path: entry.path,
      title: path.posix.basename(entry.path),
      content,
      contentType: "text/markdown",
      contentTrust: "UNTRUSTED_EXTERNAL",
      permissions: {
        fidelity: "WORKSPACE_WIDE",
        uncertain: false,
      },
      attachments: [],
      metadata: {
        gitRevision: revision,
        gitMode: entry.mode,
        blob: entry.blob,
      },
    };
  }

  async pullPage(
    request: SourceConnectorPullRequest,
  ): Promise<SourceConnectorPullPage> {
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 500
    ) {
      throw new Error("SOURCE_CONNECTOR_PULL_LIMIT_INVALID");
    }
    const target = this.assertRevisionCheckpoint(request.target);
    const from = request.from
      ? this.assertRevisionCheckpoint(request.from)
      : null;
    let offset = 0;
    if (request.pageCursor) {
      const cursor = decodeGitConnectorCursor(request.pageCursor);
      if (cursor.target !== target || cursor.from !== from) {
        throw new Error("SOURCE_CONNECTOR_CURSOR_SCOPE_MISMATCH");
      }
      offset = cursor.offset;
    }

    const targetEntries = new Map(
      (await this.store.listTreeEntries(target)).map((entry) => [
        entry.path,
        entry,
      ]),
    );
    const fromEntries = from
      ? new Map(
          (await this.store.listTreeEntries(from)).map((entry) => [
            entry.path,
            entry,
          ]),
        )
      : new Map<string, { path: string; blob: string; mode: string }>();

    const changedPaths = [
      ...new Set([...targetEntries.keys(), ...fromEntries.keys()]),
    ]
      .filter((relativePath) => {
        const current = targetEntries.get(relativePath);
        const previous = fromEntries.get(relativePath);
        if (!this.includedPath(relativePath)) return false;
        return (
          current?.blob !== previous?.blob || current?.mode !== previous?.mode
        );
      })
      .sort();

    const pagePaths = changedPaths.slice(offset, offset + request.limit);
    const objects: SourceConnectorObject[] = [];
    for (const relativePath of pagePaths) {
      const current = targetEntries.get(relativePath);
      if (!current || !["100644", "100755"].includes(current.mode)) {
        if (fromEntries.has(relativePath)) {
          objects.push({
            objectId: relativePath,
            objectType: "MARKDOWN_FILE",
            sourceSystem: "git-local",
            sourceVersion: target,
            operation: "DELETE",
            path: relativePath,
            contentTrust: "UNTRUSTED_EXTERNAL",
            permissions: {
              fidelity: "WORKSPACE_WIDE",
              uncertain: false,
            },
            attachments: [],
            metadata: {
              gitRevision: target,
              tombstone: true,
            },
          });
        }
        continue;
      }
      const object = await this.objectAt(target, current);
      if (object) objects.push(object);
    }

    const nextOffset = offset + pagePaths.length;
    const completed = nextOffset >= changedPaths.length;
    return {
      objects,
      target: request.target,
      nextPageCursor: completed
        ? null
        : encodeGitConnectorCursor({ from, target, offset: nextOffset }),
      completed,
    };
  }

  async *pull(
    input: SourceConnectorPullInput,
  ): AsyncIterable<SourceConnectorObject> {
    const limit = input.pageSize ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("SOURCE_CONNECTOR_PULL_LIMIT_INVALID");
    }
    let pageCursor: string | undefined;
    do {
      const page = await this.pullPage({
        ...(input.from ? { from: input.from } : {}),
        target: input.target,
        ...(pageCursor ? { pageCursor } : {}),
        limit,
      });
      for (const object of page.objects) {
        yield object;
      }
      pageCursor = page.nextPageCursor ?? undefined;
    } while (pageCursor);
  }

  async fetchById(
    input: SourceConnectorFetchInput,
  ): Promise<SourceConnectorObject | null>;
  async fetchById(
    objectId: string,
    checkpoint?: SourceConnectorCheckpoint,
  ): Promise<SourceConnectorObject | null>;
  async fetchById(
    inputOrObjectId: SourceConnectorFetchInput | string,
    checkpoint?: SourceConnectorCheckpoint,
  ): Promise<SourceConnectorObject | null> {
    const objectId =
      typeof inputOrObjectId === "string"
        ? inputOrObjectId
        : inputOrObjectId.objectId;
    const resolvedCheckpoint =
      typeof inputOrObjectId === "string"
        ? checkpoint
        : inputOrObjectId.checkpoint;
    const scope =
      typeof inputOrObjectId === "string" ? {} : inputOrObjectId.scope;
    const revision = resolvedCheckpoint
      ? this.assertRevisionCheckpoint(resolvedCheckpoint)
      : (await this.checkpoint(scope)).value;
    const entry = (await this.store.listTreeEntries(revision)).find(
      (candidate) => candidate.path === objectId,
    );
    if (!entry) return null;
    return this.objectAt(revision, entry);
  }
}
