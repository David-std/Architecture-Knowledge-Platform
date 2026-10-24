/**
 * Privacy-constrained, offline SECTION shadow paired aggregate.
 * The source manifest, private task/capture records and pin file stay local.
 * Output contains aggregates only and cannot certify independent custody.
 *
 * pnpm exec tsx scripts/s2-score-section-paired.ts
 *   --manifest C:/secure/section-cases.json
 *   --pin-file C:/separate-custodian/manifest.sha256
 *   --captures C:/secure/section-captures.json
 *   --output C:/secure/section-aggregate.json
 */
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  scoreSectionPairedShadow,
  type SectionPairRun,
} from "../packages/evaluation/src/s2-section-paired.js";

function flag(name: string): string {
  const index = process.argv.indexOf(name);
  if (
    index < 0 ||
    !process.argv[index + 1] ||
    process.argv[index + 1]!.startsWith("--")
  )
    throw new Error("S2_SECTION_PAIR_MISSING_" + name.slice(2).toUpperCase());
  return path.resolve(process.argv[index + 1]!);
}
const manifestFile = flag("--manifest");
const pinFile = flag("--pin-file");
const capturesFile = flag("--captures");
const outputFile = flag("--output");
if (new Set([manifestFile, pinFile, capturesFile, outputFile]).size !== 4)
  throw new Error("S2_SECTION_PAIR_INPUT_OUTPUT_PATH_ALIAS");

const manifestBytes = await readFile(manifestFile);
const pinContent = await readFile(pinFile, "utf8");
if (!/^[a-f0-9]{64}\r?\n?$/u.test(pinContent))
  throw new Error("S2_SECTION_PAIR_INVALID_EXTERNAL_PIN");
const run = JSON.parse(await readFile(capturesFile, "utf8")) as SectionPairRun;
const report = scoreSectionPairedShadow({
  manifestBytes,
  externallyPinnedManifestSha256: pinContent.trim(),
  run,
});
await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n", {
  encoding: "utf8",
  flag: "wx",
});
process.stdout.write(
  JSON.stringify({
    status: report.status,
    cases: report.caseCount,
    parentCandidates: report.parentCandidateCount,
    verifiedParentCandidates: report.verifiedParentCount,
    gateAccepted: false,
  }) + "\n",
);
