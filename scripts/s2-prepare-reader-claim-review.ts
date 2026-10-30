/**
 * Offline dual-review preparation of historical source-admitted reader claims.
 * Never writes developer gold, model judgments or source contents into Git.
 *
 * pnpm exec tsx scripts/s2-prepare-reader-claim-review.ts
 *   --capture .work/s2-261-qwen25-v5-20261026/RAW_UNSCORED.json
 *   --private-out .work/s2-reader-claim-review-20261026
 */
import { randomBytes, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadEvidenceAdmissionPack } from "./evidence-admission-pack.js";
import {
  prepareS2ReaderClaimReview,
  inspectS2ReaderReviewPacketPair,
  type S2ReaderAdmittedReviewInput,
} from "../packages/evaluation/src/s2-reader-claim-review.js";

const args = process.argv.slice(2);
if (
  args.length !== 4 ||
  args[0] !== "--capture" ||
  args[2] !== "--private-out" ||
  !args[1] ||
  !args[3] ||
  args[1].startsWith("--") ||
  args[3].startsWith("--")
)
  throw Error("S2_READER_REVIEW_ARGS_INVALID");
const capture = path.resolve(args[1]!),
  out = path.resolve(args[3]!);
if (
  capture === out ||
  out === path.resolve(".") ||
  !out.includes(path.sep + ".work" + path.sep)
)
  throw Error("S2_READER_REVIEW_PRIVATE_OUTPUT_ONLY");
const captureRaw = await readFile(capture);
const raw = JSON.parse(captureRaw.toString("utf8")) as {
  completed: number;
  total: number;
  rows: any[];
};
if (raw.completed !== 261 || raw.total !== 261 || raw.rows.length !== 261)
  throw Error("S2_READER_REVIEW_BASELINE_NOT_COMPLETE");
const pack = await loadEvidenceAdmissionPack(["development", "heldout"]);
const byId = new Map(pack.cases.map((x) => [x.question.id, x]));
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const items: S2ReaderAdmittedReviewInput[] = [];
for (const r of raw.rows) {
  if (r.guardDecision !== "ANSWERS") continue;
  const c = byId.get(r.caseId);
  if (!c || sha(c.question.query) !== r.questionSha256)
    throw Error("S2_READER_REVIEW_QUESTION_CHANGED");
  const hit = c.hits.find((h) => h.document.externalId === r.sourceId);
  if (!hit || sha(hit.excerpt) !== r.sourceSha256)
    throw Error("S2_READER_REVIEW_SOURCE_CHANGED");
  const span = r.sourceSpan;
  if (
    !span ||
    !Number.isSafeInteger(span.startOffset) ||
    !Number.isSafeInteger(span.endOffset) ||
    span.startOffset < 0 ||
    span.endOffset <= span.startOffset ||
    span.endOffset > hit.excerpt.length
  )
    throw Error("S2_READER_REVIEW_QUOTE_MISSING");
  const quote = hit.excerpt.slice(span.startOffset, span.endOffset);
  if (
    !r.answerEvidence ||
    typeof r.answerEvidence.answerText !== "string" ||
    !r.answerEvidence.answerText.trim()
  )
    throw Error("S2_READER_REVIEW_ANSWER_MISSING");
  if (c.question.language !== "en" && c.question.language !== "es")
    throw Error("S2_READER_REVIEW_LANGUAGE_INVALID");
  items.push({
    caseId: r.caseId,
    language: c.question.language,
    originalQuestion: c.question.query,
    proposedAnswer: r.answerEvidence.answerText,
    sourcePassage: hit.excerpt,
    sourcePassageSha256: r.sourceSha256,
    evidenceQuote: quote,
    quoteStartUtf16: span.startOffset,
    quoteEndUtf16: span.endOffset,
  });
}
if (items.length !== 127)
  throw Error("S2_READER_REVIEW_EXPECTED_127_ADMISSIONS");
const prepared = prepareS2ReaderClaimReview(items, randomBytes(32));
const audited = inspectS2ReaderReviewPacketPair(
  prepared.packetXBytes,
  prepared.packetYBytes,
  prepared.receiptBytes,
);
if (audited.caseCount !== 127 || audited.releaseGateAccepted !== false)
  throw Error("S2_READER_REVIEW_PREPARATION_NOT_SAFE");
await mkdir(out, { recursive: true });
const named = new Map<string, Uint8Array>([
  ["reader-reviewer-x.json", prepared.packetXBytes],
  ["reader-reviewer-y.json", prepared.packetYBytes],
  ["reader-review-receipt.json", prepared.receiptBytes],
  ["reviewer-x-empty-submission.json", prepared.submissionXBytes],
  ["reviewer-y-empty-submission.json", prepared.submissionYBytes],
  [
    "private-case-map.json",
    Buffer.from(
      JSON.stringify(
        {
          schemaVersion: "akp.s2.reader-claim-review-private-map.v1",
          captureSha256: createHash("sha256").update(captureRaw).digest("hex"),
          caseCount: items.length,
          notForReviewers: true,
          mapping: prepared.privateMap,
        },
        null,
        2,
      ) + "\n",
    ),
  ],
]);
for (const [name, bytes] of named)
  await writeFile(path.join(out, name), bytes, { flag: "wx" });
console.log(
  JSON.stringify({
    status: audited.status,
    caseCount: audited.caseCount,
    reviewersPrepared: 2,
    submissionsComplete: 0,
    independentReviewVerified: false,
    releaseGateAccepted: false,
    privateOutput: out,
    captureSha256: createHash("sha256").update(captureRaw).digest("hex"),
  }),
);
