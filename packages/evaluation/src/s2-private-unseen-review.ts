import { createHash } from "node:crypto";
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const hex = /^[a-f0-9]{64}$/u;
const fail = (reason: string): never => {
  throw Error("S2_PRIVATE_REVIEW_" + reason);
};
const object = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const string = (s: unknown, n: number): s is string =>
  typeof s === "string" && s.length > 0 && s.length <= n;
const boundary = (s: string, i: number): boolean => {
  if (!Number.isSafeInteger(i) || i < 0 || i > s.length) return false;
  if (i === 0 || i === s.length) return true;
  const a = s.charCodeAt(i - 1),
    b = s.charCodeAt(i);
  return !(a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff);
};
type QuestionCase = {
  questionKeySha256: string;
  language: "en" | "es";
  question: string;
  sourceKeys: string[];
  answerability: null;
  answer: null;
  quoteSpans: [];
  reviewerNote: null;
};
export type S2PrivateSourceReviewPacket = {
  schemaVersion: "akp.s2.private-unseen-source-review.v1";
  assignment: "X" | "Y";
  sourceDocs: { sourceKeySha256: string; originalText: string }[];
  cases: QuestionCase[];
  writerOutputsIncluded: false;
  blindedToModel: true;
  independentlyAuthenticatedReviewers: false;
  completeAuthorizedVaultAbsenceProven: false;
  releaseGateAccepted: false;
};
export function buildS2PrivateUnseenReviewKit(input: {
  samples: readonly unknown[];
  shuffleSalt: string;
}) {
  if (
    !Array.isArray(input.samples) ||
    input.samples.length < 1 ||
    input.samples.length > 320 ||
    !hex.test(input.shuffleSalt)
  )
    fail("INPUT_OR_SALT_INVALID");
  const sources = new Map<string, string>();
  const cases: QuestionCase[] = [];
  const privateAnswers: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const rawValue of input.samples) {
    if (!object(rawValue)) fail("SAMPLE_IDENTITY_INVALID");
    const value = rawValue as Record<string, unknown>;
    if (
      !object(value) ||
      value.schemaVersion !== "akp.s2.private-shadow-review-sample.v1" ||
      !["en", "es"].includes(String(value.language)) ||
      !string(value.question, 4096) ||
      !hex.test(String(value.caseSha256)) ||
      value.caseSha256 !==
        sha((value.language as string) + "\0" + (value.question as string)) ||
      !hex.test(String(value.packetSha256)) ||
      seen.has(String(value.caseSha256)) ||
      !Array.isArray(value.passages) ||
      value.passages.length < 1 ||
      value.passages.length > 4 ||
      !object(value.writer) ||
      !object(value.review)
    )
      fail("SAMPLE_IDENTITY_INVALID");
    const w = value.writer as Record<string, unknown>;
    const review = value.review as Record<string, unknown>;
    if (
      review.semanticGoldVerified !== false ||
      review.releaseGateAccepted !== false ||
      review.sourceAnswerability !== null ||
      review.claimFaithfulness !== null ||
      review.abstentionJustified !== null ||
      review.independentReviewerIdentityVerified !== false ||
      !string(w.requestSha256, 64) ||
      !hex.test(w.requestSha256) ||
      !string(w.responseSha256, 64) ||
      !hex.test(w.responseSha256) ||
      !string(w.modelDigestSha256, 64) ||
      !hex.test(w.modelDigestSha256) ||
      typeof w.abstained !== "boolean" ||
      typeof w.answerText !== "string" ||
      !Array.isArray(w.statements) ||
      (w.statements as unknown[]).length > 16
    )
      fail("UNREVIEWED_MODEL_PROVENANCE_INVALID");
    const keys: string[] = [];
    const ids = new Set<string>();
    for (const rawPart of value.passages as unknown[]) {
      if (!object(rawPart)) fail("RAW_SOURCE_OR_SPAN_CHANGED");
      const p = rawPart as Record<string, unknown>;
      if (
        !object(p) ||
        !string(p.citationId, 16) ||
        !/^SECTION[1-4]$/u.test(p.citationId) ||
        ids.has(p.citationId) ||
        !string(p.originalSourceText, 2_000_000) ||
        !string(p.sourceText, 8192) ||
        !hex.test(String(p.originalSourceSha256)) ||
        sha(p.originalSourceText as string) !== p.originalSourceSha256 ||
        !boundary(p.originalSourceText as string, p.startUtf16 as number) ||
        !boundary(p.originalSourceText as string, p.endUtf16 as number) ||
        !(Number(p.endUtf16) > Number(p.startUtf16)) ||
        (p.originalSourceText as string).slice(
          p.startUtf16 as number,
          p.endUtf16 as number,
        ) !== p.sourceText
      )
        fail("RAW_SOURCE_OR_SPAN_CHANGED");
      ids.add(p.citationId as string);
      const key = String(p.originalSourceSha256);
      if (sources.has(key) && sources.get(key) !== p.originalSourceText)
        fail("SOURCE_HASH_COLLISION");
      sources.set(key, p.originalSourceText as string);
      keys.push(key);
    }
    let complete = "";
    for (const rawStatement of w.statements as unknown[]) {
      if (!object(rawStatement)) fail("CLAIM_CUSTODY_INVALID");
      const statement = rawStatement as Record<string, unknown>;
      if (
        !object(statement) ||
        !string(statement.text, 4096) ||
        !ids.has(String(statement.citationId))
      )
        fail("CLAIM_CUSTODY_INVALID");
      complete += statement.text as string;
    }
    if (w.abstained) {
      if (w.answerText !== "" || (w.statements as unknown[]).length !== 0)
        fail("ABSTENTION_WITH_CLAIMS");
    } else if (!string(w.answerText, 4096) || complete !== w.answerText)
      fail("PARTIAL_OR_UNBOUND_WRITER_ANSWER");
    const key = value.caseSha256 as string;
    seen.add(key);
    cases.push({
      questionKeySha256: key,
      language: value.language as "en" | "es",
      question: value.question as string,
      sourceKeys: keys,
      answerability: null,
      answer: null,
      quoteSpans: [],
      reviewerNote: null,
    });
    privateAnswers.push({
      questionKeySha256: key,
      writerAnswer: w.answerText,
      abstained: w.abstained,
      statements: w.statements,
      requestSha256: w.requestSha256,
      responseSha256: w.responseSha256,
      modelDigestSha256: w.modelDigestSha256,
      semanticGoldVerified: false,
      releaseGateAccepted: false,
    });
  }
  if (sources.size > 320) fail("SOURCE_BUDGET");
  const documents = [...sources]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([sourceKeySha256, originalText]) => ({
      sourceKeySha256,
      originalText,
    }));
  const order = (assignment: "X" | "Y") =>
    [...cases].sort((a, b) =>
      sha(input.shuffleSalt + assignment + a.questionKeySha256).localeCompare(
        sha(input.shuffleSalt + assignment + b.questionKeySha256),
      ),
    );
  const make = (assignment: "X" | "Y"): S2PrivateSourceReviewPacket => ({
    schemaVersion: "akp.s2.private-unseen-source-review.v1",
    assignment,
    sourceDocs: documents,
    cases: order(assignment),
    writerOutputsIncluded: false,
    blindedToModel: true,
    independentlyAuthenticatedReviewers: false,
    completeAuthorizedVaultAbsenceProven: false,
    releaseGateAccepted: false,
  });
  return {
    packets: [make("X"), make("Y")] as const,
    privateWriterAnswers: privateAnswers,
    receipt: {
      schemaVersion: "akp.s2.private-unseen-review-receipt.v1",
      questionCount: cases.length,
      sourceCount: documents.length,
      sourceManifestSha256: sha(JSON.stringify(documents)),
      caseManifestSha256: sha(
        JSON.stringify(
          [...cases].sort((a, b) =>
            a.questionKeySha256.localeCompare(b.questionKeySha256),
          ),
        ),
      ),
      independentReviewReceived: false,
      completeAuthorizedVaultAbsenceProven: false,
      releaseGateAccepted: false,
    },
  };
}
