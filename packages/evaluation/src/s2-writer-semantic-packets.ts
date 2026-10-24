import { createHash } from "node:crypto";

const SHA = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const HEX = /^[a-f0-9]{64}$/u;
const isObj = (o: unknown): o is Record<string, unknown> =>
  o !== null && typeof o === "object" && !Array.isArray(o);
function assertObject(
  value: unknown,
  code: string,
): asserts value is Record<string, unknown> {
  if (!isObj(value)) throw new Error("S2_WRITER_REVIEW_" + code);
}
function assertObjectRows(
  value: unknown,
  code: string,
): asserts value is Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isObj))
    throw new Error("S2_WRITER_REVIEW_" + code);
}
const refuse = (why: string): never => {
  throw new Error("S2_WRITER_REVIEW_" + why);
};
const sortWithSalt = (salt: string, a: string, b: string) =>
  SHA(salt + "|" + a).localeCompare(SHA(salt + "|" + b));
const wellHex = (o: unknown) => typeof o === "string" && HEX.test(o);
const asJSON = (b: Uint8Array, code: string): unknown => {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(b),
    ) as unknown;
  } catch {
    return refuse(code);
  }
};
type FileReference = {
  documentId: string;
  bytes: Uint8Array;
};
type PrivateQuestion = {
  questionKeySha256: string;
  documentId: string;
  language: "en" | "es";
  question: string;
};
type WriterOutput = {
  arm: "CHILD_ONLY" | "VERIFIED_SECTION_ENRICHED";
  status: "ANSWER" | "ABSTAIN";
  answer: string;
  citations: string[];
  providerError: null;
  citationIdsValid: true;
};
type WriterRow = {
  caseKeySha256: string;
  sourceSha256: string;
  verifiedSectionCount: number;
  outputs: WriterOutput[];
};
export interface BlindedWriterSource {
  documentKeySha256: string;
  sourceText: string;
  sourceSha256: string;
  bodyStartUtf16: number;
  bodyEndUtf16: number;
}
export interface BlindedWriterCase {
  responseKeySha256: string;
  language: "en" | "es";
  question: string;
  sourceDocumentKeySha256: string;
  writerStatus: "ANSWER" | "ABSTAIN";
  writerAnswer: string;
  reportedCitationIds: string[];
  annotation: {
    sourceAnswerability:
      | "EXPLICITLY_DECIDABLE"
      | "NOT_SUPPORTED"
      | "AMBIGUOUS"
      | "UNDECIDABLE"
      | null;
    answerFaithfulness:
      | "FULLY_SUPPORTED"
      | "PARTIALLY_SUPPORTED"
      | "UNSUPPORTED_OR_WRONG"
      | "UNDECIDABLE"
      | null;
    abstention: "JUSTIFIED" | "UNNECESSARY" | "UNDECIDABLE" | null;
    exactOriginalQuoteSpans: {
      documentKeySha256: string;
      startUtf16: number;
      endUtf16: number;
      quote: string;
    }[];
    note: string | null;
  };
}
export interface BlindedWriterReviewPacket {
  schemaVersion: "akp.s2.writer-semantic-blind-packet.v1";
  reviewerAssignment: "X" | "Y";
  caseManifestSha256: string;
  sourceManifestSha256: string;
  writerRunSha256: string;
  instructions: string;
  sourceDocuments: BlindedWriterSource[];
  cases: BlindedWriterCase[];
  armAllocationRevealed: false;
  originalReviewerVerdictsIncluded: false;
  fullModelCitationSourceMappingAvailable: false;
  originalSourceSemanticJudgmentsOnly: true;
  reviewerIndependenceAuthenticated: false;
  gateAccepted: false;
}
export interface BlindedWriterReviewBuild {
  packets: [BlindedWriterReviewPacket, BlindedWriterReviewPacket];
  /** Must remain in private storage, never sent to reviewers. */
  privateArmMap: {
    responseKeySha256: string;
    caseKeySha256: string;
    arm: string;
    originalCitationIds: string[];
  }[];
  expectedResponseCount: number;
  sourceCount: number;
  independentSemanticReviewCompleted: false;
  gateAccepted: false;
}
/**
 * Prepares UNREVIEWED packets; does not assess answers, assign gold or
 * authenticate source custody. Pass a fresh private 32-byte owner seed.
 */
export function buildBlindedWriterReviewPackets(input: {
  sourceManifestBytes: Uint8Array;
  pinnedSourceManifestSha256: string;
  caseManifestBytes: Uint8Array;
  pinnedCaseManifestSha256: string;
  sourceFiles: readonly FileReference[];
  questions: readonly PrivateQuestion[];
  writerRunBytes: Uint8Array;
  privateOwnerSeed: Uint8Array;
}): BlindedWriterReviewBuild {
  if (
    input.privateOwnerSeed.byteLength !== 32 ||
    !wellHex(input.pinnedSourceManifestSha256) ||
    !wellHex(input.pinnedCaseManifestSha256) ||
    SHA(input.sourceManifestBytes) !== input.pinnedSourceManifestSha256 ||
    SHA(input.caseManifestBytes) !== input.pinnedCaseManifestSha256
  )
    refuse("FROZEN_INPUT_PIN_OR_SEED_INVALID");
  const src = asJSON(input.sourceManifestBytes, "SOURCE_MANIFEST_INVALID");
  const cases = asJSON(input.caseManifestBytes, "CASE_MANIFEST_INVALID");
  const captured = asJSON(input.writerRunBytes, "WRITER_RUN_INVALID");
  assertObject(src, "FROZEN_INPUT_SCHEMA_INVALID");
  assertObject(cases, "FROZEN_INPUT_SCHEMA_INVALID");
  assertObject(captured, "FROZEN_INPUT_SCHEMA_INVALID");
  if (
    !isObj(src) ||
    !Array.isArray(src.files) ||
    src.schemaVersion !== "akp.s2.section-frozen-manifest.v1" ||
    !isObj(cases) ||
    !Array.isArray(cases.cases) ||
    cases.schemaVersion !== "akp.s2.section-paired-manifest.v1" ||
    cases.sourceManifestSha256 !== input.pinnedSourceManifestSha256 ||
    !isObj(captured) ||
    !Array.isArray(captured.readerRows) ||
    src.files.length === 0 ||
    src.files.length > 200 ||
    cases.cases.length === 0 ||
    cases.cases.length > 10000
  )
    refuse("FROZEN_INPUT_SCHEMA_INVALID");
  assertObjectRows(src.files, "FROZEN_INPUT_SCHEMA_INVALID");
  assertObjectRows(cases.cases, "FROZEN_INPUT_SCHEMA_INVALID");
  assertObjectRows(captured.readerRows, "FROZEN_INPUT_SCHEMA_INVALID");
  const files = new Map<string, BlindedWriterSource>();
  if (input.sourceFiles.length !== src.files.length)
    refuse("FROZEN_SOURCE_SET_MISMATCH");
  const frozenDocs = new Map<string, Record<string, unknown>>();
  for (const x of src.files) {
    if (
      !isObj(x) ||
      typeof x.documentId !== "string" ||
      typeof x.revision !== "string" ||
      !wellHex(x.fileSha256) ||
      !Number.isSafeInteger(x.bodyStartUtf16) ||
      !Number.isSafeInteger(x.bodyEndUtf16) ||
      frozenDocs.has(x.documentId)
    )
      refuse("SOURCE_MANIFEST_ENTRY_INVALID");
    frozenDocs.set(x.documentId as string, x);
  }
  for (const file of input.sourceFiles) {
    const entry = frozenDocs.get(file.documentId);
    if (!entry)
      throw new Error("S2_WRITER_REVIEW_SOURCE_BYTES_OR_IDENTITY_MISMATCH");
    if (
      files.has(file.documentId) ||
      file.bytes.byteLength > 1_000_000 ||
      SHA(file.bytes) !== entry.fileSha256
    )
      refuse("SOURCE_BYTES_OR_IDENTITY_MISMATCH");
    let sourceText = "";
    try {
      sourceText = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(file.bytes);
    } catch {
      refuse("SOURCE_UTF8_INVALID");
    }
    const start = entry.bodyStartUtf16 as number,
      end = entry.bodyEndUtf16 as number;
    if (start < 0 || end > sourceText.length || end <= start)
      refuse("SOURCE_BODY_FRAME_INVALID");
    files.set(file.documentId, {
      documentKeySha256: SHA(file.documentId),
      sourceText,
      sourceSha256: entry.fileSha256 as string,
      bodyStartUtf16: start,
      bodyEndUtf16: end,
    });
  }
  const frozenCases = new Map<string, Record<string, unknown>>();
  for (const c of cases.cases) {
    if (
      !isObj(c) ||
      !wellHex(c.caseKeySha256) ||
      !wellHex(c.scopeSha256) ||
      !wellHex(c.sourceFamilySha256) ||
      !(c.language === "en" || c.language === "es") ||
      frozenCases.has(c.caseKeySha256 as string)
    )
      refuse("CASE_MANIFEST_ENTRY_INVALID");
    frozenCases.set(c.caseKeySha256 as string, c);
  }
  if (
    input.questions.length !== frozenCases.size ||
    captured.readerRows.length !== frozenCases.size
  )
    refuse("QUESTION_OR_WRITER_RUN_SCOPE");
  const questions = new Map<string, PrivateQuestion>();
  for (const q of input.questions) {
    if (
      !wellHex(q.questionKeySha256) ||
      SHA(q.language + "\0" + q.question) !== q.questionKeySha256 ||
      !files.has(q.documentId) ||
      !frozenCases.has(q.questionKeySha256) ||
      frozenCases.get(q.questionKeySha256)!.language !== q.language ||
      questions.has(q.questionKeySha256)
    )
      refuse("QUESTION_FROZEN_IDENTITY_MISMATCH");
    questions.set(q.questionKeySha256, q);
  }
  const seed = Buffer.from(input.privateOwnerSeed).toString("hex");
  const mapping: {
    responseKeySha256: string;
    caseKeySha256: string;
    arm: string;
    originalCitationIds: string[];
  }[] = [];
  const candidates: BlindedWriterCase[] = [];
  const observed = new Set<string>();
  for (const row of captured.readerRows) {
    if (
      !isObj(row) ||
      !wellHex(row.caseKeySha256) ||
      observed.has(row.caseKeySha256 as string) ||
      !questions.has(row.caseKeySha256 as string) ||
      row.sourceSha256 !== input.pinnedSourceManifestSha256 ||
      !Array.isArray(row.outputs) ||
      row.outputs.length < 1 ||
      row.outputs.length > 2 ||
      !Number.isSafeInteger(row.verifiedSectionCount)
    )
      refuse("WRITER_ROW_NOT_PINNED");
    const caseKey = row.caseKeySha256 as string;
    observed.add(caseKey);
    const question = questions.get(caseKey)!;
    assertObjectRows(row.outputs, "WRITER_ROW_NOT_PINNED");
    const armSet = new Set<string>();
    for (const output of row.outputs) {
      if (
        !isObj(output) ||
        !(
          output.arm === "CHILD_ONLY" ||
          output.arm === "VERIFIED_SECTION_ENRICHED"
        ) ||
        armSet.has(output.arm) ||
        !(output.status === "ANSWER" || output.status === "ABSTAIN") ||
        typeof output.answer !== "string" ||
        output.answer.length > 20_000 ||
        !Array.isArray(output.citations) ||
        output.citations.length > 20 ||
        output.citations.some(
          (x: unknown) =>
            typeof x !== "string" || !/^(SRC|SECTION)[1-9][0-9]*$/u.test(x),
        ) ||
        output.providerError !== null ||
        output.citationIdsValid !== true ||
        (output.status === "ABSTAIN" &&
          (output.answer !== "" || output.citations.length > 0)) ||
        (output.status === "ANSWER" &&
          (!output.answer.trim() || output.citations.length === 0))
      )
        refuse("WRITER_RESPONSE_INVALID");
      const validOutput = output as unknown as WriterOutput;
      armSet.add(validOutput.arm);
      const responseKeySha256 = SHA(
        seed + "|" + caseKey + "|" + validOutput.arm,
      );
      mapping.push({
        responseKeySha256,
        caseKeySha256: caseKey,
        arm: validOutput.arm,
        originalCitationIds: [...validOutput.citations],
      });
      candidates.push({
        responseKeySha256,
        language: question.language,
        question: question.question,
        sourceDocumentKeySha256: SHA(question.documentId),
        writerStatus: validOutput.status,
        writerAnswer: validOutput.answer,
        reportedCitationIds: validOutput.citations.map(
          (_, i) => "CIT" + (i + 1),
        ),
        annotation: {
          sourceAnswerability: null,
          answerFaithfulness: null,
          abstention: null,
          exactOriginalQuoteSpans: [],
          note: null,
        },
      });
    }
    if (
      !armSet.has("CHILD_ONLY") ||
      armSet.has("VERIFIED_SECTION_ENRICHED") !==
        Number(row.verifiedSectionCount) > 0
    )
      refuse("SECTION_WRITER_ARM_SCOPE_INCONSISTENT");
  }
  if (
    observed.size !== frozenCases.size ||
    new Set(mapping.map((x) => x.responseKeySha256)).size !== mapping.length
  )
    refuse("WRITER_CASES_INCOMPLETE_OR_COLLIDED");
  const sources = [...files.values()];
  const make = (assignment: "X" | "Y"): BlindedWriterReviewPacket => ({
    schemaVersion: "akp.s2.writer-semantic-blind-packet.v1",
    reviewerAssignment: assignment,
    caseManifestSha256: input.pinnedCaseManifestSha256,
    sourceManifestSha256: input.pinnedSourceManifestSha256,
    writerRunSha256: SHA(input.writerRunBytes),
    instructions:
      "Review each anonymous writer output solely against original Markdown. For ANSWER, judge full, partial or incorrect factual support and cite exact UTF-16 source spans (full original-file coordinates). For ABSTAIN, judge whether the original source could answer the question. Distinguish answerability from claim polarity; do NOT infer original evidence from reported citation IDs alone. Do not inspect other reviewer output or arm allocation.",
    sourceDocuments: [...sources].sort((a, b) =>
      sortWithSalt(seed + assignment, a.documentKeySha256, b.documentKeySha256),
    ),
    cases: [...candidates].sort((a, b) =>
      sortWithSalt(seed + assignment, a.responseKeySha256, b.responseKeySha256),
    ),
    armAllocationRevealed: false,
    originalReviewerVerdictsIncluded: false,
    fullModelCitationSourceMappingAvailable: false,
    originalSourceSemanticJudgmentsOnly: true,
    reviewerIndependenceAuthenticated: false,
    gateAccepted: false,
  });
  return {
    packets: [make("X"), make("Y")],
    privateArmMap: mapping,
    expectedResponseCount: candidates.length,
    sourceCount: sources.length,
    independentSemanticReviewCompleted: false,
    gateAccepted: false,
  };
}
