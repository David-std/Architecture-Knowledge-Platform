/**
 * Offline-only builder. NEVER commit outputs: these contain private questions,
 * complete original file content and the local model's full answer strings.
 *
 * pnpm exec tsx scripts/s2-prepare-writer-semantic-review.ts
 *   --private-dir C:/.../section-new-family-20261021
 */
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import {
  auditSectionBlindReviews,
  buildBlindedWriterReviewPackets,
  summarizeDualAxisReviews,
} from "../packages/evaluation/src/index.js";

const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== "--private-dir" ||
  !args[1] ||
  args[1].startsWith("--")
)
  throw Error("S2_WRITER_REVIEW_PRIVATE_DIR_REQUIRED");
const dir = path.resolve(args[1]);
const read = (name: string) => readFile(path.join(dir, name));
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const meta = JSON.parse(
  await readFile(path.join(dir, "private-map.json"), "utf8"),
) as {
  sourceSpecs: { documentId: string; localFile: string }[];
  tasks: {
    caseKeySha256: string;
    documentId: string;
    lang: "en" | "es";
    question: string;
  }[];
};
if (
  !Array.isArray(meta.sourceSpecs) ||
  meta.sourceSpecs.length > 200 ||
  !Array.isArray(meta.tasks) ||
  meta.tasks.length > 10000
)
  throw Error("S2_WRITER_REVIEW_PRIVATE_META_INVALID");
const files = await Promise.all(
  meta.sourceSpecs.map(async (x) => ({
    documentId: x.documentId,
    bytes: await readFile(path.resolve(x.localFile)),
  })),
);
const [
  sourceManifestBytes,
  caseManifestBytes,
  sourcePinRaw,
  casePinRaw,
  receiptBytes,
  packetABytes,
  packetBBytes,
  submissionABytes,
  submissionBBytes,
  writerRunBytes,
] = await Promise.all([
  read("source-manifest.json"),
  read("case-manifest.json"),
  readFile(path.join(dir, "source-manifest.sha256"), "utf8"),
  readFile(path.join(dir, "case-manifest.sha256"), "utf8"),
  read("blind-reviewer-packet-receipt.json"),
  read("blind-reviewer-a.json"),
  read("blind-reviewer-b.json"),
  read("reviewer-a-submitted-20261021.json"),
  read("reviewer-b-submitted-20261021.json"),
  read("section-reader-dev-observations.json"),
]);
if (
  !/^[a-f0-9]{64}\r?\n?$/u.test(sourcePinRaw) ||
  !/^[a-f0-9]{64}\r?\n?$/u.test(casePinRaw)
)
  throw Error("S2_WRITER_REVIEW_BAD_PIN");
const sourcePin = sourcePinRaw.trim(),
  casePin = casePinRaw.trim();
const reviewerAudit = auditSectionBlindReviews({
  receiptBytes,
  packetABytes,
  packetBBytes,
  sourceManifestBytes,
  sourceManifestSha256: sourcePin,
  caseManifestBytes,
  caseManifestSha256: casePin,
  sourceFiles: files,
  submissionA: JSON.parse(
    new TextDecoder().decode(submissionABytes),
  ) as unknown,
  submissionB: JSON.parse(
    new TextDecoder().decode(submissionBBytes),
  ) as unknown,
});
if (
  reviewerAudit.status !== "TWO_SUBMISSIONS_STRUCTURALLY_VERIFIED" ||
  reviewerAudit.reviewerSubmissionsReceived !== 2
)
  throw Error("S2_WRITER_REVIEW_FROZEN_REVIEWERS_NOT_AUDITED");
const manifest = JSON.parse(new TextDecoder().decode(caseManifestBytes)) as {
  cases: { caseKeySha256: string }[];
};
const axes = summarizeDualAxisReviews({
  submissionABytes,
  submissionBBytes,
  auditedQuestionKeys: manifest.cases.map((c) => c.caseKeySha256),
  structuralAuditStatus: reviewerAudit.status,
});
const privateOwnerSeed = randomBytes(32);
const prepared = buildBlindedWriterReviewPackets({
  sourceManifestBytes,
  pinnedSourceManifestSha256: sourcePin,
  caseManifestBytes,
  pinnedCaseManifestSha256: casePin,
  sourceFiles: files,
  questions: meta.tasks.map((q) => ({
    questionKeySha256: q.caseKeySha256,
    documentId: q.documentId,
    language: q.lang,
    question: q.question,
  })),
  writerRunBytes,
  privateOwnerSeed,
});
const out = new Map<string, Uint8Array>();
const encode = (x: unknown) => Buffer.from(JSON.stringify(x, null, 2) + "\n");
out.set("reviewer-dual-axis-private-dev-v2.json", encode(axes));
out.set(
  "writer-semantic-private-seed-v2.hex",
  Buffer.from(privateOwnerSeed.toString("hex") + "\n"),
);
const receipt: {
  schemaVersion: string;
  packets: {
    assignment: string;
    file: string;
    sha256: string;
    responseCount: number;
  }[];
  questionPacketPin: string;
  sourceManifestPin: string;
  writerRunSha256: string;
  modelCitationSourceMappingAvailable: false;
  independentReviewCompleted: false;
  gateAccepted: false;
} = {
  schemaVersion: "akp.s2.writer-semantic-review-packet-receipt.v1",
  packets: [],
  questionPacketPin: casePin,
  sourceManifestPin: sourcePin,
  writerRunSha256: sha(writerRunBytes),
  modelCitationSourceMappingAvailable: false,
  independentReviewCompleted: false,
  gateAccepted: false,
};
for (const [i, label] of ["X", "Y"].entries()) {
  const packet = prepared.packets[i]!;
  const filename =
    "writer-semantic-reviewer-" + label.toLowerCase() + "-v2.json";
  const buf = encode(packet);
  out.set(filename, buf);
  receipt.packets.push({
    assignment: label,
    file: filename,
    sha256: sha(buf),
    responseCount: packet.cases.length,
  });
  const skeleton = {
    schemaVersion: "akp.s2.writer-semantic-review-submission.v1",
    reviewerAssignment: label,
    packetSha256: sha(buf),
    cases: packet.cases.map((q) => ({
      responseKeySha256: q.responseKeySha256,
      sourceAnswerability: null,
      answerFaithfulness: null,
      abstention: null,
      exactOriginalQuoteSpans: [],
      note: null,
    })),
    answersFilled: false,
    independentReviewAttested: false,
  };
  out.set(
    "writer-semantic-submission-" + label.toLowerCase() + "-empty-v2.json",
    encode(skeleton),
  );
}
out.set("writer-semantic-review-receipt-v2.json", encode(receipt));
out.set(
  "writer-semantic-private-arm-map-v2.json",
  encode({
    schemaVersion: "akp.s2.writer-semantic-private-arm-map.v1",
    writerRunSha256: sha(writerRunBytes),
    mapping: prepared.privateArmMap,
    keepPrivate: true,
  }),
);
for (const name of out.keys()) {
  try {
    await access(path.join(dir, name));
    throw Error("S2_WRITER_REVIEW_OUTPUT_ALREADY_EXISTS_" + name);
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("S2_WRITER_REVIEW_"))
      throw e;
  }
}
for (const [name, content] of out) {
  await writeFile(path.join(dir, name), content, { flag: "wx" });
}
process.stdout.write(
  JSON.stringify({
    status: "ANONYMOUS_UNREVIEWED_WRITER_PACKETS_FROZEN",
    sourceFiles: prepared.sourceCount,
    modelResponses: prepared.expectedResponseCount,
    reviewerPackets: prepared.packets.length,
    strictFourWayAgreement: axes.exactFourWayAgreement,
    evidenceDispositionAgreement: axes.evidenceDispositionAgreement,
    polarityNeedsIndependentReview: axes.claimPolarityNeedsReview,
    rawModelPassageCitationMappingAvailable: false,
    submissionsReceived: 0,
    independentReviewCompleted: false,
    gateAccepted: false,
  }) + "\n",
);
