/**
 * Source-redacted descriptive analysis of reviewer-confirmed writer declarations.
 * This is a development diagnostic, NOT independent acceptance or FAR evidence.
 */
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { auditWriterSemanticReviewPackets } from "../packages/evaluation/src/s2-writer-semantic-audit.js";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--private-dir" || args[2] !== "--output")
  throw Error("S2_WRITER_REVIEW_SUMMARY_ARGUMENTS");
const dir = path.resolve(args[1]!),
  out = path.resolve(args[3]!);
if (path.dirname(out) !== dir)
  throw Error("S2_REVIEW_OUTPUT_MUST_BE_IN_PRIVATE_DIR");
const read = (name: string) => readFile(path.join(dir, name));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const [
  receiptBytes,
  packetXBytes,
  packetYBytes,
  subXBytes,
  subYBytes,
  mapBytes,
  writerBytes,
  seedBytes,
] = await Promise.all([
  read("writer-semantic-review-receipt-v2.json"),
  read("writer-semantic-reviewer-x-v2.json"),
  read("writer-semantic-reviewer-y-v2.json"),
  read("writer-semantic-20261021-verified-normalized-x.json"),
  read("writer-semantic-20261021-verified-normalized-y.json"),
  read("writer-semantic-private-arm-map-v2.json"),
  read("section-reader-dev-observations.json"),
  read("writer-semantic-private-seed-v2.hex"),
]);
const from = (raw: Uint8Array) =>
  JSON.parse(raw.toString("utf8")) as Record<string, any>;
const seed = seedBytes.toString("utf8").trim();
if (!/^[a-f0-9]{64}$/u.test(seed)) throw Error("S2_PRIVATE_SEED_INVALID");
const receipt = from(receiptBytes),
  X = from(subXBytes),
  Y = from(subYBytes),
  map = from(mapBytes),
  capture = from(writerBytes);
if (
  map.writerRunSha256 !== sha(writerBytes) ||
  map.mapping?.length !== 13 ||
  capture.readerRows?.length !== 8
)
  throw Error("S2_PRIVATE_ARM_MAPPING_TAMPER_OR_SCOPE");
const audit = auditWriterSemanticReviewPackets({
  receiptBytes,
  packetXBytes,
  packetYBytes,
  sourceManifestSha256: receipt.sourceManifestPin,
  caseManifestSha256: receipt.questionPacketPin,
  submissionX: X,
  submissionY: Y,
});
if (
  audit.status !== "TWO_SEMANTIC_SUBMISSIONS_STRUCTURALLY_VERIFIED" ||
  audit.reviewerLabelAgreement !== 13 ||
  audit.caseCount !== 13
)
  throw Error("S2_SEMANTIC_SUBMISSIONS_NOT_AUDITED");
const byId = new Map<string, any>();
for (const item of X.cases) {
  if (byId.has(item.responseKeySha256)) throw Error("DUPLICATE_SEMANTIC_ID");
  byId.set(item.responseKeySha256, item);
}
const norm = (
  r: any,
): "FULLY_SUPPORTED" | "UNNECESSARY" | "JUSTIFIED" | "OTHER" =>
  r.answerFaithfulness === "FULLY_SUPPORTED"
    ? "FULLY_SUPPORTED"
    : r.abstention === "UNNECESSARY"
      ? "UNNECESSARY"
      : r.abstention === "JUSTIFIED"
        ? "JUSTIFIED"
        : "OTHER";
const mapByCase = new Map<
  string,
  { CHILD_ONLY?: string; VERIFIED_SECTION_ENRICHED?: string }
>();
const armCount: { [k: string]: Record<string, number> } = {
  CHILD_ONLY: {},
  VERIFIED_SECTION_ENRICHED: {},
};
const seen = new Set<string>();
for (const m of map.mapping) {
  if (
    !byId.has(m.responseKeySha256) ||
    seen.has(m.responseKeySha256) ||
    !["CHILD_ONLY", "VERIFIED_SECTION_ENRICHED"].includes(m.arm)
  )
    throw Error("INVALID_REVIEW_TO_ARM_JOIN");
  const expectedKey = sha(
    Buffer.from(seed + "|" + m.caseKeySha256 + "|" + m.arm, "utf8"),
  );
  const actualRow = capture.readerRows.find(
    (r: any) => r.caseKeySha256 === m.caseKeySha256,
  );
  const actualArm = actualRow?.outputs?.find((o: any) => o.arm === m.arm);
  if (
    m.responseKeySha256 !== expectedKey ||
    !actualArm ||
    JSON.stringify(m.originalCitationIds) !==
      JSON.stringify(actualArm.citations) ||
    (actualArm.status === "ANSWER") !==
      (norm(byId.get(m.responseKeySha256)) === "FULLY_SUPPORTED")
  )
    throw Error("S2_ARM_ID_NOT_CRYPTOGRAPHICALLY_BOUND_TO_CAPTURE");
  seen.add(m.responseKeySha256);
  const pair = mapByCase.get(m.caseKeySha256) ?? {};
  if (Object.hasOwn(pair, m.arm)) throw Error("DUPLICATED_ARM_IN_CASE");
  Object.assign(pair, { [m.arm]: m.responseKeySha256 });
  mapByCase.set(m.caseKeySha256, pair);
  const value = norm(byId.get(m.responseKeySha256));
  armCount[m.arm]![value] = (armCount[m.arm]![value] ?? 0) + 1;
}
if (seen.size !== 13 || mapByCase.size !== 8) throw Error("JOIN_MISSING_CASES");
let changedToAnswer = 0,
  unchangedAbstain = 0,
  negativeUnchanged = 0;
const effective: Record<string, number> = {};
for (const [caseKey, arms] of mapByCase) {
  if (!arms.CHILD_ONLY) throw Error("MISSING_CHILD_ARM");
  const child = byId.get(arms.CHILD_ONLY);
  if (arms.VERIFIED_SECTION_ENRICHED) {
    const parent = byId.get(arms.VERIFIED_SECTION_ENRICHED);
    if (
      child.abstention === "UNNECESSARY" &&
      parent.answerFaithfulness === "FULLY_SUPPORTED"
    )
      changedToAnswer++;
    if (child.abstention !== null && parent.abstention !== null) {
      unchangedAbstain++;
      if (child.abstention === "JUSTIFIED" && parent.abstention === "JUSTIFIED")
        negativeUnchanged++;
    }
  }
  const latest = byId.get(arms.VERIFIED_SECTION_ENRICHED ?? arms.CHILD_ONLY);
  const v = norm(latest);
  effective[v] = (effective[v] ?? 0) + 1;
  if (!capture.readerRows.find((r: any) => r.caseKeySha256 === caseKey))
    throw Error("CAPTURE_CASE_UNKNOWN");
}
const report = {
  schemaVersion: "akp.s2.writer-review-dev-descriptive-aggregate.v1",
  status: "DESCRIPTIVE_ONLY_NOT_GATEABLE",
  originalSourceQuestionCount: 8,
  writerResponseCount: 13,
  reviewedPositiveOutputs: 4,
  reviewedAbstainOutputs: 9,
  reviewerStrictLabelAgreement: 13,
  reviewerStructuralLiteralQuotes: audit.exactSourceQuoteSpansMatched,
  reviewerClaimsIndependentProcedureAttested: false,
  childOnly: armCount.CHILD_ONLY,
  sectionEnriched: armCount.VERIFIED_SECTION_ENRICHED,
  childPlusSectionWhereAvailable: effective,
  pairedCases: 5,
  unnecessaryAbstentionToFullySupportedAnswer: changedToAnswer,
  pairedAbstentionsUnchanged: unchangedAbstain,
  pairedJustifiedAbstentionsUnchanged: negativeUnchanged,
  anonymousArmIdentityRecomputedFromOwnerPrivateSeed: true,
  generatedModelInputPassageMapAvailable: false,
  independentAnswerEntailmentAdjudicated: false,
  publisherFamilyIndependentHoldout: false,
  productionFalseAdmissionRate: null,
  productionSemanticPrecision: null,
  fullEndToEndP95Ms: null,
  unitCostMeasured: false,
  modelOutputModified: false,
  admissionOrThresholdChanged: false,
  gateAccepted: false,
};
if (
  report.unnecessaryAbstentionToFullySupportedAnswer !== 1 ||
  report.pairedAbstentionsUnchanged !== 4 ||
  Object.values(effective).reduce((a, b) => a + b, 0) !== 8
)
  throw Error("PAIR_RECONCILIATION_CONFLICT");
await writeFile(out, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify(report));
