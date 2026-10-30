/**
 * Local-only exporter. Input is produced by an explicitly injected,
 * trusted S2 private shadow sink; it contains actual private SOURCE/Writer
 * prose. Never store inputs, packets or the private Writer map in Git.
 *
 * pnpm exec tsx scripts/s2-export-private-unseen-review.ts
 *   --samples C:/private/samples.json
 *   --pin-file C:/private/samples.sha256
 *   --output-dir C:/private/new-review-dir
 */
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { buildS2PrivateUnseenReviewKit } from "../packages/evaluation/src/s2-private-unseen-review.js";
const argv = process.argv.slice(2);
if (
  argv.length !== 6 ||
  argv[0] !== "--samples" ||
  argv[2] !== "--pin-file" ||
  argv[4] !== "--output-dir" ||
  argv.some((x, i) => i % 2 === 1 && (!x || x.startsWith("--")))
)
  throw Error("S2_PRIVATE_UNSEEN_EXPORT_ARGS_INVALID");
const root = path.resolve(import.meta.dirname, "..");
const inputs = [argv[1]!, argv[3]!, argv[5]!].map((x) => path.resolve(x));
if (
  inputs.some((p) => p === root || p.startsWith(root + path.sep)) ||
  inputs[0] === inputs[1] ||
  inputs[0] === inputs[2] ||
  inputs[1] === inputs[2]
)
  throw Error("S2_PRIVATE_UNSEEN_EXPORT_EXTERNAL_PATH_REQUIRED");
const [samplesFile, pinFile, outputDir] = inputs;
const [bytes, pin] = await Promise.all([
  readFile(samplesFile),
  readFile(pinFile, "utf8"),
]);
const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
if (
  bytes.length < 2 ||
  bytes.length > 16_000_000 ||
  !/^[a-f0-9]{64}\r?\n?$/u.test(pin) ||
  sha(bytes) !== pin.trim()
)
  throw Error("S2_PRIVATE_UNSEEN_EXPORT_INPUT_NOT_PINNED");
const input = JSON.parse(
  new TextDecoder("utf-8", { fatal: true }).decode(bytes),
) as unknown;
if (!Array.isArray(input)) throw Error("S2_PRIVATE_UNSEEN_EXPORT_NOT_AN_ARRAY");
const seed = randomBytes(32).toString("hex");
const kit = buildS2PrivateUnseenReviewKit({
  samples: input,
  shuffleSalt: seed,
});
const serialize = (x: unknown) =>
  Buffer.from(JSON.stringify(x, null, 2) + "\n", "utf8");
const a = serialize(kit.packets[0]),
  b = serialize(kit.packets[1]);
const privateWriter = serialize({
  schemaVersion: "akp.s2.private-writer-custody.v1",
  writerOutputs: kit.privateWriterAnswers,
  noIndependentSemanticGold: true,
  releaseGateAccepted: false,
});
const receipt = serialize({
  ...kit.receipt,
  sampleFileSha256: sha(bytes),
  packetXSha256: sha(a),
  packetYSha256: sha(b),
  privateWriterSha256: sha(privateWriter),
  privateShuffleSalt: seed,
  sourceOnlyReviewMustPrecedeWriterDisclosure: true,
  independentReviewReceived: false,
  releaseGateAccepted: false,
});
await mkdir(outputDir, { recursive: false, mode: 0o700 });
const write = async (name: string, content: Uint8Array) => {
  await writeFile(path.join(outputDir, name), content, {
    flag: "wx",
    mode: 0o600,
  });
};
await write("source-review-X.json", a);
await write("source-review-Y.json", b);
await write(
  "private-writer-answers-NOT-FOR-SOURCE-REVIEWERS.json",
  privateWriter,
);
await write("private-custodian-receipt.json", receipt);
process.stdout.write(
  JSON.stringify({
    status: "PRIVATE_DEVELOPMENT_REVIEW_PACKETS_PREPARED_NOT_ADJUDICATED",
    caseCount: kit.receipt.questionCount,
    sourceCount: kit.receipt.sourceCount,
    custodianReceiptSha256: sha(receipt),
    reviewerGoldReceived: false,
    independentReviewerIdentityVerified: false,
    releaseGateAccepted: false,
  }) + "\n",
);
