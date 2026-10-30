import { createHash } from "node:crypto";

const HEX = /^[0-9a-f]{64}$/u;
const VERDICTS = new Set([
  "ANSWERABLE_EXPLICIT",
  "NOT_ANSWERABLE",
  "AMBIGUOUS",
  "CONTRADICTED",
]);
const hash = (input: Uint8Array | string) =>
  createHash("sha256").update(input).digest("hex");
const fail = (reason: string): never => {
  throw new Error("S2_SECTION_BLIND_" + reason);
};
const record = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const fields = (v: Record<string, unknown>, names: string[]) =>
  Object.keys(v).length === names.length &&
  names.every((name) => Object.hasOwn(v, name));
function assertRecord(
  value: unknown,
  code: string,
): asserts value is Record<string, unknown> {
  if (!record(value)) fail(code);
}
function assertArray(
  value: unknown,
  code: string,
): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(record))
    throw new Error("S2_SECTION_BLIND_" + code);
}
const validHex = (v: unknown): v is string =>
  typeof v === "string" && HEX.test(v);
const validBoundary = (text: string, x: unknown): x is number => {
  if (
    !Number.isSafeInteger(x) ||
    typeof x !== "number" ||
    x < 0 ||
    x > text.length
  )
    return false;
  if (x === 0 || x === text.length) return true;
  const h = text.charCodeAt(x - 1),
    l = text.charCodeAt(x);
  return !(h >= 0xd800 && h <= 0xdbff && l >= 0xdc00 && l <= 0xdfff);
};
function jsonBytes(bytes: Uint8Array, code: string): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    fail(code);
  }
}
function pinned(bytes: Uint8Array, pin: string, code: string): unknown {
  if (
    !validHex(pin) ||
    !bytes.byteLength ||
    bytes.byteLength > 2_000_000 ||
    hash(bytes) !== pin
  )
    fail(code);
  return jsonBytes(bytes, code + "_JSON");
}
interface Source {
  documentKey: string;
  upstreamRevision: string;
  sourceSha256: string;
  sourceBodyStartUtf16: number;
  sourceBodyEndUtf16: number;
  sourceText: string;
}
interface Question {
  questionKey: string;
  language: "en" | "es";
  question: string;
}
export interface BlindReviewerQuote {
  documentKey: string;
  startUtf16: number;
  endUtf16: number;
  quote: string;
}
export interface BlindReviewerResponseCase {
  questionKey: string;
  answerability:
    "ANSWERABLE_EXPLICIT" | "NOT_ANSWERABLE" | "AMBIGUOUS" | "CONTRADICTED";
  answerText: string;
  quotes: BlindReviewerQuote[];
  note: string | null;
}
export interface BlindReviewerSubmission {
  schemaVersion: "akp.s2.section-blind-review-submission.v1";
  reviewerAssignment: "A" | "B";
  packetSha256: string;
  cases: BlindReviewerResponseCase[];
}
export interface SourceBytes {
  /** Source identity must match the frozen manifest (not a matching name). */
  documentId: string;
  bytes: Uint8Array;
}
export interface SectionBlindReviewAudit {
  schemaVersion: "akp.s2.section-blind-review-audit.v1";
  status:
    "UNREVIEWED_PACKETS_VERIFIED" | "TWO_SUBMISSIONS_STRUCTURALLY_VERIFIED";
  packetCount: 2;
  caseCount: number;
  sourceCount: number;
  sourceManifestSha256: string;
  caseManifestSha256: string;
  reviewerSubmissionsReceived: 0 | 2;
  classificationAgreementCount: number | null;
  classificationDisagreementCount: number | null;
  originalFileQuotesMatched: number | null;
  originalFileQuotesTotal: number | null;
  reviewerIndependenceAuthenticated: false;
  originalCustodyIndependentlyAttested: false;
  reviewerJudgmentsSemanticallyVerified: false;
  reviewerConsensusAdjudicated: false;
  writerAnswerCorrectness: null;
  falseAdmissionRate: null;
  gateAccepted: false;
}
/**
 * Audit only. The original packets are immutable. Reviewer submissions must
 * be separate JSON artifacts so the receipt hashes never change.
 * No private task/source/answer text is emitted by this function.
 */
export function auditSectionBlindReviews(input: {
  receiptBytes: Uint8Array;
  packetABytes: Uint8Array;
  packetBBytes: Uint8Array;
  sourceManifestBytes: Uint8Array;
  sourceManifestSha256: string;
  caseManifestBytes: Uint8Array;
  caseManifestSha256: string;
  sourceFiles: readonly SourceBytes[];
  submissionA?: unknown;
  submissionB?: unknown;
}): SectionBlindReviewAudit {
  const receipt = jsonBytes(input.receiptBytes, "RECEIPT_INVALID");
  assertRecord(receipt, "RECEIPT_INCONSISTENT");
  if (
    !record(receipt) ||
    !fields(receipt, [
      "schemaVersion",
      "casePin",
      "sourcePin",
      "receipts",
      "reviewerSubmissionsReceived",
      "independentReviewEstablished",
      "gateAccepted",
    ]) ||
    receipt.schemaVersion !== "akp.s2.section-dev-reviewer-packet-receipt.v1" ||
    receipt.casePin !== input.caseManifestSha256 ||
    receipt.sourcePin !== input.sourceManifestSha256 ||
    receipt.reviewerSubmissionsReceived !== 0 ||
    receipt.independentReviewEstablished !== false ||
    receipt.gateAccepted !== false ||
    !Array.isArray(receipt.receipts) ||
    receipt.receipts.length !== 2
  )
    fail("RECEIPT_INCONSISTENT");

  const sourceManifest = pinned(
    input.sourceManifestBytes,
    input.sourceManifestSha256,
    "SOURCE_MANIFEST_PIN_MISMATCH",
  );
  const caseManifest = pinned(
    input.caseManifestBytes,
    input.caseManifestSha256,
    "CASE_MANIFEST_PIN_MISMATCH",
  );
  assertRecord(sourceManifest, "MANIFEST_SCHEMA_INVALID");
  assertRecord(caseManifest, "MANIFEST_SCHEMA_INVALID");
  if (
    !record(sourceManifest) ||
    !fields(sourceManifest, ["schemaVersion", "files"]) ||
    sourceManifest.schemaVersion !== "akp.s2.section-frozen-manifest.v1" ||
    !Array.isArray(sourceManifest.files) ||
    sourceManifest.files.length < 1 ||
    sourceManifest.files.length > 200 ||
    !record(caseManifest) ||
    !fields(caseManifest, [
      "schemaVersion",
      "executedCommitSha",
      "sourceManifestSha256",
      "cases",
    ]) ||
    caseManifest.schemaVersion !== "akp.s2.section-paired-manifest.v1" ||
    caseManifest.sourceManifestSha256 !== input.sourceManifestSha256 ||
    !Array.isArray(caseManifest.cases) ||
    caseManifest.cases.length < 1 ||
    caseManifest.cases.length > 10_000
  )
    fail("MANIFEST_SCHEMA_INVALID");

  assertArray(sourceManifest.files, "MANIFEST_SCHEMA_INVALID");
  assertArray(caseManifest.cases, "MANIFEST_SCHEMA_INVALID");
  assertArray(receipt.receipts, "RECEIPT_INCONSISTENT");
  const rawFileByDocumentKey = new Map<string, string>();
  const originalFiles = new Map<string, Record<string, unknown>>();
  for (const entry of sourceManifest.files) {
    if (
      !record(entry) ||
      !fields(entry, [
        "vaultId",
        "documentId",
        "revision",
        "path",
        "fileSha256",
        "bodyStartUtf16",
        "bodyEndUtf16",
      ]) ||
      typeof entry.documentId !== "string" ||
      !validHex(entry.fileSha256)
    )
      fail("SOURCE_MANIFEST_RECORD");
    const key = hash(entry.documentId as string);
    if (originalFiles.has(key)) fail("DUPLICATE_SOURCE");
    originalFiles.set(key, entry);
  }
  if (input.sourceFiles.length !== originalFiles.size)
    fail("SOURCE_FILE_SET_MISMATCH");
  for (const file of input.sourceFiles) {
    const key = hash(file.documentId),
      entry = originalFiles.get(key);
    if (!entry)
      throw new Error("S2_SECTION_BLIND_SOURCE_FILE_HASH_OR_SCOPE_MISMATCH");
    if (
      rawFileByDocumentKey.has(key) ||
      file.bytes.byteLength > 1_000_000 ||
      hash(file.bytes) !== entry.fileSha256
    )
      fail("SOURCE_FILE_HASH_OR_SCOPE_MISMATCH");
    let text = "";
    try {
      text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(file.bytes);
    } catch {
      fail("SOURCE_FILE_INVALID_UTF8");
    }
    if (
      !validBoundary(text, entry.bodyStartUtf16) ||
      !validBoundary(text, entry.bodyEndUtf16) ||
      Number(entry.bodyEndUtf16) <= Number(entry.bodyStartUtf16)
    )
      fail("SOURCE_FRAME_INVALID");
    rawFileByDocumentKey.set(key, text);
  }

  const cases = new Map<string, Question>();
  for (const item of caseManifest.cases) {
    if (
      !record(item) ||
      !fields(item, [
        "caseKeySha256",
        "scopeSha256",
        "sourceFamilySha256",
        "language",
      ]) ||
      !validHex(item.caseKeySha256) ||
      !validHex(item.scopeSha256) ||
      !validHex(item.sourceFamilySha256) ||
      (item.language !== "en" && item.language !== "es") ||
      cases.has(item.caseKeySha256)
    )
      fail("CASE_MANIFEST_INVALID");
    cases.set(item.caseKeySha256 as string, {
      questionKey: item.caseKeySha256 as string,
      language: item.language as "en" | "es",
      question: "",
    });
  }

  const packets = new Map<
    "A" | "B",
    {
      sourceMap: Map<string, Source>;
      caseMap: Map<string, Question>;
      packetSha256: string;
    }
  >();
  for (const [i, label, bytes] of [
    [0, "A", input.packetABytes],
    [1, "B", input.packetBBytes],
  ] as const) {
    const receiptItem = receipt.receipts[i]!;
    if (
      !record(receiptItem) ||
      !fields(receiptItem, [
        "reviewer",
        "filename",
        "packetSha256",
        "cases",
        "sources",
      ]) ||
      receiptItem.reviewer !== label ||
      !validHex(receiptItem.packetSha256) ||
      hash(bytes) !== receiptItem.packetSha256 ||
      receiptItem.cases !== cases.size ||
      receiptItem.sources !== originalFiles.size
    )
      fail("PACKET_RECEIPT_MISMATCH");
    const packet = jsonBytes(bytes, "PACKET_INVALID");
    assertRecord(packet, "PACKET_HEADER_INVALID");
    if (
      !record(packet) ||
      !fields(packet, [
        "schemaVersion",
        "status",
        "reviewerAssignment",
        "caseManifestSha256",
        "sourceManifestSha256",
        "instructions",
        "allowedAnswerability",
        "originalSources",
        "cases",
        "goldIncluded",
        "writerOutputsIncluded",
        "independentReviewEstablished",
        "gateAccepted",
      ]) ||
      packet.schemaVersion !== "akp.s2.section-new-mdn-blind-dev-review.v1" ||
      packet.status !== "UNREVIEWED_DEV_ONLY_NOT_INDEPENDENT_HOLDOUT" ||
      packet.reviewerAssignment !== label ||
      packet.caseManifestSha256 !== input.caseManifestSha256 ||
      packet.sourceManifestSha256 !== input.sourceManifestSha256 ||
      packet.goldIncluded !== false ||
      packet.writerOutputsIncluded !== false ||
      packet.independentReviewEstablished !== false ||
      packet.gateAccepted !== false ||
      !Array.isArray(packet.originalSources) ||
      packet.originalSources.length !== originalFiles.size ||
      !Array.isArray(packet.cases) ||
      packet.cases.length !== cases.size
    )
      fail("PACKET_HEADER_INVALID");
    assertArray(packet.originalSources, "PACKET_HEADER_INVALID");
    assertArray(packet.cases, "PACKET_HEADER_INVALID");
    const sourceMap = new Map<string, Source>();
    for (const source of packet.originalSources) {
      if (
        !record(source) ||
        !fields(source, [
          "documentKey",
          "upstreamRevision",
          "sourceSha256",
          "sourceBodyStartUtf16",
          "sourceBodyEndUtf16",
          "sourceText",
        ]) ||
        !validHex(source.documentKey) ||
        sourceMap.has(source.documentKey) ||
        !originalFiles.has(source.documentKey) ||
        typeof source.sourceText !== "string"
      )
        fail("PACKET_SOURCE_IDENTITY");
      const sourceKey = source.documentKey as string;
      const original = originalFiles.get(sourceKey)!;
      const raw = rawFileByDocumentKey.get(sourceKey);
      if (
        raw !== source.sourceText ||
        hash(new TextEncoder().encode(source.sourceText as string)) !==
          source.sourceSha256 ||
        source.sourceSha256 !== original.fileSha256 ||
        source.upstreamRevision !== original.revision ||
        source.sourceBodyStartUtf16 !== original.bodyStartUtf16 ||
        source.sourceBodyEndUtf16 !== original.bodyEndUtf16
      )
        fail("PACKET_SOURCE_NOT_ORIGINAL");
      sourceMap.set(sourceKey, source as unknown as Source);
    }
    const caseMap = new Map<string, Question>();
    for (const q of packet.cases) {
      if (
        !record(q) ||
        !fields(q, [
          "questionKey",
          "language",
          "question",
          "answerability",
          "answerText",
          "quotes",
          "note",
        ]) ||
        !validHex(q.questionKey) ||
        caseMap.has(q.questionKey) ||
        !cases.has(q.questionKey) ||
        q.language !== cases.get(q.questionKey)!.language ||
        typeof q.question !== "string" ||
        q.questionKey !== hash(q.language + "\0" + q.question) ||
        q.answerability !== null ||
        q.answerText !== null ||
        !Array.isArray(q.quotes) ||
        q.quotes.length !== 0 ||
        q.note !== null
      )
        fail("PACKET_QUESTION_TAMPERED_OR_PRELABELED");
      caseMap.set(q.questionKey as string, q as unknown as Question);
    }
    if (caseMap.size !== cases.size || sourceMap.size !== originalFiles.size)
      fail("PACKET_INCOMPLETE");
    packets.set(label, {
      caseMap,
      sourceMap,
      packetSha256: receiptItem.packetSha256 as string,
    });
  }
  for (const key of cases.keys()) {
    if (
      packets.get("A")!.caseMap.get(key)?.question !==
      packets.get("B")!.caseMap.get(key)?.question
    )
      fail("CROSS_PACKET_QUESTION_MISMATCH");
  }
  const hasA = input.submissionA !== undefined;
  const hasB = input.submissionB !== undefined;
  if (hasA !== hasB) fail("REVIEWER_SUBMISSIONS_INCOMPLETE");
  if (!hasA)
    return {
      schemaVersion: "akp.s2.section-blind-review-audit.v1",
      status: "UNREVIEWED_PACKETS_VERIFIED",
      packetCount: 2,
      caseCount: cases.size,
      sourceCount: originalFiles.size,
      caseManifestSha256: input.caseManifestSha256,
      sourceManifestSha256: input.sourceManifestSha256,
      reviewerSubmissionsReceived: 0,
      classificationAgreementCount: null,
      classificationDisagreementCount: null,
      originalFileQuotesMatched: null,
      originalFileQuotesTotal: null,
      reviewerIndependenceAuthenticated: false,
      originalCustodyIndependentlyAttested: false,
      reviewerJudgmentsSemanticallyVerified: false,
      reviewerConsensusAdjudicated: false,
      writerAnswerCorrectness: null,
      falseAdmissionRate: null,
      gateAccepted: false,
    };
  const verdicts = new Map<"A" | "B", Map<string, string>>();
  let quoteCount = 0;
  for (const [label, submitted] of [
    ["A", input.submissionA],
    ["B", input.submissionB],
  ] as const) {
    const packet = packets.get(label)!;
    assertRecord(submitted, "SUBMISSION_HEADER");
    if (
      !record(submitted) ||
      !fields(submitted, [
        "schemaVersion",
        "reviewerAssignment",
        "packetSha256",
        "cases",
      ]) ||
      submitted.schemaVersion !== "akp.s2.section-blind-review-submission.v1" ||
      submitted.reviewerAssignment !== label ||
      submitted.packetSha256 !== packet.packetSha256 ||
      !Array.isArray(submitted.cases) ||
      submitted.cases.length !== cases.size
    )
      fail("SUBMISSION_HEADER");
    assertArray(submitted.cases, "SUBMISSION_HEADER");
    const mapped = new Map<string, string>();
    for (const c of submitted.cases) {
      if (
        !record(c) ||
        !fields(c, [
          "questionKey",
          "answerability",
          "answerText",
          "quotes",
          "note",
        ]) ||
        !validHex(c.questionKey) ||
        !packet.caseMap.has(c.questionKey) ||
        mapped.has(c.questionKey) ||
        !VERDICTS.has(String(c.answerability)) ||
        typeof c.answerText !== "string" ||
        c.answerText.length > 20_000 ||
        !(
          c.note === null ||
          (typeof c.note === "string" && c.note.length <= 4_000)
        ) ||
        !Array.isArray(c.quotes) ||
        c.quotes.length > 12
      )
        fail("SUBMISSION_CASE_INVALID");
      const answerText = c.answerText as string;
      const quotes = c.quotes as Record<string, unknown>[];
      if (
        c.answerability === "ANSWERABLE_EXPLICIT" ||
        c.answerability === "CONTRADICTED"
      ) {
        if (!answerText.trim() || quotes.length === 0)
          fail("POSITIVE_WITHOUT_EXACT_EVIDENCE");
      } else if (c.answerability === "NOT_ANSWERABLE") {
        if (answerText !== "" || quotes.length !== 0)
          fail("NEGATIVE_MUST_ABSTAIN");
      }
      const seenSpans = new Set<string>();
      for (const citation of quotes) {
        if (
          !record(citation) ||
          !fields(citation, [
            "documentKey",
            "startUtf16",
            "endUtf16",
            "quote",
          ]) ||
          !validHex(citation.documentKey) ||
          !packet.sourceMap.has(citation.documentKey) ||
          typeof citation.quote !== "string"
        )
          fail("SUBMISSION_CITATION_INVALID");
        const sourceKey = citation.documentKey as string;
        const raw = rawFileByDocumentKey.get(sourceKey)!;
        const original = originalFiles.get(sourceKey)!;
        if (
          !validBoundary(raw, citation.startUtf16) ||
          !validBoundary(raw, citation.endUtf16) ||
          citation.startUtf16 < Number(original.bodyStartUtf16) ||
          citation.endUtf16 > Number(original.bodyEndUtf16) ||
          citation.endUtf16 <= citation.startUtf16 ||
          raw.slice(citation.startUtf16, citation.endUtf16) !==
            citation.quote ||
          !citation.quote.trim()
        )
          fail("CITATION_NOT_EXACT_ORIGINAL_UTF16");
        const identity = JSON.stringify([
          citation.documentKey,
          citation.startUtf16,
          citation.endUtf16,
        ]);
        if (seenSpans.has(identity)) fail("DUPLICATE_QUOTE");
        seenSpans.add(identity);
        quoteCount += 1;
      }
      mapped.set(c.questionKey as string, c.answerability as string);
    }
    if (mapped.size !== cases.size) fail("SUBMISSION_INCOMPLETE");
    verdicts.set(label, mapped);
  }
  let agreement = 0;
  for (const caseKey of cases.keys()) {
    if (verdicts.get("A")!.get(caseKey) === verdicts.get("B")!.get(caseKey))
      agreement++;
  }
  return {
    schemaVersion: "akp.s2.section-blind-review-audit.v1",
    status: "TWO_SUBMISSIONS_STRUCTURALLY_VERIFIED",
    packetCount: 2,
    caseCount: cases.size,
    sourceCount: originalFiles.size,
    sourceManifestSha256: input.sourceManifestSha256,
    caseManifestSha256: input.caseManifestSha256,
    reviewerSubmissionsReceived: 2,
    classificationAgreementCount: agreement,
    classificationDisagreementCount: cases.size - agreement,
    originalFileQuotesMatched: quoteCount,
    originalFileQuotesTotal: quoteCount,
    reviewerIndependenceAuthenticated: false,
    originalCustodyIndependentlyAttested: false,
    reviewerJudgmentsSemanticallyVerified: false,
    reviewerConsensusAdjudicated: false,
    writerAnswerCorrectness: null,
    falseAdmissionRate: null,
    gateAccepted: false,
  };
}
