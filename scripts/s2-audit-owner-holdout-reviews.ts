/**
 * Offline owner-custodial X/Y reviewer audit. The result never grants S2.
 * pnpm exec tsx scripts/s2-audit-owner-holdout-reviews.ts
 *  --review-dir /private/reviews --output /private/reviews/report.json
 *  [--submission-x /private/x.json --submission-y /private/y.json]
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { auditOwnerReviewPackets } from "../packages/evaluation/src/s2-owner-review-audit.js";
const args = process.argv.slice(2);
const flag = (name: string, optional = false) => {
  const i = args.indexOf(name);
  if (optional && i < 0) return undefined;
  if (
    i < 0 ||
    !args[i + 1] ||
    args[i + 1]!.startsWith("--") ||
    args.filter((x) => x === name).length !== 1
  )
    throw Error("S2_OWNER_AUDIT_CLI_MISSING_" + name);
  return path.resolve(args[i + 1]!);
};
if (args.length !== 4 && args.length !== 8)
  throw Error("S2_OWNER_AUDIT_CLI_BAD_ARGUMENTS");
const dir = flag("--review-dir")!,
  out = flag("--output")!;
const x = flag("--submission-x", true),
  y = flag("--submission-y", true);
if (Boolean(x) !== Boolean(y)) throw Error("S2_OWNER_AUDIT_CLI_BOTH_REQUIRED");
const root = path.resolve(import.meta.dirname, "..");
if (
  [dir, out, x, y]
    .filter((t): t is string => !!t)
    .some((t) => t === root || t.startsWith(root + path.sep)) ||
  path.dirname(out) !== dir
)
  throw Error("S2_OWNER_AUDIT_CLI_PRIVATE_OUTPUT_REQUIRED");
const [receiptBytes, packetXBytes, packetYBytes] = await Promise.all([
  readFile(path.join(dir, "s2-owner-review-packet-receipt.json")),
  readFile(path.join(dir, "s2-owner-reviewer-x-packet.json")),
  readFile(path.join(dir, "s2-owner-reviewer-y-packet.json")),
]);
const report = auditOwnerReviewPackets({
  receiptBytes,
  packetXBytes,
  packetYBytes,
  reviewerX: x ? (JSON.parse(await readFile(x, "utf8")) as unknown) : undefined,
  reviewerY: y ? (JSON.parse(await readFile(y, "utf8")) as unknown) : undefined,
});
await writeFile(out, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
process.stdout.write(
  JSON.stringify({
    status: report.status,
    cases: report.totalQuestions,
    sourceFiles: report.totalOriginalDocuments,
    submissions: report.submittedReviewers,
    labelAgreement: report.exactLabelAgreement,
    literalQuotes: report.literalOriginalQuoteSpans,
    independentCustodian: false,
    gateAccepted: false,
  }) + "\n",
);
