import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

export type CodeEvidenceTier =
  | "NO_SIGNAL"
  | "AI_CANDIDATE"
  | "STATICALLY_LINKED"
  | "RUNTIME_COVERED"
  | "DYNAMICALLY_PROVEN";

export interface CodeLocator {
  repository: string;
  commit: string;
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
}

export interface CodeEvidence {
  id: string;
  tier: CodeEvidenceTier;
  behavior: string;
  locator: CodeLocator;
  relatedTests: CodeLocator[];
  generatedBy: "DETERMINISTIC" | "AI_CANDIDATE";
  metadata: Record<string, unknown>;
}

export interface ProjectAdapter {
  scan(input: {
    repositoryPath: string;
    commit: string;
    changedSince?: string;
  }): Promise<CodeEvidence[]>;
}

export function maySupportVerifiedClaim(evidence: CodeEvidence): boolean {
  return (
    evidence.generatedBy === "DETERMINISTIC" &&
    ["STATICALLY_LINKED", "RUNTIME_COVERED", "DYNAMICALLY_PROVEN"].includes(
      evidence.tier,
    )
  );
}

function evidenceId(
  repository: string,
  commit: string,
  locator: string,
): string {
  return `CODE-${createHash("sha256")
    .update(`${repository}\0${commit}\0${locator}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase()}`;
}

export class DeterministicProjectAdapter implements ProjectAdapter {
  async scan(input: {
    repositoryPath: string;
    commit: string;
    changedSince?: string;
  }): Promise<CodeEvidence[]> {
    const root = path.resolve(input.repositoryPath);
    if (input.changedSince && !/^[a-f0-9]{40}$/i.test(input.changedSince)) {
      throw new Error("IMMUTABLE_CHANGED_SINCE_COMMIT_REQUIRED");
    }
    const verified = spawnSync(
      "git",
      ["-C", root, "rev-parse", "--verify", `${input.commit}^{commit}`],
      {
        encoding: "utf8",
        windowsHide: true,
      },
    );
    const immutableCommit =
      verified.status === 0 ? verified.stdout.trim() : null;
    const verifiedChangedSince =
      immutableCommit && input.changedSince
        ? spawnSync(
            "git",
            [
              "-C",
              root,
              "rev-parse",
              "--verify",
              `${input.changedSince}^{commit}`,
            ],
            { encoding: "utf8", windowsHide: true },
          )
        : null;
    if (verifiedChangedSince && verifiedChangedSince.status !== 0) {
      throw new Error("IMMUTABLE_CHANGED_SINCE_COMMIT_REQUIRED");
    }
    const resolvedChangedSince =
      verifiedChangedSince?.stdout.trim() || undefined;
    const worktreeFiles = async (): Promise<string[]> =>
      fg(
        [
          "**/package.json",
          "**/pom.xml",
          "**/build.gradle",
          "**/build.gradle.kts",
          "**/*.csproj",
          "**/*.{java,cs,ts,tsx,vue}",
        ],
        {
          cwd: root,
          onlyFiles: true,
          ignore: [
            "**/node_modules/**",
            "**/dist/**",
            "**/build/**",
            "**/bin/**",
            "**/obj/**",
          ],
        },
      );
    const committedFiles = (): string[] => {
      if (!immutableCommit) return [];
      const listed = spawnSync(
        "git",
        ["-C", root, "ls-tree", "-r", "--name-only", immutableCommit],
        {
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      if (listed.status !== 0) return [];
      return listed.stdout
        .split(/\r?\n/)
        .filter((file) =>
          /(^|\/)(package\.json|pom\.xml|build\.gradle(?:\.kts)?|[^/]+\.csproj)$|\.(java|cs|ts|tsx|vue)$/i.test(
            file,
          ),
        );
    };
    const files = (immutableCommit ? committedFiles() : await worktreeFiles())
      .map((file) => file.replaceAll("\\", "/"))
      .sort();
    const changedFiles = new Set<string>();
    if (immutableCommit && resolvedChangedSince) {
      const changed = spawnSync(
        "git",
        [
          "-C",
          root,
          "diff",
          "--name-only",
          `${resolvedChangedSince}..${immutableCommit}`,
        ],
        { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      );
      if (changed.status === 0) {
        for (const file of changed.stdout.split(/\r?\n/).filter(Boolean)) {
          changedFiles.add(file.replaceAll("\\", "/"));
        }
      }
    }
    const evidence: CodeEvidence[] = [];
    for (const relativePath of files.slice(0, 5000)) {
      const content = immutableCommit
        ? (() => {
            const shown = spawnSync(
              "git",
              ["-C", root, "show", `${immutableCommit}:${relativePath}`],
              {
                encoding: "utf8",
                windowsHide: true,
                maxBuffer: 16 * 1024 * 1024,
              },
            );
            return shown.status === 0 ? shown.stdout : "";
          })()
        : await readFile(
            path.join(root, ...relativePath.split("/")),
            "utf8",
          ).catch(() => "");
      const signals: Array<{ behavior: string; pattern: RegExp }> = [
        {
          behavior: "Spring REST adapter is present.",
          pattern: /@RestController\b/,
        },
        {
          behavior: "Spring application service stereotype is present.",
          pattern: /@Service\b/,
        },
        {
          behavior: "JPA persistence adapter signal is present.",
          pattern: /@Entity\b|JpaRepository\b/,
        },
        {
          behavior: "ASP.NET API adapter is present.",
          pattern: /\[ApiController\]|ControllerBase\b/,
        },
        {
          behavior: "Angular presentation component is present.",
          pattern: /@Component\s*\(/,
        },
        {
          behavior: "Vue component or composable is present.",
          pattern: /<template>|defineComponent\(|\buse[A-Z]\w+\(/,
        },
        {
          behavior: "Automated test signal is present.",
          pattern: /\b(describe|it|test|Fact|Theory|Test)\s*[\(\[]/,
        },
      ];
      for (const signal of signals) {
        const match = signal.pattern.exec(content);
        if (!match) continue;
        const startLine = content.slice(0, match.index).split(/\r?\n/).length;
        const locator: CodeLocator = {
          repository: root,
          commit: input.commit,
          path: relativePath,
          startLine,
          endLine: startLine,
        };
        evidence.push({
          id: evidenceId(
            root,
            input.commit,
            `${relativePath}:${startLine}:${signal.behavior}`,
          ),
          tier: "NO_SIGNAL",
          behavior: signal.behavior,
          locator,
          relatedTests: [],
          generatedBy: "DETERMINISTIC",
          metadata: {
            changedSince: resolvedChangedSince ?? null,
            changedInRange: resolvedChangedSince
              ? changedFiles.has(relativePath)
              : null,
            snapshotMode: immutableCommit
              ? "IMMUTABLE_GIT_COMMIT"
              : "WORKTREE_NON_IMMUTABLE",
            resolvedCommit: immutableCommit,
            limitation:
              "A structural regex signal does not prove a dependency, runtime behavior, or architectural intent.",
          },
        });
      }
    }
    return evidence;
  }
}

export * from "./snapshot.js";
