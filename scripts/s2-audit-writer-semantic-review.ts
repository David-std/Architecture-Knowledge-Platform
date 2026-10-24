/**
 * Offline audit of blinded writer-review packets/submissions.
 * Private source files/answers must NOT be uploaded to GitHub.
 *
 * pnpm exec tsx scripts/s2-audit-writer-semantic-review.ts
 *   --private-dir C:/.../section-new-family-20261021
 *   --output C:/.../review-preflight.json
 *   [--submission-x ... --submission-y ...]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { auditWriterSemanticReviewPackets } from "../packages/evaluation/src/s2-writer-semantic-audit.js";
const args = process.argv.slice(2);
function arg(name: string, optional = false): string | undefined {
  const i = args.indexOf(name);
  if (optional && i === -1) return undefined;
  if (
    i === -1 ||
    !args[i + 1] ||
    args[i + 1]!.startsWith("--") ||
    args.filter((a) => a === name).length !== 1
  )
    throw Error("S2_WRITER_SEMANTIC_ARG_INVALID_" + name);
  return path.resolve(args[i + 1]!);
}
const dir = arg("--private-dir")!;
const output = arg("--output")!;
const submissionX = arg("--submission-x", true);
const submissionY = arg("--submission-y", true);
if (Boolean(submissionX) !== Boolean(submissionY))
  throw Error("S2_WRITER_SEMANTIC_BOTH_REVIEWERS_REQUIRED");
const files = [
  "writer-semantic-review-receipt-v2.json",
  "writer-semantic-reviewer-x-v2.json",
  "writer-semantic-reviewer-y-v2.json",
  "source-manifest.sha256",
  "case-manifest.sha256",
].map((n) => path.join(dir, n));
if ([...files, submissionX, submissionY].filter(Boolean).includes(output))
  throw Error("S2_WRITER_SEMANTIC_OUTPUT_OVERLAPS_INPUT");
const [receiptBytes, packetXBytes, packetYBytes, sourcePin, casePin] =
  await Promise.all([
    readFile(files[0]!),
    readFile(files[1]!),
    readFile(files[2]!),
    readFile(files[3]!, "utf8"),
    readFile(files[4]!, "utf8"),
  ]);
if (
  !/^[a-f0-9]{64}\r?\n?$/u.test(sourcePin) ||
  !/^[a-f0-9]{64}\r?\n?$/u.test(casePin)
)
  throw Error("S2_WRITER_SEMANTIC_INVALID_SOURCE_PINS");
const report = auditWriterSemanticReviewPackets({
  receiptBytes,
  packetXBytes,
  packetYBytes,
  sourceManifestSha256: sourcePin.trim(),
  caseManifestSha256: casePin.trim(),
  submissionX: submissionX
    ? (JSON.parse(await readFile(submissionX, "utf8")) as unknown)
    : undefined,
  submissionY: submissionY
    ? (JSON.parse(await readFile(submissionY, "utf8")) as unknown)
    : undefined,
});
await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
process.stdout.write(
  JSON.stringify({
    status: report.status,
    responses: report.caseCount,
    originals: report.sourceCount,
    reviewersReceived: report.submissionsReceived,
    independentSemanticSupport: false,
    gateAccepted: false,
  }) + "\n",
);
