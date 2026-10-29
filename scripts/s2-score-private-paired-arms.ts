/**
 * Offline scorer for *already recorded and externally adjudicated* paired
 * deterministic/candidate runs, or clearly flagged synthetic DEV controls.
 * No inference, no labels created, no policy promotion. Score stays private.
 *
 * pnpm exec tsx scripts/s2-score-private-paired-arms.ts
 *  --cases /private/paired-adjudicated.json
 *  --pin-file /private/paired-adjudicated.sha256
 *  --output /private/NEW-paired-diagnostic.json
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { scoreS2PairedSemanticArms } from "../packages/evaluation/src/s2-prospective-paired-score.js";
const args = process.argv.slice(2),
  flags = ["--cases", "--pin-file", "--output"];
if (
  args.length !== 6 ||
  flags.some(
    (x, i) =>
      args[i * 2] !== x ||
      !args[i * 2 + 1] ||
      args[i * 2 + 1]!.startsWith("--"),
  )
)
  throw Error("S2_PAIRED_PRIVATE_SCORE_THREE_FLAGS_REQUIRED");
const files = flags.map((_, i) => path.resolve(args[2 * i + 1]!));
const repo = path.resolve(import.meta.dirname, "..").toLowerCase();
if (
  new Set(files.map((f) => f.toLowerCase())).size !== 3 ||
  files.some(
    (p) =>
      p.toLowerCase() === repo || p.toLowerCase().startsWith(repo + path.sep),
  )
)
  throw Error("S2_PAIRED_PRIVATE_SCORE_OUTSIDE_GIT_REQUIRED");
const [bytes, pin] = await Promise.all([
  readFile(files[0]!),
  readFile(files[1]!, "utf8"),
]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
if (
  bytes.length < 2 ||
  bytes.length > 8_000_000 ||
  !/^[a-f0-9]{64}\r?\n?$/u.test(pin) ||
  sha(bytes) !== pin.trim()
)
  throw Error("S2_PAIRED_PRIVATE_SCORE_FROZEN_BYTES_MISMATCH");
const parsed = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(bytes),
) as unknown;
if (!Array.isArray(parsed))
  throw Error("S2_PAIRED_PRIVATE_SCORE_CASES_NOT_ARRAY");
const results = scoreS2PairedSemanticArms(parsed);
const report = {
  ...results,
  caseManifestSha256: sha(bytes),
  independentReviewerIdentityExternallyVerified: false,
  releaseGateAccepted: false,
};
await writeFile(files[2]!, JSON.stringify(report, null, 2) + "\n", {
  flag: "wx",
  mode: 0o600,
});
process.stdout.write(
  JSON.stringify({
    status: report.status,
    cases: report.caseCount,
    families: report.familyCount,
    independentlyAdjudicated: false,
    releaseGateAccepted: false,
  }) + "\n",
);
