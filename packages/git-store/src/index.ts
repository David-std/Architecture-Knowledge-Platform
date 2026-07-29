import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const exec = promisify(execFile);

export class GitKnowledgeStore {
  constructor(private readonly repositoryPath: string) {}

  private async git(args: string[]): Promise<string> {
    const result = await exec("git", ["-C", this.repositoryPath, ...args], {
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });
    return result.stdout.trim();
  }

  revision(): Promise<string> {
    return this.git(["rev-parse", "HEAD"]);
  }

  async createDraftBranch(reviewId: string, baseRevision: string): Promise<string> {
    const branch = `draft/${reviewId}`;
    await this.git(["checkout", "--detach", baseRevision]);
    await this.git(["checkout", "-B", branch]);
    return branch;
  }

  async commitAll(message: string, authorName: string, authorEmail: string): Promise<string> {
    await this.git(["add", "--all"]);
    await this.git([
      "-c", `user.name=${authorName}`,
      "-c", `user.email=${authorEmail}`,
      "commit", "--allow-empty", "-m", message,
    ]);
    return this.revision();
  }

  async showFile(revision: string, relativePath: string): Promise<string> {
    const normalized = path.posix.normalize(relativePath.replaceAll("\\", "/"));
    if (normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
      throw new Error("Unsafe knowledge path");
    }
    return this.git(["show", `${revision}:${normalized}`]);
  }
}
