import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
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

  constructor(config: GraphifyCodeGraphAdapterConfig) {
    if (!config.executable.trim()) {
      throw graphifyError("GRAPHIFY_EXECUTABLE_REQUIRED");
    }
    this.config = {
      ...config,
      executable: config.executable.trim(),
      executableArgs: [...(config.executableArgs ?? [])],
    };
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

    try {
      const versionResult = await runBoundedProcess(
        this.config.executable,
        [...(this.config.executableArgs ?? []), "--version"],
        {
          cwd: workspace,
          env,
          timeoutMs: Math.min(options.timeoutMs, 30_000),
          maxOutputBytes: Math.min(
            options.maxProcessOutputBytes,
            1024 * 1024,
          ),
        },
      );
      const providerVersion = parseGraphifyVersion(
        versionResult.stdout + "\n" + versionResult.stderr,
      );
      const configHash = configurationHash({
        adapter: "akp-graphify-v1",
        provider: "graphify",
        providerVersion,
        exclusions: options.exclusions,
        providerConfiguration: options.providerConfiguration,
      });

      const materialized = await materializeCodeSnapshot(
        snapshot,
        options,
        workspace,
      );
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

      return normalizeGraphifyArtifact({
        raw: parseGraphifyPayload(parsed),
        snapshot,
        repositoryRoot: materialized.repositoryRoot,
        providerVersion,
        configurationHash: configHash,
        outputHash: sha256GraphifyOutput(output),
        warnings: materialized.warnings,
      });
    } finally {
      if (!this.config.keepWorkspace) {
        await rm(workspace, { recursive: true, force: true }).catch(
          () => undefined,
        );
      }
    }
  }
}

export { DEFAULT_CODE_GRAPH_EXCLUSIONS } from "./graphify-materialize.js";
