import "dotenv/config";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  Postgres,
  grantVaultMembership,
  listVaults,
  reconcileEventQuarantine,
  reconcileFailedIngest,
  registerVault,
} from "@akp/postgres";
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
import { renderDoctorReport, runDoctor } from "./doctor.js";
import {
  AUDIT_EXPORT_CONFIRMATION,
  AuditExportClientError,
  RAW_EVIDENCE_EXPORT_CONFIRMATION,
  requestRawEvidenceExport,
  requestAuditExport,
} from "./audit-export.js";
import { positiveInteger, requestAkpApi } from "./api-client.js";
import { resolveCliVaultSelection } from "./vault-selection.js";

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

async function api<T = unknown>(
  route: string,
  init?: RequestInit,
  options: { idempotencyKey?: string | undefined } = {},
): Promise<T> {
  return requestAkpApi<T>({
    baseUrl: process.env.AKP_API_URL ?? "http://127.0.0.1:8080",
    token: process.env.AKP_API_TOKEN,
    route,
    init,
    ...(options.idempotencyKey
      ? { idempotencyKey: options.idempotencyKey }
      : {}),
  });
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function runEvaluationTarget(options: {
  spaceId: string;
  vaultId: string;
  evalPack: string;
  idempotencyKey?: string;
}): Promise<void> {
  const { idempotencyKey, ...payload } = options;
  printJson(
    await api(
      "/v1/evals/run",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
      { idempotencyKey },
    ),
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
  .version("0.1.0")
  .addHelpText(
    "after",
    [
      "",
      "Client commands use AKP_API_URL + AKP_API_TOKEN and enforce the same authorization as Web/MCP.",
      "Operator-local vault/doctor commands use DATABASE_URL and act on the node directly.",
      "Use 'akp vaults' to discover vault names/keys visible to the current API credential.",
    ].join("\n"),
  );

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

const profile = program
  .command("profile")
  .description("Versioned KnowledgeProfile governance");

profile
  .command("list")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .action(async (options: { spaceId: string; vaultId: string }) => {
    const params = new URLSearchParams({
      spaceId: options.spaceId,
      vaultId: options.vaultId,
    });
    printJson(await api(`/v1/schema/profiles?${params.toString()}`));
  });

profile
  .command("get")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .requiredOption("--revision-id <uuid>", "KnowledgeProfile revision UUID")
  .action(
    async (options: {
      spaceId: string;
      vaultId: string;
      revisionId: string;
    }) => {
      const params = new URLSearchParams({
        spaceId: options.spaceId,
        vaultId: options.vaultId,
      });
      printJson(
        await api(
          `/v1/schema/profiles/${options.revisionId}?${params.toString()}`,
        ),
      );
    },
  );

profile
  .command("validate")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .requiredOption("--file <path>", "KnowledgeProfile JSON file")
  .action(
    async (options: { spaceId: string; vaultId: string; file: string }) => {
      const profileValue = JSON.parse(
        readFileSync(path.resolve(options.file), "utf8"),
      ) as unknown;
      printJson(
        await api("/v1/schema/profiles/validate", {
          method: "POST",
          body: JSON.stringify({
            spaceId: options.spaceId,
            vaultId: options.vaultId,
            profile: profileValue,
          }),
        }),
      );
    },
  );

profile
  .command("diff")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .requiredOption("--file <path>", "Candidate KnowledgeProfile JSON file")
  .option("--base-revision-id <uuid>", "Optional durable base revision")
  .action(
    async (options: {
      spaceId: string;
      vaultId: string;
      file: string;
      baseRevisionId?: string;
    }) => {
      const candidateProfile = JSON.parse(
        readFileSync(path.resolve(options.file), "utf8"),
      ) as unknown;
      printJson(
        await api("/v1/schema/profiles/diff", {
          method: "POST",
          body: JSON.stringify({
            spaceId: options.spaceId,
            vaultId: options.vaultId,
            candidateProfile,
            ...(options.baseRevisionId
              ? { baseRevisionId: options.baseRevisionId }
              : {}),
          }),
        }),
      );
    },
  );

profile
  .command("dry-run")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .requiredOption("--file <path>", "Candidate KnowledgeProfile JSON file")
  .option("--supersedes-revision-id <uuid>", "Revision explicitly superseded")
  .action(
    async (options: {
      spaceId: string;
      vaultId: string;
      file: string;
      supersedesRevisionId?: string;
    }) => {
      const profileValue = JSON.parse(
        readFileSync(path.resolve(options.file), "utf8"),
      ) as unknown;
      printJson(
        await api("/v1/schema/dry-run", {
          method: "POST",
          body: JSON.stringify({
            spaceId: options.spaceId,
            vaultId: options.vaultId,
            profile: profileValue,
            ...(options.supersedesRevisionId
              ? { supersedesRevisionId: options.supersedesRevisionId }
              : {}),
          }),
        }),
      );
    },
  );

profile
  .command("activate")
  .requiredOption("--space-id <uuid>", "Owning space UUID")
  .requiredOption("--vault-id <uuid>", "Bound vault UUID")
  .requiredOption("--revision-id <uuid>", "KnowledgeProfile revision UUID")
  .requiredOption("--dry-run-id <uuid>", "Pinned dry-run UUID")
  .requiredOption(
    "--profile-hash <sha256>",
    "Expected canonical profile SHA-256",
  )
  .requiredOption("--corpus-revision <revision>", "Expected corpus revision")
  .action(
    async (options: {
      spaceId: string;
      vaultId: string;
      revisionId: string;
      dryRunId: string;
      profileHash: string;
      corpusRevision: string;
    }) => {
      printJson(
        await api("/v1/schema/activate", {
          method: "POST",
          body: JSON.stringify({
            spaceId: options.spaceId,
            vaultId: options.vaultId,
            profileRevisionId: options.revisionId,
            dryRunId: options.dryRunId,
            expectedProfileHash: options.profileHash,
            expectedCorpusRevision: options.corpusRevision,
          }),
        }),
      );
    },
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
  .command("grant-access")
  .description("Grant a principal access to a vault on this node")
  .requiredOption("--user-id <uuid>", "Principal receiving access")
  .requiredOption("--vault-id <uuid>", "Vault the principal may reach")
  .option("--role <role>", "Vault role whose permissions are granted", "VIEWER")
  .option(
    "--path-prefix <path>",
    "Restrict access to a subtree; omit for the whole vault",
  )
  .action(
    async (options: {
      userId: string;
      vaultId: string;
      role: string;
      pathPrefix?: string;
    }) => {
      // Importing a vault does not grant anyone access to it: vault membership
      // is deliberately separate from space membership. A node serving a team
      // needs an operator surface for that, or a freshly imported corpus stays
      // unreachable through every authorized surface, including its own web app.
      const membership = await withDatabase((db) =>
        grantVaultMembership(db, {
          userId: options.userId,
          vaultId: options.vaultId,
          role: options.role,
          pathPrefix: options.pathPrefix ?? null,
        }),
      );
      console.log(
        JSON.stringify(
          {
            status: "GRANTED",
            userId: membership.userId,
            vaultId: membership.vaultId,
            role: membership.role,
            pathPrefix: membership.pathPrefix,
            permissions: membership.permissions,
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

const reconcile = program
  .command("reconcile")
  .description("Append audited dispositions for terminal operational residue");

reconcile
  .command("quarantine")
  .requiredOption("--event-id <uuid>", "Quarantined outbox event UUID")
  .requiredOption("--consumer <name>", "Outbox consumer name")
  .requiredOption(
    "--disposition <kind>",
    "RECOVERED_REPLAYED, SUPERSEDED_BY_VERIFIED_PROJECTION, or IRRECOVERABLE_RECONCILED",
  )
  .requiredOption(
    "--actor <identity>",
    "Operator identity recorded in the audit trail",
  )
  .requiredOption(
    "--reason <text>",
    "Why this terminal disposition is justified",
  )
  .option(
    "--evidence <json>",
    "Bounded JSON evidence for the disposition",
    "{}",
  )
  .option("--environment <name>", "Operational environment label", "default")
  .action(
    async (options: {
      eventId: string;
      consumer: string;
      disposition: string;
      actor: string;
      reason: string;
      evidence: string;
      environment: string;
    }) => {
      const allowed = [
        "RECOVERED_REPLAYED",
        "SUPERSEDED_BY_VERIFIED_PROJECTION",
        "IRRECOVERABLE_RECONCILED",
      ] as const;
      if (!(allowed as readonly string[]).includes(options.disposition)) {
        throw new Error("Invalid quarantine disposition.");
      }
      const evidence = JSON.parse(options.evidence) as unknown;
      if (
        !evidence ||
        Array.isArray(evidence) ||
        typeof evidence !== "object"
      ) {
        throw new Error("--evidence must be a JSON object.");
      }
      printJson(
        await withDatabase((db) =>
          reconcileEventQuarantine(db, {
            eventId: options.eventId,
            consumerName: options.consumer,
            environment: options.environment,
            disposition: options.disposition as (typeof allowed)[number],
            actor: options.actor,
            rationale: options.reason,
            evidence: evidence as Record<string, unknown>,
          }),
        ),
      );
    },
  );

reconcile
  .command("ingest")
  .requiredOption("--job-id <uuid>", "Failed ingest job UUID")
  .requiredOption(
    "--disposition <kind>",
    "TERMINAL_FIXTURE_DISPOSITION, SUPERSEDED_BY_VERIFIED_PROJECTION, or IRRECOVERABLE_RECONCILED",
  )
  .requiredOption(
    "--actor <identity>",
    "Operator identity recorded in the audit trail",
  )
  .requiredOption(
    "--reason <text>",
    "Why this terminal disposition is justified",
  )
  .option(
    "--evidence <json>",
    "Bounded JSON evidence for the disposition",
    "{}",
  )
  .option("--environment <name>", "Operational environment label", "default")
  .action(
    async (options: {
      jobId: string;
      disposition: string;
      actor: string;
      reason: string;
      evidence: string;
      environment: string;
    }) => {
      const allowed = [
        "TERMINAL_FIXTURE_DISPOSITION",
        "SUPERSEDED_BY_VERIFIED_PROJECTION",
        "IRRECOVERABLE_RECONCILED",
      ] as const;
      if (!(allowed as readonly string[]).includes(options.disposition)) {
        throw new Error("Invalid ingest disposition.");
      }
      const evidence = JSON.parse(options.evidence) as unknown;
      if (
        !evidence ||
        Array.isArray(evidence) ||
        typeof evidence !== "object"
      ) {
        throw new Error("--evidence must be a JSON object.");
      }
      printJson(
        await withDatabase((db) =>
          reconcileFailedIngest(db, {
            jobId: options.jobId,
            environment: options.environment,
            disposition: options.disposition as (typeof allowed)[number],
            actor: options.actor,
            rationale: options.reason,
            evidence: evidence as Record<string, unknown>,
          }),
        ),
      );
    },
  );

program
  .command("doctor")
  .option("--format <format>", "json or human", "json")
  .option(
    "--vault-id <uuid>",
    "Limit operational residue diagnostics to one vault",
  )
  .option("--environment <name>", "Operational environment label", "default")
  .action(
    async (options: {
      format: string;
      vaultId?: string;
      environment: string;
    }) => {
      const report = await withDatabase((db) =>
        runDoctor(db, process.env, process.cwd(), {
          ...(options.vaultId ? { vaultId: options.vaultId } : {}),
          environment: options.environment,
        }),
      );
      if (options.format === "json") {
        printJson(report);
      } else if (options.format === "human") {
        console.log(renderDoctorReport(report));
      } else {
        throw new Error("doctor --format must be json or human");
      }
      if (report.overall === "FAIL") process.exitCode = 1;
    },
  );

program.command("status").action(async () => {
  console.log(JSON.stringify(await api("/v1/status"), null, 2));
});

program
  .command("vaults")
  .description("List vaults visible to the authenticated API credential")
  .action(async () => {
    printJson(await api("/v1/vaults"));
  });

program
  .command("search")
  .argument("<query>")
  .option("--space-id <uuid>", "Authorized space UUID; optional with --vault")
  .option("--vault-id <uuid...>", "Target vault UUID(s), retained for scripts")
  .option("--vault <name-or-key...>", "Target authorized vault name/key(s)")
  .option("--federated", "Explicitly allow multiple-vault synthesis", false)
  .option("--limit <number>", "Maximum hits", positiveInteger, 10)
  .option("--mode <mode>", "Retrieval mode", "SOURCE_BACKED")
  .action(
    async (
      query: string,
      options: {
        spaceId?: string;
        vaultId?: string[];
        vault?: string[];
        federated: boolean;
        limit: number;
        mode: string;
      },
    ) => {
      const scope = await resolveCliVaultSelection({
        spaceId: options.spaceId,
        vaultIds: options.vaultId,
        vaultSelectors: options.vault,
        listVisibleVaults: async () => {
          const response = await api<{ vaults?: unknown[] }>("/v1/vaults");
          return response.vaults ?? [];
        },
      });
      printJson(
        await api("/v1/search", {
          method: "POST",
          body: JSON.stringify({
            query,
            spaceId: scope.spaceId,
            vaultIds: scope.vaultIds,
            ...(scope.vaultIds.length === 1
              ? { vaultId: scope.vaultIds[0] }
              : {}),
            federated: options.federated,
            limit: options.limit,
            mode: options.mode,
          }),
        }),
      );
    },
  );

program
  .command("context")
  .argument("<query>")
  .option("--space-id <uuid>", "Authorized space UUID; optional with --vault")
  .option("--vault-id <uuid...>", "Target vault UUID(s), retained for scripts")
  .option("--vault <name-or-key...>", "Target authorized vault name/key(s)")
  .option("--federated", "Explicitly allow multiple-vault synthesis", false)
  .option("--intent <intent>", "Retrieval intent", "CONCEPTUAL")
  .option("--max-tokens <number>", "Context budget", positiveInteger, 6000)
  .action(
    async (
      query: string,
      options: {
        spaceId?: string;
        vaultId?: string[];
        vault?: string[];
        federated: boolean;
        intent: string;
        maxTokens: number;
      },
    ) => {
      const scope = await resolveCliVaultSelection({
        spaceId: options.spaceId,
        vaultIds: options.vaultId,
        vaultSelectors: options.vault,
        listVisibleVaults: async () => {
          const response = await api<{ vaults?: unknown[] }>("/v1/vaults");
          return response.vaults ?? [];
        },
      });
      printJson(
        await api("/v1/context", {
          method: "POST",
          body: JSON.stringify({
            query,
            spaceId: scope.spaceId,
            vaultIds: scope.vaultIds,
            ...(scope.vaultIds.length === 1
              ? { vaultId: scope.vaultIds[0] }
              : {}),
            federated: options.federated,
            intent: options.intent,
            maxTokens: options.maxTokens,
          }),
        }),
      );
    },
  );

program
  .command("ingest")
  .argument(
    "<server-path>",
    "Path visible to the AKP API/worker and allowed by AKP_INGEST_ROOTS",
  )
  .requiredOption("--space-id <uuid>", "Authorized space UUID")
  .requiredOption("--vault-id <uuid>", "Target vault UUID")
  .option("--title <title>")
  .option("--media-type <mediaType>")
  .option(
    "--idempotency-key <key>",
    "Stable retry key; reuse it after a lost/uncertain response",
  )
  .action(
    async (
      serverPath: string,
      options: {
        spaceId: string;
        vaultId: string;
        title?: string;
        mediaType?: string;
        idempotencyKey?: string;
      },
    ) => {
      printJson(
        await api(
          "/v1/ingest",
          {
            method: "POST",
            body: JSON.stringify({
              spaceId: options.spaceId,
              vaultId: options.vaultId,
              sourceUri: serverPath,
              policy: "REVIEW_REQUIRED",
              ...(options.title ? { title: options.title } : {}),
              ...(options.mediaType ? { mediaType: options.mediaType } : {}),
            }),
          },
          { idempotencyKey: options.idempotencyKey },
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
  .requiredOption("--reason <reason>", "Human decision rationale")
  .option(
    "--idempotency-key <key>",
    "Stable retry key; reuse it after a lost/uncertain response",
  )
  .action(
    async (
      id: string,
      options: {
        decision: string;
        reason: string;
        idempotencyKey?: string;
      },
    ) => {
      printJson(
        await api(
          `/v1/reviews/${id}/decision`,
          {
            method: "POST",
            body: JSON.stringify({
              decision: options.decision,
              reason: options.reason,
            }),
          },
          { idempotencyKey: options.idempotencyKey },
        ),
      );
    },
  );

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
  .option(
    "--idempotency-key <key>",
    "Stable retry key; reuse it after a lost/uncertain response",
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
  .option("--intent <intent>", "Packet intent", "CONCEPTUAL")
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
  .option(
    "--idempotency-key <key>",
    "Stable retry key; reuse it after a lost/uncertain response",
  )
  .action(async (options: { trigger: string; idempotencyKey?: string }) => {
    printJson(
      await api(
        "/v1/lint/run",
        {
          method: "POST",
          body: JSON.stringify({ trigger: options.trigger.toUpperCase() }),
        },
        { idempotencyKey: options.idempotencyKey },
      ),
    );
  });

program.configureOutput({
  outputError: (message, write) => write(`ERROR: ${message}`),
});

await program.parseAsync(process.argv);
