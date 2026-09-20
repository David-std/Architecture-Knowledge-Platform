import "dotenv/config";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import pg from "pg";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const baselinePath = path.join(
  root,
  "evals",
  "registered",
  "v0.3-capability-maturity-baseline.json",
);
const targetUrl = process.env.AKP_UPGRADE_DATABASE_URL?.trim();
if (!targetUrl) {
  throw new Error("AKP_UPGRADE_DATABASE_URL is required.");
}
const outputPath = path.resolve(
  root,
  process.env.AKP_UPGRADE_MIGRATION_REPORT ??
    "reports/ci/upgrade-migrations.json",
);

type Baseline = {
  schemaVersion: number;
  baselineVersion: string;
  baseCommit: string;
};

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout;
}

function canonicalChecksum(sql: string): string {
  return createHash("sha256")
    .update(sql.replaceAll("\r\n", "\n"))
    .digest("hex");
}

const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as Baseline;
if (
  baseline.schemaVersion !== 1 ||
  baseline.baselineVersion !== "v0.3.0" ||
  !/^[a-f0-9]{40}$/i.test(baseline.baseCommit)
) {
  throw new Error("Frozen v0.3 baseline metadata is invalid.");
}

await git(["cat-file", "-e", `${baseline.baseCommit}^{commit}`]);
const baseMigrationPaths = (
  await git([
    "ls-tree",
    "-r",
    "--name-only",
    baseline.baseCommit,
    "--",
    "db/migrations",
  ])
)
  .split(/\r?\n/u)
  .map((value) => value.trim())
  .filter((value) => /^db\/migrations\/\d+_.+\.sql$/u.test(value))
  .sort();

if (baseMigrationPaths.length === 0) {
  throw new Error("Frozen v0.3 baseline has no migrations.");
}

const seedClient = new pg.Client({ connectionString: targetUrl });
await seedClient.connect();
try {
  await seedClient.query(`
    create table if not exists schema_migrations (
      name text primary key,
      checksum text,
      applied_at timestamptz not null default now()
    )
  `);
  for (const migrationPath of baseMigrationPaths) {
    const name = path.posix.basename(migrationPath);
    const sql = await git(["show", `${baseline.baseCommit}:${migrationPath}`]);
    const checksum = canonicalChecksum(sql);
    await seedClient.query("begin");
    try {
      await seedClient.query(sql);
      await seedClient.query(
        "insert into schema_migrations(name,checksum) values ($1,$2)",
        [name, checksum],
      );
      await seedClient.query("commit");
    } catch (error) {
      await seedClient.query("rollback");
      throw error;
    }
  }
} finally {
  await seedClient.end();
}

process.env.DATABASE_URL = targetUrl;
await import("./migrate.ts");

const currentMigrationNames = (await readdir(path.join(root, "db/migrations")))
  .filter((name) => /^\d+_.+\.sql$/u.test(name))
  .sort();
const verifyClient = new pg.Client({ connectionString: targetUrl });
await verifyClient.connect();
try {
  const applied = await verifyClient.query<{
    name: string;
    checksum: string | null;
  }>("select name,checksum from schema_migrations order by name");
  if (applied.rows.length !== currentMigrationNames.length) {
    throw new Error(
      `Expected ${currentMigrationNames.length} applied migrations after upgrade, found ${applied.rows.length}.`,
    );
  }
  const appliedByName = new Map(
    applied.rows.map((row) => [row.name, row.checksum]),
  );
  for (const name of currentMigrationNames) {
    const sql = await readFile(path.join(root, "db/migrations", name), "utf8");
    const checksum = canonicalChecksum(sql);
    if (appliedByName.get(name) !== checksum) {
      throw new Error(`Upgrade checksum mismatch for ${name}.`);
    }
  }

  const report = {
    schemaVersion: 1,
    evidenceLevel: "FROZEN_V0_3_TO_CURRENT_SCHEMA_UPGRADE",
    status: "PASSED",
    baselineVersion: baseline.baselineVersion,
    baseCommit: baseline.baseCommit,
    baselineMigrationCount: baseMigrationPaths.length,
    baselineLastMigration: path.posix.basename(
      baseMigrationPaths[baseMigrationPaths.length - 1]!,
    ),
    currentMigrationCount: currentMigrationNames.length,
    currentLastMigration:
      currentMigrationNames[currentMigrationNames.length - 1] ?? null,
    appliedMigrationCount: applied.rows.length,
    targetDatabase: new URL(targetUrl).pathname.replace(/^\//u, ""),
    generatedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await verifyClient.end();
}
