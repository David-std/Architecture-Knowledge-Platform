import "dotenv/config";
import { Postgres } from "../packages/postgres/src/index.js";
import { backfillHistoricalSourceProjection } from "../apps/worker/src/source-projection-backfill.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;

function argumentsOf(argv: string[]): Record<string, string | boolean> {
  const accepted = new Set([
    "--space-id",
    "--vault-id",
    "--source-id",
    "--artifact-id",
    "--source-sha256",
  ]);
  const options: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (flag === "--apply") {
      if (options[flag]) throw new Error("BACKFILL_DUPLICATE_OPTION");
      options[flag] = true;
      continue;
    }
    if (!accepted.has(flag) || options[flag]) {
      throw new Error("BACKFILL_ARGUMENT_INVALID");
    }
    const value = argv[++i];
    if (!value || value.startsWith("--")) {
      throw new Error("BACKFILL_ARGUMENT_VALUE_REQUIRED");
    }
    options[flag] = value;
  }
  for (const flag of accepted) {
    const value = options[flag];
    if (
      typeof value !== "string" ||
      !(flag === "--source-sha256" ? SHA256 : UUID).test(value)
    ) {
      throw new Error("BACKFILL_EXACT_TARGET_REQUIRED");
    }
  }
  return options;
}

const args = argumentsOf(process.argv.slice(2));
const url = process.env.DATABASE_URL;
if (!url) throw new Error("BACKFILL_DATABASE_URL_REQUIRED");

const db = new Postgres(url);
try {
  const outcome = await backfillHistoricalSourceProjection(
    db,
    {
      spaceId: String(args["--space-id"]),
      vaultId: String(args["--vault-id"]),
      sourceId: String(args["--source-id"]),
      sourceArtifactId: String(args["--artifact-id"]),
      sourceSha256: String(args["--source-sha256"]),
    },
    args["--apply"] === true,
  );
  // No source text, local path, original URI, object key or credentials.
  console.log(JSON.stringify(outcome));
} finally {
  await db.close();
}
