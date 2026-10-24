import { createHash } from "node:crypto";

const sha = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const hex = (v: unknown): v is string =>
  typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
const obj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const fail = (code: string): never => {
  throw Error("S2_WRITER_COMPAT_" + code);
};
const hasKeys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).length === allowed.length &&
  allowed.every((k) => Object.hasOwn(v, k));
function parse(bytes: Uint8Array, code: string): unknown {
  if (bytes.byteLength < 2 || bytes.byteLength > 1_000_000) fail(code);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    fail(code);
  }
}
function validOffset(source: string, x: unknown): x is number {
  if (
    typeof x !== "number" ||
    !Number.isSafeInteger(x) ||
    x < 0 ||
    x > source.length
  )
    return false;
  if (x === 0 || x === source.length) return true;
  const a = source.charCodeAt(x - 1),
    b = source.charCodeAt(x);
  return !(a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff);
}
type Label = {
  sourceAnswerability:
    "EXPLICITLY_DECIDABLE" | "NOT_SUPPORTED" | "AMBIGUOUS" | "UNDECIDABLE";
  answerFaithfulness:
    | "FULLY_SUPPORTED"
    | "PARTIALLY_SUPPORTED"
    | "UNSUPPORTED_OR_WRONG"
    | "UNDECIDABLE"
    | null;
  abstention: "JUSTIFIED" | "UNNECESSARY" | "UNDECIDABLE" | null;
};
const answers: Record<string, Label["sourceAnswerability"]> = {
  ANSWERABLE_EXPLICIT: "EXPLICITLY_DECIDABLE",
  NOT_ANSWERABLE: "NOT_SUPPORTED",
  AMBIGUOUS: "AMBIGUOUS",
  UNDECIDABLE: "UNDECIDABLE",
  EXPLICITLY_DECIDABLE: "EXPLICITLY_DECIDABLE",
  NOT_SUPPORTED: "NOT_SUPPORTED",
};
const faith: Record<string, NonNullable<Label["answerFaithfulness"]>> = {
  FULL: "FULLY_SUPPORTED",
  FULLY_SUPPORTED: "FULLY_SUPPORTED",
  PARTIAL: "PARTIALLY_SUPPORTED",
  PARTIALLY_SUPPORTED: "PARTIALLY_SUPPORTED",
  UNSUPPORTED_OR_WRONG: "UNSUPPORTED_OR_WRONG",
  UNDECIDABLE: "UNDECIDABLE",
};
const abst: Record<string, NonNullable<Label["abstention"]>> = {
  JUSTIFIED: "JUSTIFIED",
  UNNECESSARY: "UNNECESSARY",
  UNDECIDABLE: "UNDECIDABLE",
};
export interface CompatibleWriterReviewResult {
  normalized: {
    schemaVersion: "akp.s2.writer-semantic-review-submission.v1";
    reviewerAssignment: "X" | "Y";
    packetSha256: string;
    cases: {
      responseKeySha256: string;
      sourceAnswerability: Label["sourceAnswerability"];
      answerFaithfulness: Label["answerFaithfulness"];
      abstention: Label["abstention"];
      exactOriginalQuoteSpans: {
        documentKeySha256: string;
        startUtf16: number;
        endUtf16: number;
        quote: string;
      }[];
      note: string | null;
    }[];
    answersFilled: true;
    independentReviewAttested: boolean;
  };
  audit: {
    schemaVersion: "akp.s2.writer-submission-compat-audit.v1";
    status: "EXACT_SOURCE_VERIFIED_NORMALIZED_ONLY";
    reviewerAssignment: "X" | "Y";
    originalSubmissionSha256: string;
    packetSha256: string;
    responseCount: number;
    originalQuoteSpansVerified: number;
    sourceDocumentKeysDerived: number;
    sourceShaFieldsVerified: number;
    nonCanonicalAnswerabilityLabels: number;
    nonCanonicalFaithfulnessLabels: number;
    independentReviewAttested: boolean;
    semanticEntailmentIndependentlyCertified: false;
    gateAccepted: false;
  };
}
/**
 * A strictly checked data adapter for reviewer payloads, NOT a semantic evaluator.
 * Source document keys may only be recovered from the hash-pinned frozen
 * reviewer packet; source text must match that packet's source digest.
 * Never rewrite the submitted input bytes.
 */
export function adaptWriterReviewSubmission(input: {
  rawSubmissionBytes: Uint8Array;
  frozenPacketBytes: Uint8Array;
  expectedPacketSha256: string;
  expectedReviewer: "X" | "Y";
}): CompatibleWriterReviewResult {
  if (
    !hex(input.expectedPacketSha256) ||
    sha(input.frozenPacketBytes) !== input.expectedPacketSha256
  )
    fail("PACKET_HASH_MISMATCH");
  const packet = parse(input.frozenPacketBytes, "PACKET_INVALID");
  const submission = parse(input.rawSubmissionBytes, "SUBMISSION_INVALID");
  if (!obj(packet)) throw Error("S2_WRITER_COMPAT_PACKET_HEADER_INVALID");
  if (!obj(submission))
    throw Error("S2_WRITER_COMPAT_SUBMISSION_SCOPE_INVALID");
  if (
    !obj(packet) ||
    packet.schemaVersion !== "akp.s2.writer-semantic-blind-packet.v1" ||
    packet.reviewerAssignment !== input.expectedReviewer ||
    !Array.isArray(packet.cases) ||
    !Array.isArray(packet.sourceDocuments)
  )
    fail("PACKET_HEADER_INVALID");
  if (
    !obj(submission) ||
    !hasKeys(submission, [
      "schemaVersion",
      "reviewerAssignment",
      "packetSha256",
      "cases",
      "answersFilled",
      "independentReviewAttested",
    ]) ||
    submission.schemaVersion !==
      "akp.s2.writer-semantic-review-submission.v1" ||
    submission.reviewerAssignment !== input.expectedReviewer ||
    submission.packetSha256 !== input.expectedPacketSha256 ||
    submission.answersFilled !== true ||
    typeof submission.independentReviewAttested !== "boolean" ||
    !Array.isArray(submission.cases) ||
    submission.cases.length !== (packet.cases as unknown[]).length
  )
    fail("SUBMISSION_SCOPE_INVALID");
  const packetSources = packet.sourceDocuments as Record<string, unknown>[];
  const packetCases = packet.cases as Record<string, unknown>[];
  const reviewerCases = submission.cases as Record<string, unknown>[];
  const source = new Map<string, Record<string, unknown>>();
  for (const s of packetSources) {
    if (
      !obj(s) ||
      !hex(s.documentKeySha256) ||
      source.has(s.documentKeySha256) ||
      !hex(s.sourceSha256) ||
      typeof s.sourceText !== "string" ||
      sha(new TextEncoder().encode(s.sourceText)) !== s.sourceSha256 ||
      !validOffset(s.sourceText, s.bodyStartUtf16) ||
      !validOffset(s.sourceText, s.bodyEndUtf16) ||
      Number(s.bodyStartUtf16) >= Number(s.bodyEndUtf16)
    )
      fail("PACKET_SOURCE_NOT_INTEGRITY_BOUND");
    source.set(s.documentKeySha256 as string, s);
  }
  const expected = new Map<string, Record<string, unknown>>();
  for (const c of packetCases) {
    if (
      !obj(c) ||
      !hex(c.responseKeySha256) ||
      !hex(c.sourceDocumentKeySha256) ||
      !source.has(c.sourceDocumentKeySha256) ||
      !(c.writerStatus === "ANSWER" || c.writerStatus === "ABSTAIN") ||
      expected.has(c.responseKeySha256)
    )
      fail("PACKET_RESPONSE_INVALID");
    expected.set(c.responseKeySha256 as string, c);
  }
  const seen = new Set<string>();
  const out: CompatibleWriterReviewResult["normalized"]["cases"] = [];
  let derived = 0,
    hashVerified = 0,
    quoteCount = 0,
    normalizedAnswerability = 0,
    normalizedFaith = 0;
  for (const row of reviewerCases) {
    if (
      !obj(row) ||
      !hasKeys(row, [
        "responseKeySha256",
        "sourceAnswerability",
        "answerFaithfulness",
        "abstention",
        "exactOriginalQuoteSpans",
        "note",
      ]) ||
      !hex(row.responseKeySha256) ||
      seen.has(row.responseKeySha256) ||
      !expected.has(row.responseKeySha256) ||
      typeof row.sourceAnswerability !== "string" ||
      !Object.hasOwn(answers, row.sourceAnswerability) ||
      !(
        row.note === null ||
        (typeof row.note === "string" && row.note.length <= 5000)
      ) ||
      !Array.isArray(row.exactOriginalQuoteSpans) ||
      row.exactOriginalQuoteSpans.length > 20
    )
      fail("REVIEWER_ROW_INVALID");
    const responseKey = row.responseKeySha256 as string;
    const answerabilityKey = row.sourceAnswerability as string;
    const bound = expected.get(responseKey)!;
    seen.add(responseKey);
    const ans = answers[answerabilityKey]!;
    if (row.sourceAnswerability !== ans) normalizedAnswerability++;
    let faithful: Label["answerFaithfulness"] = null,
      abstention: Label["abstention"] = null;
    if (bound.writerStatus === "ANSWER") {
      if (
        typeof row.answerFaithfulness !== "string" ||
        !Object.hasOwn(faith, row.answerFaithfulness) ||
        row.abstention !== null
      )
        fail("ANSWER_LABEL_INVALID");
      faithful = faith[row.answerFaithfulness as string]!;
      if (faithful !== row.answerFaithfulness) normalizedFaith++;
    } else {
      if (
        typeof row.abstention !== "string" ||
        !Object.hasOwn(abst, row.abstention) ||
        row.answerFaithfulness !== null
      )
        fail("ABSTAIN_LABEL_INVALID");
      abstention = abst[row.abstention as string]!;
    }
    const sourceKey = bound.sourceDocumentKeySha256 as string;
    const original = source.get(sourceKey)!;
    const text = original.sourceText as string;
    const seenQuotes = new Set<string>();
    const quotes: CompatibleWriterReviewResult["normalized"]["cases"][number]["exactOriginalQuoteSpans"] =
      [];
    for (const q of row.exactOriginalQuoteSpans as Record<string, unknown>[]) {
      if (
        !obj(q) ||
        ![
          "quote",
          "startUtf16",
          "endUtf16",
          "documentKeySha256",
          "sourceSha256",
        ].every(
          (k) =>
            Object.hasOwn(q, k) ||
            k === "documentKeySha256" ||
            k === "sourceSha256",
        ) ||
        Object.keys(q).some(
          (k) =>
            ![
              "quote",
              "startUtf16",
              "endUtf16",
              "documentKeySha256",
              "sourceSha256",
            ].includes(k),
        ) ||
        typeof q.quote !== "string" ||
        !q.quote.trim() ||
        (Object.hasOwn(q, "documentKeySha256") &&
          q.documentKeySha256 !== sourceKey) ||
        (Object.hasOwn(q, "sourceSha256") &&
          q.sourceSha256 !== original.sourceSha256)
      )
        fail("QUOTE_SOURCE_IDENTITY_INVALID");
      if (!Object.hasOwn(q, "documentKeySha256")) derived++;
      if (Object.hasOwn(q, "sourceSha256")) hashVerified++;
      if (
        !validOffset(text, q.startUtf16) ||
        !validOffset(text, q.endUtf16) ||
        Number(q.startUtf16) < Number(original.bodyStartUtf16) ||
        Number(q.endUtf16) > Number(original.bodyEndUtf16) ||
        Number(q.endUtf16) <= Number(q.startUtf16) ||
        text.slice(q.startUtf16 as number, q.endUtf16 as number) !== q.quote
      )
        fail("QUOTE_NOT_EXACT_ORIGINAL_UTF16");
      const id = JSON.stringify([sourceKey, q.startUtf16, q.endUtf16]);
      if (seenQuotes.has(id)) fail("DUPLICATE_QUOTE");
      seenQuotes.add(id);
      quoteCount++;
      quotes.push({
        documentKeySha256: sourceKey,
        startUtf16: q.startUtf16 as number,
        endUtf16: q.endUtf16 as number,
        quote: q.quote as string,
      });
    }
    if (
      bound.writerStatus === "ANSWER" &&
      faithful === "FULLY_SUPPORTED" &&
      !quotes.length
    )
      fail("SUPPORTED_WITHOUT_SOURCE_QUOTE");
    if (
      bound.writerStatus === "ABSTAIN" &&
      abstention === "UNNECESSARY" &&
      !quotes.length
    )
      fail("UNNECESSARY_WITHOUT_SOURCE_QUOTE");
    out.push({
      responseKeySha256: responseKey,
      sourceAnswerability: ans,
      answerFaithfulness: faithful,
      abstention,
      exactOriginalQuoteSpans: quotes,
      note: row.note as string | null,
    });
  }
  if (seen.size !== expected.size) fail("INCOMPLETE_REVIEWER_SCOPE");
  return {
    normalized: {
      schemaVersion: "akp.s2.writer-semantic-review-submission.v1",
      reviewerAssignment: input.expectedReviewer,
      packetSha256: input.expectedPacketSha256,
      cases: out,
      answersFilled: true,
      independentReviewAttested:
        submission.independentReviewAttested as boolean,
    },
    audit: {
      schemaVersion: "akp.s2.writer-submission-compat-audit.v1",
      status: "EXACT_SOURCE_VERIFIED_NORMALIZED_ONLY",
      reviewerAssignment: input.expectedReviewer,
      originalSubmissionSha256: sha(input.rawSubmissionBytes),
      packetSha256: input.expectedPacketSha256,
      responseCount: out.length,
      originalQuoteSpansVerified: quoteCount,
      sourceDocumentKeysDerived: derived,
      sourceShaFieldsVerified: hashVerified,
      nonCanonicalAnswerabilityLabels: normalizedAnswerability,
      nonCanonicalFaithfulnessLabels: normalizedFaith,
      independentReviewAttested:
        submission.independentReviewAttested as boolean,
      semanticEntailmentIndependentlyCertified: false,
      gateAccepted: false,
    },
  };
}
