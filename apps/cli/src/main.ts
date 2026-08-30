import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { Postgres, listVaults, registerVault } from "@akp/postgres";
import {
  importVaultReadOnly,
  inspectVault,
  latestImportStatus,
  renderImportReport,
  type VaultImportProfile,
} from "@akp/vault-importer";
import {
  compareEvaluationRuns,
  summarizePacketBenchmark,
  type JsonRecord,
  type PacketObservation,
} from "./metrics.js";
import {
  AUDIT_EXPORT_CONFIRMATION,
  AuditExportClientError,
  RAW_EVIDENCE_EXPORT_CONFIRMATION,
  requestRawEvidenceExport,
  requestAuditExport,
} from "./audit-export.js";

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

function readImportProfile(profilePath: string): VaultImportProfile {
  const parsed: unknown = JSON.parse(
    readFileSync(path.resolve(profilePath), "utf8"),
  );
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Import profile must be a JSON object.");
  }
  return parsed as VaultImportProfile;
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

async function runEvaluationTarget(options: {
  spaceId: string;
  vaultId: string;
  evalPack: string;
}): Promise<void> {
  printJson(
    await api("/v1/evals/run", {
      method: "POST",
      body: JSON.stringify(options),
    }),
  );
}

interface AuditCommandOptions {
  vaultId: string;
  confirm: string;
  output?: string;
  locator?: string;
  maxPackets?: number;
}

async function runAuditExportCommand(
  options: AuditCommandOptions,
): Promise<void> {
  try {
    printJson(
      await requestAuditExport({
        apiBase: process.env.AKP_API_URL ?? "http://127.0.0.1:8080",
        token: process.env.AKP_API_TOKEN ?? "",
        vaultId: options.vaultId,
        confirmation: options.confirm,
        ...(options.output ? { outputPath: options.output } : {}),
        ...(options.locator ? { locator: options.locator } : {}),
        ...(options.maxPackets ? { maxPackets: options.maxPackets } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof AuditExportClientError) {
      printJson({
        status: "FAILED",
        error: {
          code: error.code,
          status: error.status,
          details: error.details,
        },
      });
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

interface RawEvidenceCommandOptions {
  vaultId: string;
  evidenceId?: string;
  locator?: string;
  confirm: string;
  output?: string;
  maxBytes?: number;
}

async function runRawEvidenceExportCommand(
  options: RawEvidenceCommandOptions,
): Promise<void> {
  try {
    printJson(
      await requestRawEvidenceExport({
        apiBase: process.env.AKP_API_URL ?? "http://127.0.0.1:8080",
        token: process.env.AKP_API_TOKEN ?? "",
        vaultId: options.vaultId,
        ...(options.evidenceId ? { evidenceId: options.evidenceId } : {}),
        ...(options.locator ? { locator: options.locator } : {}),
        confirmation: options.confirm,
        ...(options.output ? { outputPath: options.output } : {}),
        ...(options.maxBytes ? { maxBytes: options.maxBytes } : {}),
      }),
    );
  } catch (error) {
    if (error instanceof AuditExportClientError) {
      printJson({
        status: "FAILED",
        error: {
          code: error.code,
          status: error.status,
          details: error.details,
        },
      });
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

function configureAuditExport(
  command: Command,
  options: { locatorRequired?: boolean; allowOutput?: boolean } = {},
): Command {
  command
    .requiredOption("--vault-id <uuid>", "Authorized vault UUID")
    .requiredOption(
      "--confirm <literal>",
      `Required literal: ${AUDIT_EXPORT_CONFIRMATION}`,
    )
    .option(
      "--max-packets <count>",
      "Maximum redacted packet manifests",
      positiveInteger,
    );
  if (options.locatorRequired) {
    command.requiredOption(
      "--locator <json>",
      "Evidence locator filter JSON (object or array)",
    );
  } else {
    command.option("--locator <json>", "Optional evidence locator filter JSON");
  }
  if (options.allowOutput !== false) {
    command.option(
      "--output <path>",
      "Explicit ZIP destination inside AKP_EXPORT_ROOTS",
    );
  }
  return command.action(runAuditExportCommand);
}

const program = new Command()
  .name("akp")
  .description("Architecture Knowledge Platform command-line interface")
  .version("0.1.0");

const auditExport = program
  .command("audit")
  .description("Sanitized external-review export commands");
configureAuditExport(
  auditExport.command("export").description("Export a sanitized audit ZIP"),
);
configureAuditExport(
  auditExport
    .command("export-vault")
    .description("Alias for a single-vault sanitized audit export"),
);

const evidenceExport = program
  .command("evidence")
  .description("Authorized evidence manifest operations");
configureAuditExport(
  evidenceExport
    .command("export")
    .description("Export metadata for matching evidence locators"),
  { locatorRequired: true },
);
const rawEvidenceExport = evidenceExport
  .command("export-raw")
  .description("Export one explicitly selected raw evidence object");
rawEvidenceExport
  .requiredOption("--vault-id <uuid>", "Authorized vault UUID")
  .option("--evidence-id <uuid>", "Evidence UUID selector")
  .option("--locator <json>", "Evidence locator selector JSON")
  .requiredOption(
    "--confirm <literal>",
    `Required literal: ${RAW_EVIDENCE_EXPORT_CONFIRMATION}`,
  )
  .option("--max-bytes <count>", "Maximum raw bytes", positiveInteger)
  .option(
    "--output <path>",
    "Explicit binary destination inside AKP_EXPORT_ROOTS",
  )
  .action(async (options: RawEvidenceCommandOptions) => {
    if (!options.evidenceId && !options.locator) {
      throw new Error("Provide --evidence-id or --locator.");
    }
    await runRawEvidenceExportCommand(options);
  });

const manifestExport = program
  .command("export")
  .description("External-review manifest operations");
configureAuditExport(
  manifestExport
    .command("manifest")
    .description("Inspect audit bundle metadata without writing a ZIP"),
  { allowOutput: false },
);

const vault = program
  .command("vault")
  .description("Read-only vault operations");

vault
  .command("import")
  .requiredOption("--vault-path <path>", "Path to the existing knowledge vault")
  .requiredOption("--space-id <uuid>", "Authorized space UUID")
  .option("--vault-key <key>", "Stable VaultRegistry key")
  .option("--eval-pack <name>", "Evaluation pack", "generic")
  .option(
    "--import-profile <path>",
    "Optional JSON profile containing vault-specific curation conventions",
  )
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
      spaceId: string;
      vaultKey?: string;
      evalPack: string;
      importProfile?: string;
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
        importVaultReadOnly(db, options.vaultPath, {
          spaceId: options.spaceId,
          reportPath,
          ...(options.vaultKey ? { vaultKey: options.vaultKey } : {}),
          evalPack: options.evalPack,
          ...(options.importProfile
            ? { profile: readImportProfile(options.importProfile) }
            : {}),
        }),
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
  .command("register")
  .requiredOption("--vault-key <key>", "Stable registry key")
  .requiredOption("--name <name>", "Human-readable vault name")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--local-path <path>", "Canonical local path")
  .option("--git-repository <uri>", "Git repository URI")
  .option("--visibility <visibility>", "PRIVATE, TEAM or CENTRAL", "PRIVATE")
  .option("--default-branch <branch>", "Default branch", "main")
  .option("--content-root <paths...>", "Content roots", ["."])
  .option("--source-root <paths...>", "Source roots", [])
  .option("--eval-pack <name>", "Evaluation pack", "generic")
  .action(
    async (options: {
      vaultKey: string;
      name: string;
      spaceId: string;
      localPath: string;
      gitRepository?: string;
      visibility: "PRIVATE" | "TEAM" | "CENTRAL";
      defaultBranch: string;
      contentRoot: string[];
      sourceRoot: string[];
      evalPack: string;
    }) => {
      const result = await withDatabase((db) =>
        registerVault(db, {
          vaultKey: options.vaultKey,
          name: options.name,
          spaceId: options.spaceId,
          visibility: options.visibility,
          gitRepository: options.gitRepository ?? null,
          defaultBranch: options.defaultBranch,
          localPath: path.resolve(options.localPath),
          contentRoots: options.contentRoot,
          sourceRoots: options.sourceRoot,
          schemaProfile: {},
          evalPack: {
            name: options.evalPack,
            version: "1",
            enabled: true,
            criticalCases: [],
          },
          retrievalConfig: {},
          permissions: {},
          enabled: true,
        }),
      );
      printJson(result);
    },
  );

vault
  .command("list")
  .requiredOption("--space-id <uuid...>", "Authorized space UUID(s)")
  .action(async (options: { spaceId: string[] }) => {
    printJson(await withDatabase((db) => listVaults(db, options.spaceId)));
  });

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
  .requiredOption("--space-id <uuid>", "Authorized space UUID")
  .requiredOption("--vault-id <uuid...>", "Target vault UUID(s)")
  .option("--federated", "Explicitly allow multiple-vault synthesis", false)
  .option("--limit <number>", "Maximum hits", "10")
  .option("--mode <mode>", "Retrieval mode", "SOURCE_BACKED")
  .action(
    async (
      query: string,
      options: {
        spaceId: string;
        vaultId: string[];
        federated: boolean;
        limit: string;
        mode: string;
      },
    ) => {
      console.log(
        JSON.stringify(
          await api("/v1/search", {
            method: "POST",
            body: JSON.stringify({
              query,
              spaceId: options.spaceId,
              vaultIds: options.vaultId,
              ...(options.vaultId.length === 1
                ? { vaultId: options.vaultId[0] }
                : {}),
              federated: options.federated,
              limit: Number(options.limit),
              mode: options.mode,
            }),
          }),
          null,
          2,
        ),
      );
    },
  );

program
  .command("context")
  .argument("<query>")
  .requiredOption("--space-id <uuid>", "Authorized space UUID")
  .requiredOption("--vault-id <uuid...>", "Target vault UUID(s)")
  .option("--federated", "Explicitly allow multiple-vault synthesis", false)
  .option("--intent <intent>", "Agent intent", "architecture guidance")
  .option("--max-tokens <number>", "Context budget", "6000")
  .action(
    async (
      query: string,
      options: {
        spaceId: string;
        vaultId: string[];
        federated: boolean;
        intent: string;
        maxTokens: string;
      },
    ) => {
      console.log(
        JSON.stringify(
          await api("/v1/context", {
            method: "POST",
            body: JSON.stringify({
              query,
              spaceId: options.spaceId,
              vaultIds: options.vaultId,
              ...(options.vaultId.length === 1
                ? { vaultId: options.vaultId[0] }
                : {}),
              federated: options.federated,
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
  .requiredOption("--space-id <uuid>", "Authorized space UUID")
  .requiredOption("--vault-id <uuid>", "Target vault UUID")
  .option("--title <title>")
  .option("--media-type <mediaType>")
  .action(
    async (
      source: string,
      options: {
        spaceId: string;
        vaultId: string;
        title?: string;
        mediaType?: string;
      },
    ) => {
      console.log(
        JSON.stringify(
          await api("/v1/ingest", {
            method: "POST",
            body: JSON.stringify({
              spaceId: options.spaceId,
              vaultId: options.vaultId,
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
  .description("Run and compare persisted evaluation results");

evaluation
  .command("run")
  .description("Run the checked-in critical evaluation suite")
  .requiredOption("--space-id <uuid>", "Authorized space UUID")
  .requiredOption("--vault-id <uuid>", "Target vault UUID")
  .option(
    "--eval-pack <name>",
    "Generic or registered vault eval pack",
    "generic",
  )
  .action(runEvaluationTarget);

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
  .requiredOption("--space-id <uuid>", "Authorized space UUID")
  .requiredOption("--vault-id <uuid>", "Target vault UUID")
  .option(
    "--eval-pack <name>",
    "Generic or registered vault eval pack",
    "generic",
  )
  .action(
    async (options: { spaceId: string; vaultId: string; evalPack: string }) => {
      printJson(
        await api("/v1/evals/benchmark", {
          method: "POST",
          body: JSON.stringify(options),
        }),
      );
    },
  );

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
  .requiredOption("--space-id <uuid>", "Authorized space UUID")
  .requiredOption("--vault-id <uuid...>", "Target vault UUID(s)")
  .option("--federated", "Explicitly allow multiple-vault synthesis", false)
  .action(
    async (
      query: string,
      options: {
        runs: number;
        maxTokens: number;
        limit: number;
        intent: string;
        mode: string;
        spaceId: string;
        vaultId: string[];
        federated: boolean;
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
            spaceId: options.spaceId,
            vaultIds: options.vaultId,
            ...(options.vaultId.length === 1
              ? { vaultId: options.vaultId[0] }
              : {}),
            federated: options.federated,
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
  .requiredOption("--space-id <uuid>", "Authorized space UUID")
  .requiredOption("--vault-id <uuid>", "Target vault UUID")
  .action(
    async (options: {
      version: string;
      require?: string[];
      allowType?: string[];
      spaceId: string;
      vaultId: string;
    }) => {
      printJson(
        await api("/v1/schema/dry-run", {
          method: "POST",
          body: JSON.stringify({
            candidateVersion: options.version,
            requiredFrontmatterFields: options.require ?? [],
            allowedTypes: options.allowType ?? [],
            spaceId: options.spaceId,
            vaultId: options.vaultId,
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
