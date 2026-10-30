/**
 * Private review-custody audit for already-collected independent SOURCE-only
 * X/Y submissions. The external operator, not this tool, authenticates people,
 * checks source rights and confirms complete-vault negative evidence.
 * No model, no production flags, no release gate.
 *
 * pnpm exec tsx scripts/s2-audit-prospective-source-review.ts
 * --packet-x PRIVATE/source-review-X.json
 * --packet-x-pin PRIVATE/source-review-X.sha256
 * --packet-y PRIVATE/source-review-Y.json
 * --packet-y-pin PRIVATE/source-review-Y.sha256
 * --submission-x PRIVATE/submission-X.json
 * --submission-x-pin PRIVATE/submission-X.sha256
 * --submission-y PRIVATE/submission-Y.json
 * --submission-y-pin PRIVATE/submission-Y.sha256
 * --out-dir PRIVATE/NEW-adjudication-receipt
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { auditS2ProspectiveSourceReview } from "../packages/evaluation/src/s2-prospective-source-review-audit.js";
const flags = [
  "--packet-x",
  "--packet-x-pin",
  "--packet-y",
  "--packet-y-pin",
  "--submission-x",
  "--submission-x-pin",
  "--submission-y",
  "--submission-y-pin",
  "--out-dir",
] as const;
const args = process.argv.slice(2);
if (
  args.length !== flags.length * 2 ||
  flags.some(
    (v, i) =>
      args[i * 2] !== v ||
      !args[i * 2 + 1] ||
      args[i * 2 + 1]!.startsWith("--"),
  )
)
  throw Error("S2_PROSPECTIVE_SUBMISSIONS_ALL_PRIVATE_PATHS_REQUIRED");
const files = flags.map((_, i) => path.resolve(args[i * 2 + 1]!));
const repo = await realpath(path.resolve(import.meta.dirname, ".."));
const parent = await realpath(path.dirname(files[8]!));
const privateDir = files[8]!;
if (
  new Set(files.map((x) => x.toLowerCase())).size !== files.length ||
  files.some(
    (x) =>
      x.toLowerCase() === repo.toLowerCase() ||
      x.toLowerCase().startsWith(repo.toLowerCase() + path.sep),
  ) ||
  parent.toLowerCase() === repo.toLowerCase() ||
  parent.toLowerCase().startsWith(repo.toLowerCase() + path.sep) ||
  privateDir === path.parse(privateDir).root
)
  throw Error("S2_PROSPECTIVE_SUBMISSIONS_MUST_REMAIN_OUTSIDE_GIT");
const pin = /^[a-f0-9]{64}\r?\n?$/u;
const hash = (x: Uint8Array) => createHash("sha256").update(x).digest("hex");
const payloads = await Promise.all(
  files.slice(0, 8).map((f, i) =>
    readFile(f).then((v) => {
      if (v.length < 1 || v.length > 12_000_000)
        throw Error("S2_PROSPECTIVE_SUBMISSIONS_INPUT_LIMIT_" + i);
      return v;
    }),
  ),
);
const pins = await Promise.all(
  [1, 3, 5, 7].map((i) =>
    (async () => {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        payloads[i]!,
      );
      if (!pin.test(text)) throw Error("S2_PROSPECTIVE_SUBMISSIONS_PIN_SYNTAX");
      return text.trim();
    })(),
  ),
);
const content = [payloads[0]!, payloads[2]!, payloads[4]!, payloads[6]!];
for (let i = 0; i < 4; i++) {
  if (hash(content[i]!) !== pins[i])
    throw Error("S2_PROSPECTIVE_SUBMISSIONS_PIN_MISMATCH");
}
const audit = auditS2ProspectiveSourceReview({
  packetXBytes: content[0]!,
  packetXSha256: pins[0]!,
  packetYBytes: content[1]!,
  packetYSha256: pins[1]!,
  submissionXBytes: content[2]!,
  submissionXSha256: pins[2]!,
  submissionYBytes: content[3]!,
  submissionYSha256: pins[3]!,
});
const z = Buffer.from(JSON.stringify(audit.zPacket, null, 2) + "\n", "utf8");
const evidence = {
  schemaVersion: "akp.s2.prospective-source-review-custody-receipt.v1",
  status: audit.status,
  caseCount: audit.caseCount,
  originalSourceCount: audit.sourceCount,
  frozenPacketHashes: audit.packetHashes,
  submittedHumanLabelFileHashes: audit.submissionHashes,
  reviewerAgreement: audit.agreement,
  zPacketSha256: hash(z),
  zCases: audit.agreement.disagreements,
  externalReviewerIdentityVerified: false,
  originalSourceUseRightsIndependentlyVerified: false,
  wholeAuthorizedCorpusNegativeProven: false,
  separateZAdjudicationCompleted: false,
  sourceGoldCertified: false,
  releaseGateAccepted: false,
};
const report = Buffer.from(JSON.stringify(evidence, null, 2) + "\n", "utf8");
await mkdir(privateDir, { recursive: false, mode: 0o700 });
await writeFile(path.join(privateDir, "SOURCE-ONLY-Z-disagreements.json"), z, {
  flag: "wx",
  mode: 0o600,
});
await writeFile(
  path.join(privateDir, "PRIVATE-source-review-receipt.json"),
  report,
  { flag: "wx", mode: 0o600 },
);
process.stdout.write(
  JSON.stringify({
    status: evidence.status,
    cases: evidence.caseCount,
    agreements: evidence.reviewerAgreement.fullyAgreed,
    disagreements: evidence.reviewerAgreement.disagreements,
    sourceGoldCertified: false,
    releaseGateAccepted: false,
  }) + "\n",
);
