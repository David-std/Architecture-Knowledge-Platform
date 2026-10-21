/**
 * Offline migration/validation for independently supplied review JSON.
 * Original uploads are never mutated; all outputs are private and exclusive-create.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { adaptWriterReviewSubmission } from "../packages/evaluation/src/s2-writer-review-compat.js";
import { auditWriterSemanticReviewPackets } from "../packages/evaluation/src/s2-writer-semantic-audit.js";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const args = process.argv.slice(2);
const val = (key: string) => {
  const i = args.indexOf(key);
  if (
    i < 0 ||
    !args[i + 1] ||
    args[i + 1]!.startsWith("--") ||
    args.filter((x) => x === key).length !== 1
  )
    throw Error("INVALID_ARGUMENT_" + key);
  return path.resolve(args[i + 1]!);
};
if (args.length !== 8) throw Error("USE_PRIVATE_DIR_X_Y_OUTPUT_PREFIX");
const dir = val("--private-dir"),
  inputX = val("--submission-x"),
  inputY = val("--submission-y"),
  prefix = val("--output-prefix");
if (path.dirname(prefix) !== dir)
  throw Error("S2_REVIEW_OUTPUT_MUST_BE_IN_PRIVATE_DIR");
const receiptBytes = await readFile(
  path.join(dir, "writer-semantic-review-receipt-v2.json"),
);
const receipt = JSON.parse(receiptBytes.toString("utf8")) as {
  packets: { assignment: string; sha256: string }[];
  sourceManifestPin: string;
  questionPacketPin: string;
};
if (
  !Array.isArray(receipt.packets) ||
  receipt.packets.length !== 2 ||
  receipt.packets[0]?.assignment !== "X" ||
  receipt.packets[1]?.assignment !== "Y"
)
  throw Error("FROZEN_RECEIPT_INVALID");
const [packetXBytes, packetYBytes, rawX, rawY] = await Promise.all([
  readFile(path.join(dir, "writer-semantic-reviewer-x-v2.json")),
  readFile(path.join(dir, "writer-semantic-reviewer-y-v2.json")),
  readFile(inputX),
  readFile(inputY),
]);
const X = adaptWriterReviewSubmission({
  rawSubmissionBytes: rawX,
  frozenPacketBytes: packetXBytes,
  expectedPacketSha256: receipt.packets[0]!.sha256,
  expectedReviewer: "X",
});
const Y = adaptWriterReviewSubmission({
  rawSubmissionBytes: rawY,
  frozenPacketBytes: packetYBytes,
  expectedPacketSha256: receipt.packets[1]!.sha256,
  expectedReviewer: "Y",
});
const audit = auditWriterSemanticReviewPackets({
  receiptBytes,
  packetXBytes,
  packetYBytes,
  sourceManifestSha256: receipt.sourceManifestPin,
  caseManifestSha256: receipt.questionPacketPin,
  submissionX: X.normalized,
  submissionY: Y.normalized,
});
if (
  audit.status !== "TWO_SEMANTIC_SUBMISSIONS_STRUCTURALLY_VERIFIED" ||
  audit.submissionsReceived !== 2 ||
  audit.reviewerLabelAgreement !== audit.caseCount
)
  throw Error("CANONICAL_AUDIT_NOT_FULLY_VERIFIED");
const b = (v: unknown) => Buffer.from(JSON.stringify(v, null, 2) + "\n");
const out: [string, Uint8Array][] = [
  [prefix + "-normalized-x.json", b(X.normalized)],
  [prefix + "-normalized-y.json", b(Y.normalized)],
  [
    prefix + "-compat-audit.json",
    b({
      schemaVersion: "akp.s2.writer-compat-paired-audit.v1",
      inputRawHashes: { X: sha(rawX), Y: sha(rawY) },
      normalizedHashes: { X: sha(b(X.normalized)), Y: sha(b(Y.normalized)) },
      adapters: [X.audit, Y.audit],
      canonicalAudit: audit,
      reviewerIndependentProcedureAuthenticated: false,
      modelCitationEvidenceBindingEstablished: false,
      gateAccepted: false,
    }),
  ],
];
for (const [file, content] of out) {
  await writeFile(file, content, { flag: "wx" });
}
process.stdout.write(
  JSON.stringify({
    status: audit.status,
    cases: audit.caseCount,
    agreement: audit.reviewerLabelAgreement,
    literalSourceQuoteSpans: audit.exactSourceQuoteSpansMatched,
    X: X.audit,
    Y: Y.audit,
    independentGateAccepted: false,
  }) + "\n",
);
