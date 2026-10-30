/**
 * Offline preflight and paired-annotation inspection for historic Qwen reader.
 * Source content and reviewer identities remain private under .work.
 * This DOES NOT certify reviewer independence or grant production admission.
 *
 * pnpm exec tsx scripts/s2-audit-reader-claim-review.ts
 *   --private-dir .work/s2-reader-claim-review-20261026
 *   [--submission-x ... --submission-y ...]
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  inspectS2ReaderClaimReviewSubmissions,
  inspectS2ReaderReviewPacketPair,
} from "../packages/evaluation/src/s2-reader-claim-review.js";
const args = process.argv.slice(2);
const opt = (s: string) => {
  const i = args.indexOf(s);
  if (i < 0) return null;
  if (
    args.filter((x) => x === s).length !== 1 ||
    !args[i + 1] ||
    args[i + 1]!.startsWith("--")
  )
    throw Error("S2_READER_REVIEW_ARG_INVALID_" + s);
  return path.resolve(args[i + 1]!);
};
const dir = opt("--private-dir"),
  x = opt("--submission-x"),
  y = opt("--submission-y");
if (!dir || Boolean(x) !== Boolean(y) || args.length !== 2 + (x ? 4 : 0))
  throw Error("S2_READER_REVIEW_ARGS_INVALID");
const [packetXBytes, packetYBytes, receiptBytes] = await Promise.all(
  [
    "reader-reviewer-x.json",
    "reader-reviewer-y.json",
    "reader-review-receipt.json",
  ].map((name) => readFile(path.join(dir, name))),
);
const result =
  x && y
    ? inspectS2ReaderClaimReviewSubmissions({
        packetXBytes,
        packetYBytes,
        receiptBytes,
        submissionXBytes: await readFile(x),
        submissionYBytes: await readFile(y),
      })
    : inspectS2ReaderReviewPacketPair(packetXBytes, packetYBytes, receiptBytes);
console.log(JSON.stringify(result, null, 2));
