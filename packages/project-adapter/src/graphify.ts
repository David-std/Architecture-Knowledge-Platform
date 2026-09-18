import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CodeGraphOptions as CodeGraphOptionsSchema,
  CodeSnapshot as CodeSnapshotSchema,
} from "@akp/contracts";
import type {
  CodeGraphArtifact,
  CodeGraphExtractionPort,
  CodeGraphOptions,
  CodeGraphWarning,
  CodeSnapshot,
} from "@akp/contracts";
import {
  DEFAULT_CODE_GRAPH_EXCLUSIONS,
  materializeCodeSnapshot,
} from "./graphify-materialize.js";
import {
  normalizeGraphifyArtifact,
  parseGraphifyPayload,
  sha256GraphifyOutput,
} from "./graphify-normalize.js";
import {
  parseGraphifyVersion,
  runBoundedProcess,
  safeGraphifyEnvironment,
} from "./graphify-process.js";

export interface GraphifyCodeGraphAdapterConfig {
  executable: string;
  executableArgs?: readonly string[];
  workingRoot?: string;
  keepWorkspace?: boolean;
  incremental?: boolean;
}

type GraphifyExecutionMode = "FULL" | "INCREMENTAL" | "FULL_FALLBACK";

interface GraphifyIncrementalState {
  workspace: string;
  commitSha: string;
}

function graphifyError(code: string): Error {
  const value = new Error(code) as Error & { code?: string };
  value.code = code;
  return value;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function configurationHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

function safeIncrementalFailureCode(error: unknown): string {
  if (!error || typeof error !== "object") return "GRAPHIFY_INCREMENTAL_FAILED";
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" &&
    /^[A-Z][A-Z0-9_]{2,80}$/.test(message)
    ? message
    : "GRAPHIFY_INCREMENTAL_FAILED";
}

export function defaultCodeGraphOptions(): CodeGraphOptions {
  return CodeGraphOptionsSchema.parse({
    exclusions: {
      patterns: [...DEFAULT_CODE_GRAPH_EXCLUSIONS],
      maxFileBytes: 4 * 1024 * 1024,
    },
    timeoutMs: 5 * 60 * 1000,
    maxProcessOutputBytes: 16 * 1024 * 1024,
    maxGraphBytes: 128 * 1024 * 1024,
    providerConfiguration: {},
  });
}

export class GraphifyCodeGraphAdapter implements CodeGraphExtractionPort {
  readonly config: GraphifyCodeGraphAdapterConfig;
  private readonly incrementalStates = new Map<
    string,
    GraphifyIncrementalState
  >();
  private readonly stateLocks = new Map<string, Promise<void>>();

  constructor(config: GraphifyCodeGraphAdapterConfig) {
    if (!config.executable.trim()) {
      throw graphifyError("GRAPHIFY_EXECUTABLE_REQUIRED");
    }
    this.config = {
      ...config,
      executable: config.executable.trim(),
      executableArgs: [...(config.executableArgs ?? [])],
      incremental: config.incremental === true,
    };
  }

  private async withStateLock<T>(
    key: string,
    task: () => Promise<T>,
  ): Promise<T> {
    const previous = this.stateLocks.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.stateLocks.set(key, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (this.stateLocks.get(key) === tail) {
        this.stateLocks.delete(key);
      }
    }
  }

  async analyze(
    rawSnapshot: CodeSnapshot,
    rawOptions: CodeGraphOptions,
  ): Promise<CodeGraphArtifact> {
    const snapshot = CodeSnapshotSchema.parse(rawSnapshot);
    const options = CodeGraphOptionsSchema.parse(rawOptions);
    const workBase = path.resolve(this.config.workingRoot ?? os.tmpdir());
    await mkdir(workBase, { recursive: true });
    const workspace = await mkdtemp(path.join(workBase, "akp-graphify-"));
    const home = path.join(workspace, "home");
    await mkdir(path.join(home, "tmp"), { recursive: true });
    await mkdir(path.join(home, ".cache"), { recursive: true });
    const env = safeGraphifyEnvironment(home);

    const versionResult = await runBoundedProcess(
      this.config.executable,
      [...(this.config.executableArgs ?? []), "--version"],
      {
        cwd: workspace,
        env,
        timeoutMs: Math.min(options.timeoutMs, 30_000),
        maxOutputBytes: Math.min(options.maxProcessOutputBytes, 1024 * 1024),
      },
    ).catch(async (error) => {
      if (!this.config.keepWorkspace) {
        await rm(workspace, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
      throw error;
    });
    const providerVersion = parseGraphifyVersion(
      versionResult.stdout + "\n" + versionResult.stderr,
    );
    const configHash = configurationHash({
      adapter: "akp-graphify-v2",
      provider: "graphify",
      providerVersion,
      exclusions: options.exclusions,
      providerConfiguration: options.providerConfiguration,
    });
    const stateKey = configurationHash({
      repository: snapshot.repository,
      provider: "graphify",
      providerVersion,
      configurationHash: configHash,
    });

    return await this.withStateLock(stateKey, async () => {
      let preserveWorkspace = false;
      try {
        const materialized = await materializeCodeSnapshot(
          snapshot,
          options,
          workspace,
        );
        const warnings: CodeGraphWarning[] = [...materialized.warnings];
        let executionMode: GraphifyExecutionMode = "FULL";
        let previousCommitSha: string | undefined;
        const previous = this.config.incremental
          ? this.incrementalStates.get(stateKey)
          : undefined;
        const previousOutput = previous
          ? path.join(previous.workspace, "repository", "graphify-out")
          : null;
        const previousOutputInfo =
          previousOutput && previous?.commitSha !== snapshot.commitSha
            ? await stat(previousOutput).catch(() => null)
            : null;

        if (previous && previousOutput && previousOutputInfo?.isDirectory()) {
          previousCommitSha = previous.commitSha;
          executionMode = "INCREMENTAL";
          try {
            await cp(
              previousOutput,
              path.join(materialized.repositoryRoot, "graphify-out"),
              { recursive: true },
            );
            await runBoundedProcess(
              this.config.executable,
              [
                ...(this.config.executableArgs ?? []),
                "update",
                ".",
                "--no-cluster",
              ],
              {
                cwd: materialized.repositoryRoot,
                env,
                timeoutMs: options.timeoutMs,
                maxOutputBytes: options.maxProcessOutputBytes,
              },
            );
          } catch (error) {
            executionMode = "FULL_FALLBACK";
            warnings.push({
              code: "CODE_GRAPH_INCREMENTAL_FALLBACK_FULL",
              message:
                "Incremental provider refresh failed; AKP performed a full rebuild and retained the prior provider state until the replacement validated.",
              extensions: {
                provider: "graphify",
                errorCode: safeIncrementalFailureCode(error),
                previousCommitSha,
              },
            });
            await rm(path.join(materialized.repositoryRoot, "graphify-out"), {
              recursive: true,
              force: true,
            });
            await runBoundedProcess(
              this.config.executable,
              [
                ...(this.config.executableArgs ?? []),
                "extract",
                ".",
                "--code-only",
                "--no-viz",
                "--no-cluster",
              ],
              {
                cwd: materialized.repositoryRoot,
                env,
                timeoutMs: options.timeoutMs,
                maxOutputBytes: options.maxProcessOutputBytes,
              },
            );
          }
        } else {
          await runBoundedProcess(
            this.config.executable,
            [
              ...(this.config.executableArgs ?? []),
              "extract",
              ".",
              "--code-only",
              "--no-viz",
              "--no-cluster",
            ],
            {
              cwd: materialized.repositoryRoot,
              env,
              timeoutMs: options.timeoutMs,
              maxOutputBytes: options.maxProcessOutputBytes,
            },
          );
        }

        const outputPath = path.join(
          materialized.repositoryRoot,
          "graphify-out",
          "graph.json",
        );
        const metadata = await stat(outputPath).catch(() => null);
        if (!metadata?.isFile()) {
          throw graphifyError("GRAPHIFY_OUTPUT_MISSING");
        }
        if (metadata.size > options.maxGraphBytes) {
          throw graphifyError("GRAPHIFY_GRAPH_OUTPUT_LIMIT");
        }
        const output = await readFile(outputPath);
        if (output.length > options.maxGraphBytes) {
          throw graphifyError("GRAPHIFY_GRAPH_OUTPUT_LIMIT");
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(output.toString("utf8"));
        } catch (cause) {
          const failure = graphifyError(
            "GRAPHIFY_OUTPUT_JSON_INVALID",
          ) as Error & { cause?: unknown };
          failure.cause = cause;
          throw failure;
        }

        const artifact = normalizeGraphifyArtifact({
          raw: parseGraphifyPayload(parsed),
          snapshot,
          repositoryRoot: materialized.repositoryRoot,
          providerVersion,
          configurationHash: configHash,
          outputHash: sha256GraphifyOutput(output),
          warnings,
          executionMode,
          ...(previousCommitSha ? { previousCommitSha } : {}),
        });

        if (this.config.incremental) {
          const replaced = this.incrementalStates.get(stateKey);
          this.incrementalStates.set(stateKey, {
            workspace,
            commitSha: snapshot.commitSha,
          });
          preserveWorkspace = true;
          if (
            replaced &&
            replaced.workspace !== workspace &&
            !this.config.keepWorkspace
          ) {
            await rm(replaced.workspace, {
              recursive: true,
              force: true,
            }).catch(() => undefined);
          }
        }

        return artifact;
      } finally {
        if (!preserveWorkspace && !this.config.keepWorkspace) {
          await rm(workspace, { recursive: true, force: true }).catch(
            () => undefined,
          );
        }
      }
    });
  }
}

export { DEFAULT_CODE_GRAPH_EXCLUSIONS } from "./graphify-materialize.js";
