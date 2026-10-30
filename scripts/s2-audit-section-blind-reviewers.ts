/**
 * Offline S2 SECTION reviewer packet audit. Private originals, packets,
 * task maps and submissions must stay off the public GitHub repository.
 *
 * Example: pnpm exec tsx scripts/s2-audit-section-blind-reviewers.ts
 *   --private-dir C:/secure/s2-section
 *   --output C:/secure/s2-section/reviewer-audit.json
 *   [--submission-a C:/secure/a-submission.json
 *    --submission-b C:/secure/b-submission.json]
 */
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { auditSectionBlindReviews } from "../packages/evaluation/src/s2-section-blind-review.js";
function param(name: string, optional = false): string | undefined {
  const count = process.argv.filter((arg) => arg === name).length;
  if (count === 0 && optional) return undefined;
  const i = process.argv.indexOf(name);
  if (
    count !== 1 ||
    i < 0 ||
    !process.argv[i + 1] ||
    process.argv[i + 1]!.startsWith("--")
  )
    throw new Error("S2_SECTION_REVIEW_ARGUMENT_INVALID_" + name);
  return path.resolve(process.argv[i + 1]!);
}
const dir = param("--private-dir")!;
const output = param("--output")!;
const responseA = param("--submission-a", true);
const responseB = param("--submission-b", true);
if (Boolean(responseA) !== Boolean(responseB))
  throw new Error("S2_SECTION_REVIEW_BOTH_RESPONSES_REQUIRED");
const sources = JSON.parse(
  await readFile(path.join(dir, "private-map.json"), "utf8"),
) as {
  sourceSpecs: { documentId: string; localFile: string }[];
};
if (!Array.isArray(sources.sourceSpecs) || sources.sourceSpecs.length > 200)
  throw new Error("S2_SECTION_REVIEW_SOURCES_INVALID");
const localFiles = sources.sourceSpecs.map((v) => path.resolve(v.localFile));
const inputNames = [
  "blind-reviewer-packet-receipt.json",
  "blind-reviewer-a.json",
  "blind-reviewer-b.json",
  "source-manifest.json",
  "case-manifest.json",
  "source-manifest.sha256",
  "case-manifest.sha256",
  "private-map.json",
].map((name) => path.join(dir, name));
if (
  [...inputNames, ...localFiles, responseA, responseB]
    .filter(Boolean)
    .some((item) => item === output)
)
  throw new Error("S2_SECTION_REVIEW_OUTPUT_OVERLAPS_INPUT");
const [
  receiptBytes,
  packetABytes,
  packetBBytes,
  sourceManifestBytes,
  caseManifestBytes,
  sourcePin,
  casePin,
] = await Promise.all([
  readFile(inputNames[0]!),
  readFile(inputNames[1]!),
  readFile(inputNames[2]!),
  readFile(inputNames[3]!),
  readFile(inputNames[4]!),
  readFile(inputNames[5]!, "utf8"),
  readFile(inputNames[6]!, "utf8"),
]);
if (
  !/^[a-f0-9]{64}\r?\n?$/u.test(sourcePin) ||
  !/^[a-f0-9]{64}\r?\n?$/u.test(casePin)
)
  throw new Error("S2_SECTION_REVIEW_PIN_FILE_INVALID");
const sourceFiles = await Promise.all(
  sources.sourceSpecs.map(async (file) => ({
    documentId: file.documentId,
    bytes: await readFile(file.localFile),
  })),
);
const report = auditSectionBlindReviews({
  receiptBytes,
  packetABytes,
  packetBBytes,
  sourceManifestBytes,
  sourceManifestSha256: sourcePin.trim(),
  caseManifestBytes,
  caseManifestSha256: casePin.trim(),
  sourceFiles,
  submissionA: responseA
    ? (JSON.parse(await readFile(responseA, "utf8")) as unknown)
    : undefined,
  submissionB: responseB
    ? (JSON.parse(await readFile(responseB, "utf8")) as unknown)
    : undefined,
});
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
process.stdout.write(
  JSON.stringify({
    status: report.status,
    sourceCount: report.sourceCount,
    caseCount: report.caseCount,
    reviewerSubmissionsReceived: report.reviewerSubmissionsReceived,
    gateAccepted: false,
  }) + "\n",
);
