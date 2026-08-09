import "dotenv/config";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { Postgres } from "@akp/postgres";
import {
  importVaultReadOnly,
  inspectVault,
  latestImportStatus,
  renderImportReport,
} from "@akp/vault-importer";
import {
  compareEvaluationRuns,
  summarizePacketBenchmark,
  type JsonRecord,
  type PacketObservation,
} from "./metrics.js";

function database(): Postgres {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl)
    throw new Error("DATABASE_URL is required (copy .env.example to .env).");
  return new Postgres(databaseUrl);
}

function writeReport(reportPath: string, contents: string): boolean {
  try {
    writeFileSync(reportPath, contents, "utf8");
    return true;
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }

  // Some Windows Controlled Folder Access configurations reject Node writes to
  // Documents while permitting an explicit PowerShell copy. Keep the fallback
  // narrow, argument-safe and auditable.
  const temporaryPath = path.join(tmpdir(), `akp-report-${process.pid}.md`);
  writeFileSync(temporaryPath, contents, "utf8");
  const copy = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Copy-Item -LiteralPath $env:AKP_REPORT_SOURCE -Destination $env:AKP_REPORT_TARGET -Force",
    ],
    {
      env: {
        ...process.env,
        AKP_REPORT_SOURCE: temporaryPath,
        AKP_REPORT_TARGET: reportPath,
      },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  try {
    unlinkSync(temporaryPath);
  } catch {
    // The operating system will eventually clean its temporary directory.
  }
  if (copy.status !== 0) {
    console.warn(
      `Report persistence was blocked by Windows folder policy: ${copy.stderr || copy.stdout}`,
    );
    return false;
  }
  return true;
}

async function withDatabase<T>(
  operation: (db: Postgres) => Promise<T>,
): Promise<T> {
  const db = database();
  try {
    return await operation(db);
  } finally {
    await db.close();
  }
}

async function api<T = unknown>(route: string, init?: RequestInit): Promise<T> {
  const base = process.env.AKP_API_URL ?? "http://127.0.0.1:8080";
  const token = process.env.AKP_API_TOKEN;
  if (!token) throw new Error("AKP_API_TOKEN is required for API commands.");
  const response = await fetch(`${base}${route}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(String(init?.method ?? "GET").toUpperCase() === "POST"
        ? { "idempotency-key": `cli-${randomUUID()}` }
        : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as T;
  if (!response.ok)
    throw new Error(`AKP API ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received: ${value}`);
  }
  return parsed;
}

async function runDefaultEvaluation(): Promise<void> {
  printJson(await api("/v1/evals/run", { method: "POST", body: "{}" }));
}

const program = new Command()
  .name("akp")
  .description("Architecture Knowledge Platform command-line interface")
  .version("0.1.0");

const vault = program
  .command("vault")
  .description("Read-only vault operations");

vault
  .command("import")
  .requiredOption("--vault-path <path>", "Path to the existing knowledge vault")
  .option(
    "--read-only",
    "Acknowledge that the source vault must remain read-only",
  )
  .option("--report-dir <path>", "Report directory", "reports/migration")
  .action(
    async (options: {
      vaultPath: string;
      readOnly?: boolean;
      reportDir: string;
    }) => {
      if (!options.readOnly) {
        throw new Error(
          "The initial vault import is restricted to --read-only.",
        );
      }
      const reportDir = path.resolve(options.reportDir);
      await mkdir(reportDir, { recursive: true });
      const reportPath = path.join(reportDir, "vault-import-latest.md");
      const result = await withDatabase((db) =>
        importVaultReadOnly(db, options.vaultPath, { reportPath }),
      );
      const reportPersisted = writeReport(
        reportPath,
        renderImportReport(result),
      );
      console.log(
        JSON.stringify(
          {
            runId: result.runId,
            status: result.status,
            revision: result.revision,
            readOnly: true,
            metrics: result.metrics,
            issueCount: result.issues.length,
            reportPath,
            reportPersisted,
          },
          null,
          2,
        ),
      );
    },
  );

vault
  .command("status")
  .option("--vault-path <path>", "Limit status to one canonical vault path")
  .action(async (options: { vaultPath?: string }) => {
    const result = await withDatabase((db) =>
      latestImportStatus(db, options.vaultPath),
    );
    console.log(
      JSON.stringify(result ?? { status: "NEVER_IMPORTED" }, null, 2),
    );
  });

vault
  .command("diff")
  .requiredOption("--vault-path <path>", "Path to the existing knowledge vault")
  .action(async (options: { vaultPath: string }) => {
    const current = await inspectVault(options.vaultPath);
    const previous = await withDatabase((db) =>
      latestImportStatus(db, options.vaultPath),
    );
    const previousRevision =
      previous && typeof previous.revision === "string"
        ? previous.revision
        : null;
    console.log(
      JSON.stringify(
        {
          changed: previousRevision !== current.revision,
          importedRevision: previousRevision,
          currentRevision: current.revision,
          metrics: current.metrics,
        },
        null,
        2,
      ),
    );
  });

program.command("doctor").action(async () => {
  const result = await withDatabase(async (db) => ({
    database: await db.health(),
    node: process.version,
    platform: process.platform,
    cwd: process.cwd(),
  }));
  console.log(JSON.stringify(result, null, 2));
});

program.command("status").action(async () => {
  console.log(JSON.stringify(await api("/v1/status"), null, 2));
});

program
  .command("search")
  .argument("<query>")
  .option("--limit <number>", "Maximum hits", "10")
  .option("--mode <mode>", "Retrieval mode", "SOURCE_BACKED")
  .action(async (query: string, options: { limit: string; mode: string }) => {
    console.log(
      JSON.stringify(
        await api("/v1/search", {
          method: "POST",
          body: JSON.stringify({
            query,
            limit: Number(options.limit),
            mode: options.mode,
          }),
        }),
        null,
        2,
      ),
    );
  });

program
  .command("context")
  .argument("<query>")
  .option("--intent <intent>", "Agent intent", "architecture guidance")
  .option("--max-tokens <number>", "Context budget", "6000")
  .action(
    async (query: string, options: { intent: string; maxTokens: string }) => {
      console.log(
        JSON.stringify(
          await api("/v1/context", {
            method: "POST",
            body: JSON.stringify({
              query,
              intent: options.intent,
              maxTokens: Number(options.maxTokens),
            }),
          }),
          null,
          2,
        ),
      );
    },
  );

program
  .command("ingest")
  .argument("<source>")
  .option("--title <title>")
  .option("--media-type <mediaType>")
  .action(
    async (source: string, options: { title?: string; mediaType?: string }) => {
      console.log(
        JSON.stringify(
          await api("/v1/ingest", {
            method: "POST",
            body: JSON.stringify({
              spaceId: "00000000-0000-0000-0000-000000000003",
              sourceUri: path.resolve(source),
              policy: "REVIEW_REQUIRED",
              ...(options.title ? { title: options.title } : {}),
              ...(options.mediaType ? { mediaType: options.mediaType } : {}),
            }),
          }),
          null,
          2,
        ),
      );
    },
  );

program.command("reviews").action(async () => {
  console.log(JSON.stringify(await api("/v1/reviews"), null, 2));
});

program
  .command("review")
  .argument("<id>")
  .requiredOption("--decision <decision>", "APPROVE, REJECT or REQUEST_CHANGES")
  .option("--reason <reason>", "Decision rationale", "Reviewed through CLI")
  .action(async (id: string, options: { decision: string; reason: string }) => {
    console.log(
      JSON.stringify(
        await api(`/v1/reviews/${id}/decision`, {
          method: "POST",
          body: JSON.stringify(options),
        }),
        null,
        2,
      ),
    );
  });

const evaluation = program
  .command("eval")
  .description("Run and compare persisted evaluation results")
  .action(runDefaultEvaluation);

evaluation
  .command("run")
  .description("Run the checked-in critical evaluation suite")
  .action(runDefaultEvaluation);

evaluation
  .command("compare [baseline] [candidate]")
  .description(
    "Compare two persisted evaluation runs (candidate minus baseline)",
  )
  .option("--baseline <run-id>", "Baseline eval run ID")
  .option("--candidate <run-id>", "Candidate eval run ID")
  .action(
    async (
      baselineArgument: string | undefined,
      candidateArgument: string | undefined,
      options: { baseline?: string; candidate?: string },
    ) => {
      const baselineId = options.baseline ?? baselineArgument;
      const candidateId = options.candidate ?? candidateArgument;
      if (Boolean(baselineId) !== Boolean(candidateId)) {
        throw new Error(
          "Provide both --baseline and --candidate, or omit both.",
        );
      }

      const response = await api<{ runs?: JsonRecord[] }>("/v1/evals");
      const runs = response.runs ?? [];
      let baseline: JsonRecord | undefined;
      let candidate: JsonRecord | undefined;

      if (baselineId && candidateId) {
        baseline = runs.find(
          (run) => String(run.id ?? run.runId ?? "") === baselineId,
        );
        candidate = runs.find(
          (run) => String(run.id ?? run.runId ?? "") === candidateId,
        );
        if (!baseline)
          throw new Error(`Baseline eval run not found: ${baselineId}`);
        if (!candidate)
          throw new Error(`Candidate eval run not found: ${candidateId}`);
      } else {
        [candidate, baseline] = runs;
        if (!baseline || !candidate) {
          throw new Error(
            "At least two persisted eval runs are required for comparison.",
          );
        }
      }

      printJson(compareEvaluationRuns(baseline, candidate));
    },
  );

const benchmark = program
  .command("benchmark")
  .description("Run measured platform benchmarks");

benchmark
  .command("retrieval")
  .description("Execute the server retrieval configuration comparison matrix")
  .action(async () => {
    printJson(await api("/v1/evals/benchmark", { method: "POST", body: "{}" }));
  });

benchmark
  .command("packet")
  .description("Measure real context-packet generation for one query")
  .argument("<query>", "Query used to build each context packet")
  .option(
    "--runs <count>",
    "Number of observed packet builds",
    positiveInteger,
    3,
  )
  .option("--max-tokens <count>", "Packet token budget", positiveInteger, 6000)
  .option(
    "--limit <count>",
    "Maximum retrieval hits per packet",
    positiveInteger,
    20,
  )
  .option("--intent <intent>", "Packet intent", "architecture guidance")
  .option("--mode <mode>", "Retrieval mode", "SOURCE_BACKED")
  .option("--space-id <space-id>", "Explicit target space UUID")
  .action(
    async (
      query: string,
      options: {
        runs: number;
        maxTokens: number;
        limit: number;
        intent: string;
        mode: string;
        spaceId?: string;
      },
    ) => {
      const observations: PacketObservation[] = [];
      for (let index = 0; index < options.runs; index += 1) {
        const started = performance.now();
        const packet = await api<JsonRecord>("/v1/context", {
          method: "POST",
          body: JSON.stringify({
            query,
            maxTokens: options.maxTokens,
            limit: options.limit,
            intent: options.intent,
            mode: options.mode,
            ...(options.spaceId ? { spaceId: options.spaceId } : {}),
          }),
        });
        observations.push({ latencyMs: performance.now() - started, packet });
      }
      printJson(summarizePacketBenchmark(query, observations));
    },
  );

const schema = program
  .command("schema")
  .description("Knowledge-schema governance commands");

schema
  .command("dry-run")
  .requiredOption("--version <version>", "Candidate schema version")
  .option("--require <fields...>", "Required frontmatter fields")
  .option("--allow-type <types...>", "Allowed knowledge document types")
  .option("--space-id <space-id>", "Explicit target space UUID")
  .action(
    async (options: {
      version: string;
      require?: string[];
      allowType?: string[];
      spaceId?: string;
    }) => {
      printJson(
        await api("/v1/schema/dry-run", {
          method: "POST",
          body: JSON.stringify({
            candidateVersion: options.version,
            requiredFrontmatterFields: options.require ?? [],
            allowedTypes: options.allowType ?? [],
            ...(options.spaceId ? { spaceId: options.spaceId } : {}),
          }),
        }),
      );
    },
  );

const lint = program
  .command("lint")
  .description("Deterministic knowledge lint commands");

lint
  .command("run")
  .option("--trigger <trigger>", "MANUAL or SCHEDULED", "MANUAL")
  .action(async (options: { trigger: string }) => {
    printJson(
      await api("/v1/lint/run", {
        method: "POST",
        body: JSON.stringify({ trigger: options.trigger.toUpperCase() }),
      }),
    );
  });

program.configureOutput({
  outputError: (message, write) => write(`ERROR: ${message}`),
});

await program.parseAsync(process.argv);
