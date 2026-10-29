/**
 * Validates externally completed 240-seat intake BEFORE model execution.
 * Does not sign/attest independent selection or produce Writer/custodian gold.
 * pnpm exec tsx scripts/s2-preflight-external-intake.ts
 * --template C:/private/blank.csv --template-pin C:/private/blank.sha256
 * --filled C:/private/filled.csv --filled-pin C:/private/filled.sha256
 * --source-root C:/private/authorized-originals
 * --denylist C:/private/excluded-dev-publishers.json
 * --denylist-pin C:/private/excluded-dev-publishers.sha256
 * --output C:/private/NEW-unreviewed-preflight.json
 */
import { createHash } from "node:crypto";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  parseS2ExternalIntakeCsv,
  preflightS2IndependentIntake,
} from "../packages/evaluation/src/s2-independent-intake.js";
const root = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const flags = [
  "--template",
  "--template-pin",
  "--filled",
  "--filled-pin",
  "--source-root",
  "--denylist",
  "--denylist-pin",
  "--output",
] as const;
if (
  args.length !== flags.length * 2 ||
  flags.some(
    (f, i) =>
      args[2 * i] !== f ||
      !args[2 * i + 1] ||
      args[2 * i + 1]!.startsWith("--"),
  )
)
  throw Error("S2_EXTERNAL_PREFLIGHT_EIGHT_PATH_FLAGS_REQUIRED");
const entries = flags.map((_, i) => path.resolve(args[2 * i + 1]!));
if (
  new Set(entries.map((s) => s.toLowerCase())).size !== entries.length ||
  entries.some(
    (p) =>
      p.toLowerCase() === root.toLowerCase() ||
      p.toLowerCase().startsWith(root.toLowerCase() + path.sep),
  )
)
  throw Error("S2_EXTERNAL_PREFLIGHT_PRIVATE_EXTERNAL_PATH_REQUIRED");
const [
  templatePath,
  templatePinPath,
  filledPath,
  filledPinPath,
  sourceRoot,
  denyPath,
  denyPinPath,
  outPath,
] = entries as [string, string, string, string, string, string, string, string];
const pinPattern = /^[a-f0-9]{64}\r?\n?$/u;
const [template, templatePin, filled, filledPin, deny, denyPin] =
  await Promise.all([
    readFile(templatePath),
    readFile(templatePinPath, "utf8"),
    readFile(filledPath),
    readFile(filledPinPath, "utf8"),
    readFile(denyPath),
    readFile(denyPinPath, "utf8"),
  ]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
if (
  !pinPattern.test(templatePin) ||
  !pinPattern.test(filledPin) ||
  !pinPattern.test(denyPin) ||
  sha(deny) !== denyPin.trim() ||
  sha(template) !== templatePin.trim() ||
  sha(filled) !== filledPin.trim()
)
  throw Error("S2_EXTERNAL_PREFLIGHT_PINS_NOT_PRECOMMITTED");
const excluded = JSON.parse(
  new TextDecoder("utf8", { fatal: true }).decode(deny),
) as unknown;
if (
  !excluded ||
  typeof excluded !== "object" ||
  Array.isArray(excluded) ||
  !("schemaVersion" in excluded) ||
  excluded.schemaVersion !== "akp.s2.preexcluded-development-families.v1" ||
  !("publisherFamilies" in excluded) ||
  !Array.isArray(excluded.publisherFamilies) ||
  excluded.publisherFamilies.some((x: unknown) => typeof x !== "string")
)
  throw Error("S2_EXTERNAL_PREFLIGHT_DENYLIST_INVALID");
const rows = parseS2ExternalIntakeCsv(filled);
if (
  rows.length !== 240 ||
  rows.some(
    (x) =>
      !x.question.trim() ||
      !x.sourceRelativePath ||
      !x.originalSha256 ||
      !x.externalCustodianCaseAuthor ||
      !x.authorizedVaultScope,
  )
)
  throw Error("S2_EXTERNAL_PREFLIGHT_INTAKE_INCOMPLETE_BEFORE_SOURCE_LOAD");
const sourceCanonical = await realpath(sourceRoot);
const keys = new Set(
  rows.map((x) => x.publisherFamilySeat + "/" + x.sourceRelativePath),
);
const sourceFiles = [];
for (const k of keys) {
  const slash = k.indexOf("/");
  const familySeat = k.slice(0, slash),
    relativePath = k.slice(slash + 1);
  if (
    !/^F(0[1-9]|1[0-2])$/u.test(familySeat) ||
    !relativePath ||
    relativePath.includes("\\") ||
    relativePath.split("/").some((x) => !x || x === "." || x === "..")
  )
    throw Error("S2_EXTERNAL_PREFLIGHT_UNSAFE_SOURCE_PATH");
  const f = path.resolve(
    sourceCanonical,
    familySeat,
    ...relativePath.split("/"),
  );
  const canonical = await realpath(f);
  if (
    !canonical
      .toLowerCase()
      .startsWith(sourceCanonical.toLowerCase() + path.sep)
  )
    throw Error("S2_EXTERNAL_PREFLIGHT_SOURCE_ESCAPES_ROOT");
  const meta = await stat(canonical);
  if (!meta.isFile() || meta.size < 10 || meta.size > 2_000_000)
    throw Error("S2_EXTERNAL_PREFLIGHT_SOURCE_TYPE_OR_SIZE_INVALID");
  sourceFiles.push({
    familySeat,
    relativePath,
    rawBytes: await readFile(canonical),
  });
}
const report = preflightS2IndependentIntake({
  templateBytes: template,
  templateSha256: templatePin.trim(),
  filledBytes: filled,
  filledSha256: filledPin.trim(),
  sourceFiles,
  excludedDevelopmentPublisherFamilies: excluded.publisherFamilies as string[],
});
await writeFile(outPath, JSON.stringify(report, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(
  JSON.stringify({
    status: report.status,
    seats: report.seatCount,
    families: report.familyCount,
    sources: report.sourceCount,
    sourcePermissionVerifiedExternally: false,
    independentGoldReceived: false,
    gateAccepted: false,
  }) + "\n",
);
