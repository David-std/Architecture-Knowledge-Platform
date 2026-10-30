/**
 * Falsifies the source-unit-as-claim precision inference using only original
 * question form and the already pinned 127 admitted proposed answers.
 * Never declares unflagged answers true; never changes developer labels.
 *
 * pnpm exec tsx scripts/s2-audit-reader-answer-forms.ts
 *   --private-dir .work/s2-reader-claim-review-20261026
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  inspectS2ReaderReviewPacketPair,
  type S2ReaderReviewPacket,
} from "../packages/evaluation/src/s2-reader-claim-review.js";
import { explicitlyRequestsNonBooleanAnswer } from "../packages/retrieval/src/question-answer-form.js";
const args = process.argv.slice(2);
if (
  args.length !== 2 ||
  args[0] !== "--private-dir" ||
  !args[1] ||
  args[1].startsWith("--")
)
  throw Error("S2_READER_FORM_AUDIT_ARGS_INVALID");
const dir = path.resolve(args[1]!);
const [x, y, receipt] = await Promise.all(
  [
    "reader-reviewer-x.json",
    "reader-reviewer-y.json",
    "reader-review-receipt.json",
  ].map((f) => readFile(path.join(dir, f))),
);
const checked = inspectS2ReaderReviewPacketPair(x, y, receipt);
const packet = JSON.parse(x.toString("utf8")) as S2ReaderReviewPacket;
const yesNo = /^(?:yes|no|si|sí|true|false)$/iu;
const wrong = packet.cases.filter(
  (c) =>
    yesNo.test(c.proposedAnswer.trim()) &&
    explicitlyRequestsNonBooleanAnswer(c.originalQuestion),
);
const byLanguage = Object.fromEntries(
  (["en", "es"] as const).map((lang) => [
    lang,
    {
      admitted: packet.cases.filter((c) => c.language === lang).length,
      explicitFormMismatches: wrong.filter((c) => c.language === lang).length,
    },
  ]),
);
if (checked.caseCount !== packet.cases.length)
  throw Error("S2_READER_FORM_AUDIT_MISMATCH");
const report = {
  schemaVersion: "akp.s2.answer-form-definite-counterexamples.v1",
  source: "original pinned 127 source-admitted reader replies",
  sourcePacketSha256: createHash("sha256").update(x).digest("hex"),
  originalAdmitted: packet.cases.length,
  definiteAnswerFormErrors: wrong.length,
  upperBoundAnswerCorrect: packet.cases.length - wrong.length,
  upperBoundAnswerCorrectPrecision:
    (packet.cases.length - wrong.length) / packet.cases.length,
  detectedErrorCaseKeySha256: wrong.map((c) => c.responseKeySha256).sort(),
  byLanguage,
  caveats: [
    "Bound is from a deterministic high-certainty response-type counterexample, NOT full answer-claim adjudication",
    "One known subject-direction inverse outside these form errors must be counted separately only after independent source verification",
    "Historical source candidates intentionally supplied answer-bearing units; not retrieval or Writer full-run evidence",
    "Source passage excerpt is SearchHit, not authenticated original immutable raw SOURCE or external human reviewer custody",
    "False rejects can exist outside the narrowly recognized interrogative forms; unflagged are NOT presumed correct",
  ],
  independentHumanAdjudication: false,
  releaseGateAccepted: false,
};
console.log(JSON.stringify(report, null, 2));
