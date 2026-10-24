import { createHash } from "node:crypto";
import type { BlindedWriterReviewPacket } from "./s2-writer-semantic-packets.js";

const sha = (x: Uint8Array) => createHash("sha256").update(x).digest("hex");
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const equalKeys = (x: Record<string, unknown>, keys: string[]) =>
  Object.keys(x).sort().join(",") === keys.sort().join(",");
const hex = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/u.test(x);
const fail = (s: string): never => {
  throw Error("S2_WRITER_AUDIT_" + s);
};
function parse(buf: Uint8Array): unknown {
  if (!buf.length || buf.byteLength > 8_000_000) fail("INVALID_SIZE");
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buf),
    ) as unknown;
  } catch {
    fail("INVALID_JSON");
  }
}
function boundary(value: string, n: unknown): n is number {
  if (
    typeof n !== "number" ||
    !Number.isSafeInteger(n) ||
    n < 0 ||
    n > value.length
  )
    return false;
  if (n === 0 || n === value.length) return true;
  const a = value.charCodeAt(n - 1),
    b = value.charCodeAt(n);
  return !(a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff);
}
const answerStatus = new Set([
  "EXPLICITLY_DECIDABLE",
  "NOT_SUPPORTED",
  "AMBIGUOUS",
  "UNDECIDABLE",
]);
const answerFaithfulness = new Set([
  "FULLY_SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "UNSUPPORTED_OR_WRONG",
  "UNDECIDABLE",
]);
const abstentionStatus = new Set(["JUSTIFIED", "UNNECESSARY", "UNDECIDABLE"]);
export interface WriterSemanticAuditReport {
  schemaVersion: "akp.s2.writer-semantic-audit.v1";
  status:
    | "PACKETS_VERIFIED_UNREVIEWED"
    | "TWO_SEMANTIC_SUBMISSIONS_STRUCTURALLY_VERIFIED";
  caseCount: number;
  sourceCount: number;
  submissionsReceived: 0 | 2;
  reviewerLabelAgreement: number | null;
  reviewerLabelDisagreement: number | null;
  exactSourceQuoteSpansMatched: number | null;
  sourceManifestSha256: string;
  caseManifestSha256: string;
  rawModelPassageCitationMappingAvailable: false;
  originalCustodyIndependentlyAttested: false;
  reviewerIndependenceAuthenticated: false;
  semanticSupportIndependentlyEstablished: false;
  actualAdmissionFalsePositiveRate: null;
  gateAccepted: false;
}
export function auditWriterSemanticReviewPackets(input: {
  receiptBytes: Uint8Array;
  packetXBytes: Uint8Array;
  packetYBytes: Uint8Array;
  sourceManifestSha256: string;
  caseManifestSha256: string;
  submissionX?: unknown;
  submissionY?: unknown;
}): WriterSemanticAuditReport {
  const receipt = parse(input.receiptBytes);
  if (!object(receipt)) throw Error("S2_WRITER_AUDIT_RECEIPT_INVALID");
  if (
    !object(receipt) ||
    !equalKeys(receipt, [
      "schemaVersion",
      "packets",
      "questionPacketPin",
      "sourceManifestPin",
      "writerRunSha256",
      "modelCitationSourceMappingAvailable",
      "independentReviewCompleted",
      "gateAccepted",
    ]) ||
    receipt.schemaVersion !==
      "akp.s2.writer-semantic-review-packet-receipt.v1" ||
    receipt.sourceManifestPin !== input.sourceManifestSha256 ||
    receipt.questionPacketPin !== input.caseManifestSha256 ||
    !hex(receipt.writerRunSha256) ||
    receipt.modelCitationSourceMappingAvailable !== false ||
    receipt.independentReviewCompleted !== false ||
    receipt.gateAccepted !== false ||
    !Array.isArray(receipt.packets) ||
    receipt.packets.length !== 2
  )
    fail("RECEIPT_INVALID");
  const receiptRows = receipt.packets as Record<string, unknown>[];
  const submissionKeys = [
    "schemaVersion",
    "reviewerAssignment",
    "packetSha256",
    "cases",
    "answersFilled",
    "independentReviewAttested",
  ];
  const packetMap = new Map<
    "X" | "Y",
    { packet: BlindedWriterReviewPacket; sha: string }
  >();
  for (const [i, label, bytes] of [
    [0, "X", input.packetXBytes],
    [1, "Y", input.packetYBytes],
  ] as const) {
    const proof = receiptRows[i];
    if (!proof) throw Error("S2_WRITER_AUDIT_PACKET_RECEIPT_HASH_MISMATCH");
    if (
      !object(proof) ||
      !equalKeys(proof, ["assignment", "file", "sha256", "responseCount"]) ||
      proof.assignment !== label ||
      !hex(proof.sha256) ||
      sha(bytes) !== proof.sha256
    )
      fail("PACKET_RECEIPT_HASH_MISMATCH");
    const parsed = parse(bytes);
    if (
      !object(parsed) ||
      parsed.schemaVersion !== "akp.s2.writer-semantic-blind-packet.v1" ||
      parsed.reviewerAssignment !== label ||
      parsed.caseManifestSha256 !== input.caseManifestSha256 ||
      parsed.sourceManifestSha256 !== input.sourceManifestSha256 ||
      parsed.writerRunSha256 !== receipt.writerRunSha256 ||
      parsed.armAllocationRevealed !== false ||
      parsed.originalReviewerVerdictsIncluded !== false ||
      parsed.fullModelCitationSourceMappingAvailable !== false ||
      parsed.originalSourceSemanticJudgmentsOnly !== true ||
      parsed.gateAccepted !== false ||
      !Array.isArray(parsed.sourceDocuments) ||
      !Array.isArray(parsed.cases) ||
      parsed.cases.length !== proof.responseCount ||
      parsed.cases.length === 0 ||
      parsed.cases.length > 20_000
    )
      fail("PACKET_SCHEMA_OR_SCOPE_INVALID");
    packetMap.set(label, {
      packet: parsed as unknown as BlindedWriterReviewPacket,
      sha: proof.sha256 as string,
    });
  }
  const packetX = packetMap.get("X")!.packet,
    packetY = packetMap.get("Y")!.packet;
  const questionSet = new Map<
    string,
    { status: string; answer: string; refs: string; sourceKey: string }
  >();
  const sources = new Map<string, string>();
  for (const packet of [packetX, packetY]) {
    if (
      packet.sourceDocuments.length < 1 ||
      packet.sourceDocuments.length > 200
    )
      fail("SOURCE_SET_INVALID");
    const encounteredSources = new Set<string>();
    for (const file of packet.sourceDocuments) {
      if (
        !hex(file.documentKeySha256) ||
        typeof file.sourceText !== "string" ||
        !hex(file.sourceSha256) ||
        encounteredSources.has(file.documentKeySha256) ||
        !boundary(file.sourceText, file.bodyStartUtf16) ||
        !boundary(file.sourceText, file.bodyEndUtf16) ||
        file.bodyEndUtf16 <= file.bodyStartUtf16
      )
        fail("SOURCE_FRAME_INVALID");
      encounteredSources.add(file.documentKeySha256);
      const before = sources.get(file.documentKeySha256);
      if (before !== undefined && before !== file.sourceText)
        fail("SOURCE_CHANGED_ACROSS_REVIEWERS");
      sources.set(file.documentKeySha256, file.sourceText);
    }
    const seen = new Set<string>();
    for (const c of packet.cases) {
      if (
        !hex(c.responseKeySha256) ||
        seen.has(c.responseKeySha256) ||
        !hex(c.sourceDocumentKeySha256) ||
        !sources.has(c.sourceDocumentKeySha256) ||
        !(c.writerStatus === "ANSWER" || c.writerStatus === "ABSTAIN") ||
        typeof c.writerAnswer !== "string" ||
        !Array.isArray(c.reportedCitationIds) ||
        c.reportedCitationIds.some((v) => !/^(CIT)[1-9][0-9]*$/u.test(v)) ||
        c.annotation?.answerFaithfulness !== null ||
        c.annotation?.abstention !== null ||
        c.annotation?.sourceAnswerability !== null ||
        c.annotation?.exactOriginalQuoteSpans.length !== 0
      )
        fail("RESPONSE_PACKET_INVALID");
      seen.add(c.responseKeySha256);
      const detail = {
        status: c.writerStatus,
        answer: c.writerAnswer,
        refs: JSON.stringify(c.reportedCitationIds),
        sourceKey: c.sourceDocumentKeySha256,
      };
      const other = questionSet.get(c.responseKeySha256);
      if (other && JSON.stringify(other) !== JSON.stringify(detail))
        fail("WRITER_RECORD_CHANGED_CROSS_PACKET");
      questionSet.set(c.responseKeySha256, detail);
    }
    if (seen.size !== packetX.cases.length)
      fail("WRITER_RESPONSE_SET_MISMATCH");
  }
  if (
    packetX.cases.length !== packetY.cases.length ||
    sources.size !== packetX.sourceDocuments.length ||
    sources.size !== packetY.sourceDocuments.length ||
    new Set(packetX.cases.map((x) => x.responseKeySha256)).size !==
      questionSet.size ||
    new Set(packetY.cases.map((x) => x.responseKeySha256)).size !==
      questionSet.size
  )
    fail("CROSS_PACKET_SCOPE_MISMATCH");
  const base = {
    schemaVersion: "akp.s2.writer-semantic-audit.v1" as const,
    caseCount: questionSet.size,
    sourceCount: sources.size,
    sourceManifestSha256: input.sourceManifestSha256,
    caseManifestSha256: input.caseManifestSha256,
    rawModelPassageCitationMappingAvailable: false as const,
    originalCustodyIndependentlyAttested: false as const,
    reviewerIndependenceAuthenticated: false as const,
    semanticSupportIndependentlyEstablished: false as const,
    actualAdmissionFalsePositiveRate: null,
    gateAccepted: false as const,
  };
  if ((input.submissionX === undefined) !== (input.submissionY === undefined))
    fail("INCOMPLETE_REVIEWERS");
  if (input.submissionX === undefined)
    return {
      ...base,
      status: "PACKETS_VERIFIED_UNREVIEWED",
      submissionsReceived: 0,
      reviewerLabelAgreement: null,
      reviewerLabelDisagreement: null,
      exactSourceQuoteSpansMatched: null,
    };
  const submitted = new Map<"X" | "Y", Map<string, string>>();
  let verifiedQuoteSpans = 0;
  for (const [label, data] of [
    ["X", input.submissionX],
    ["Y", input.submissionY],
  ] as const) {
    const expected = packetMap.get(label)!;
    if (!object(data)) throw Error("S2_WRITER_AUDIT_SUBMISSION_HEADER_INVALID");
    if (
      !object(data) ||
      !equalKeys(data, submissionKeys) ||
      data.schemaVersion !== "akp.s2.writer-semantic-review-submission.v1" ||
      data.reviewerAssignment !== label ||
      data.packetSha256 !== expected.sha ||
      data.answersFilled !== true ||
      typeof data.independentReviewAttested !== "boolean" ||
      !Array.isArray(data.cases) ||
      data.cases.length !== questionSet.size
    )
      fail("SUBMISSION_HEADER_INVALID");
    const labels = new Map<string, string>();
    for (const item of data.cases as Record<string, unknown>[]) {
      if (
        !object(item) ||
        !equalKeys(item, [
          "responseKeySha256",
          "sourceAnswerability",
          "answerFaithfulness",
          "abstention",
          "exactOriginalQuoteSpans",
          "note",
        ]) ||
        !hex(item.responseKeySha256) ||
        labels.has(item.responseKeySha256) ||
        !questionSet.has(item.responseKeySha256) ||
        !answerStatus.has(String(item.sourceAnswerability)) ||
        !(item.note === null || typeof item.note === "string") ||
        !Array.isArray(item.exactOriginalQuoteSpans) ||
        item.exactOriginalQuoteSpans.length > 15
      )
        fail("SUBMISSION_CASE_INVALID");
      const responseKey = item.responseKeySha256 as string;
      const reply = questionSet.get(responseKey)!;
      if (reply.status === "ANSWER") {
        if (
          !answerFaithfulness.has(String(item.answerFaithfulness)) ||
          item.abstention !== null
        )
          fail("ANSWER_VERDICT_INVALID");
      } else {
        if (
          !abstentionStatus.has(String(item.abstention)) ||
          item.answerFaithfulness !== null
        )
          fail("ABSTENTION_VERDICT_INVALID");
      }
      const seenSpans = new Set<string>();
      for (const quote of item.exactOriginalQuoteSpans as Record<
        string,
        unknown
      >[]) {
        if (
          !object(quote) ||
          !equalKeys(quote, [
            "documentKeySha256",
            "startUtf16",
            "endUtf16",
            "quote",
          ]) ||
          quote.documentKeySha256 !== reply.sourceKey ||
          typeof quote.quote !== "string"
        )
          fail("QUOTE_DOCUMENT_SCOPE_INVALID");
        const original = sources.get(reply.sourceKey)!;
        const originalMeta = packetX.sourceDocuments.find(
          (x) => x.documentKeySha256 === reply.sourceKey,
        )!;
        if (
          !boundary(original, quote.startUtf16) ||
          !boundary(original, quote.endUtf16) ||
          Number(quote.startUtf16) < originalMeta.bodyStartUtf16 ||
          Number(quote.endUtf16) > originalMeta.bodyEndUtf16 ||
          Number(quote.endUtf16) <= Number(quote.startUtf16) ||
          original.slice(
            quote.startUtf16 as number,
            quote.endUtf16 as number,
          ) !== quote.quote ||
          !(quote.quote as string).trim()
        )
          fail("QUOTE_NOT_LITERAL_ORIGINAL_UTF16");
        const spanKey = JSON.stringify([quote.startUtf16, quote.endUtf16]);
        if (seenSpans.has(spanKey)) fail("DUPLICATE_QUOTE");
        seenSpans.add(spanKey);
        verifiedQuoteSpans++;
      }
      if (
        reply.status === "ANSWER" &&
        item.answerFaithfulness === "FULLY_SUPPORTED" &&
        seenSpans.size === 0
      )
        fail("FULL_SUPPORT_WITHOUT_LITERAL_QUOTE");
      if (
        reply.status === "ABSTAIN" &&
        item.abstention === "UNNECESSARY" &&
        seenSpans.size === 0
      )
        fail("UNNECESSARY_ABSTENTION_WITHOUT_QUOTE");
      labels.set(
        responseKey,
        String(item.sourceAnswerability) +
          "|" +
          String(
            reply.status === "ANSWER"
              ? item.answerFaithfulness
              : item.abstention,
          ),
      );
    }
    if (labels.size !== questionSet.size) fail("SUBMISSION_INCOMPLETE");
    submitted.set(label, labels);
  }
  let agreement = 0;
  for (const k of questionSet.keys())
    if (submitted.get("X")!.get(k) === submitted.get("Y")!.get(k)) agreement++;
  return {
    ...base,
    status: "TWO_SEMANTIC_SUBMISSIONS_STRUCTURALLY_VERIFIED",
    submissionsReceived: 2,
    reviewerLabelAgreement: agreement,
    reviewerLabelDisagreement: questionSet.size - agreement,
    exactSourceQuoteSpansMatched: verifiedQuoteSpans,
  };
}
