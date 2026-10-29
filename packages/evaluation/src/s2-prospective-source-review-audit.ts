import { createHash } from "node:crypto";

const sha = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
const digest = /^[a-f0-9]{64}$/u;
const fail = (x: string): never => {
  throw Error("S2_PROSPECTIVE_REVIEW_" + x);
};
function assertObject(x: unknown): asserts x is Record<string, unknown> {
  if (!obj(x)) fail("OBJECT_REQUIRED");
}
const obj = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const keys = (x: Record<string, unknown>, items: readonly string[]) =>
  Object.keys(x).sort().join("|") === [...items].sort().join("|");
const boundary = (s: string, n: unknown): n is number => {
  if (
    typeof n !== "number" ||
    !Number.isSafeInteger(n) ||
    n < 0 ||
    n > s.length
  )
    return false;
  if (n === 0 || n === s.length) return true;
  const a = s.charCodeAt(n - 1),
    b = s.charCodeAt(n);
  return !(a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff);
};
const parse = (bytes: Uint8Array, maximum = 12_000_000): unknown => {
  if (bytes.length === 0 || bytes.length > maximum) fail("INPUT_SIZE");
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    fail("INVALID_JSON_OR_UTF8");
  }
};
const requirePin = (bytes: Uint8Array, pin: string) => {
  if (!digest.test(pin) || sha(bytes) !== pin) fail("PIN_MISMATCH");
};
type Quote = {
  sourceKeySha256: string;
  startUtf16: number;
  endUtf16: number;
  exactText: string;
};
type Decision = {
  reviewCaseKey: string;
  sourceAnswerability:
    "ANSWERABLE_EXPLICIT" | "NOT_ANSWERABLE" | "AMBIGUOUS" | "CONTRADICTED";
  reviewerAnswer: string | null;
  supportingQuoteSpans: Quote[];
  wholeAuthorizedCorpusAbsenceChecked: boolean;
  reviewerNotes: string | null;
};
const verdicts = [
  "ANSWERABLE_EXPLICIT",
  "NOT_ANSWERABLE",
  "AMBIGUOUS",
  "CONTRADICTED",
] as const;
const docFields = [
  "sourceKeySha256",
  "originalSha256",
  "originalText",
  "upstreamRepository",
  "revision40Hex",
  "relativePath",
  "authorizedVaultScope",
] as const;
const caseFields = [
  "reviewCaseKey",
  "language",
  "question",
  "sourceKeySha256",
  "sourceAnswerability",
  "reviewerAnswer",
  "supportingQuoteSpans",
  "wholeAuthorizedCorpusAbsenceChecked",
  "reviewerNotes",
] as const;
const packetFields = [
  "schemaVersion",
  "reviewer",
  "frozenIntakeSha256",
  "sourceDocs",
  "cases",
  "expectedGoldIncluded",
  "modelOutputsIncluded",
  "reviewerIdentityAuthenticated",
  "wholeAuthorizedCorpusAbsenceProven",
  "independentGoldAdjudicated",
  "releaseGateAccepted",
] as const;
const submissionFields = [
  "schemaVersion",
  "reviewer",
  "packetSha256",
  "cases",
] as const;
const decisionFields = [
  "reviewCaseKey",
  "sourceAnswerability",
  "reviewerAnswer",
  "supportingQuoteSpans",
  "wholeAuthorizedCorpusAbsenceChecked",
  "reviewerNotes",
] as const;
function validatePacket(raw: unknown, who: "X" | "Y") {
  assertObject(raw);
  if (
    !obj(raw) ||
    !keys(raw, packetFields) ||
    raw.schemaVersion !== "akp.s2.preinference-original-source-review.v1" ||
    raw.reviewer !== who ||
    typeof raw.frozenIntakeSha256 !== "string" ||
    !digest.test(raw.frozenIntakeSha256) ||
    raw.expectedGoldIncluded !== false ||
    raw.modelOutputsIncluded !== false ||
    raw.reviewerIdentityAuthenticated !== false ||
    raw.wholeAuthorizedCorpusAbsenceProven !== false ||
    raw.independentGoldAdjudicated !== false ||
    raw.releaseGateAccepted !== false ||
    !Array.isArray(raw.sourceDocs) ||
    !raw.sourceDocs.length ||
    raw.sourceDocs.length > 240 ||
    !Array.isArray(raw.cases) ||
    raw.cases.length !== 240
  )
    fail("PACKET_STRUCTURE");
  const sourceDocs = new Map<
    string,
    {
      sourceKeySha256: string;
      originalText: string;
      originalSha256: string;
      upstreamRepository: string;
      revision40Hex: string;
      relativePath: string;
      authorizedVaultScope: string;
    }
  >();
  for (const v of raw.sourceDocs as Record<string, unknown>[]) {
    if (
      !obj(v) ||
      !keys(v, docFields) ||
      typeof v.sourceKeySha256 !== "string" ||
      !digest.test(v.sourceKeySha256) ||
      typeof v.originalSha256 !== "string" ||
      !digest.test(v.originalSha256) ||
      typeof v.originalText !== "string" ||
      v.originalText.length < 10 ||
      v.originalText.length > 2_000_000 ||
      sha(v.originalText) !== v.originalSha256 ||
      sourceDocs.has(v.sourceKeySha256) ||
      typeof v.upstreamRepository !== "string" ||
      !v.upstreamRepository ||
      typeof v.revision40Hex !== "string" ||
      !/^[a-f0-9]{40}$/u.test(v.revision40Hex) ||
      typeof v.relativePath !== "string" ||
      !v.relativePath ||
      typeof v.authorizedVaultScope !== "string" ||
      !v.authorizedVaultScope
    )
      fail("PACKET_SOURCE_INVALID");
    sourceDocs.set(
      v.sourceKeySha256 as string,
      v as {
        sourceKeySha256: string;
        originalText: string;
        originalSha256: string;
        upstreamRepository: string;
        revision40Hex: string;
        relativePath: string;
        authorizedVaultScope: string;
      },
    );
  }
  const cases = new Map<
    string,
    {
      reviewCaseKey: string;
      language: string;
      question: string;
      sourceKeySha256: string;
    }
  >();
  for (const c of raw.cases as Record<string, unknown>[]) {
    if (
      !obj(c) ||
      !keys(c, caseFields) ||
      typeof c.reviewCaseKey !== "string" ||
      !digest.test(c.reviewCaseKey) ||
      typeof c.question !== "string" ||
      !c.question ||
      c.question.length > 4096 ||
      !["en", "es"].includes(String(c.language)) ||
      typeof c.sourceKeySha256 !== "string" ||
      !sourceDocs.has(c.sourceKeySha256) ||
      c.sourceAnswerability !== null ||
      c.reviewerAnswer !== null ||
      !Array.isArray(c.supportingQuoteSpans) ||
      c.supportingQuoteSpans.length !== 0 ||
      c.wholeAuthorizedCorpusAbsenceChecked !== null ||
      c.reviewerNotes !== null ||
      cases.has(c.reviewCaseKey)
    )
      fail("PACKET_CASE_INVALID");
    cases.set(
      c.reviewCaseKey as string,
      c as {
        reviewCaseKey: string;
        language: string;
        question: string;
        sourceKeySha256: string;
      },
    );
  }
  return { sources: sourceDocs, cases, intakePin: raw.frozenIntakeSha256 };
}
function validateSubmission(
  raw: unknown,
  who: "X" | "Y",
  packetSha: string,
  packet: ReturnType<typeof validatePacket>,
) {
  assertObject(raw);
  if (
    !obj(raw) ||
    !keys(raw, submissionFields) ||
    raw.schemaVersion !== "akp.s2.preinference-review-submission.v1" ||
    raw.reviewer !== who ||
    raw.packetSha256 !== packetSha ||
    !Array.isArray(raw.cases) ||
    raw.cases.length !== packet.cases.size
  )
    fail("SUBMISSION_STRUCTURE");
  const result = new Map<string, Decision>();
  for (const v of raw.cases as Record<string, unknown>[]) {
    if (
      !obj(v) ||
      !keys(v, decisionFields) ||
      typeof v.reviewCaseKey !== "string" ||
      !packet.cases.has(v.reviewCaseKey) ||
      result.has(v.reviewCaseKey) ||
      !verdicts.includes(v.sourceAnswerability as (typeof verdicts)[number]) ||
      !Array.isArray(v.supportingQuoteSpans) ||
      v.supportingQuoteSpans.length > 12 ||
      !(
        v.reviewerAnswer === null ||
        (typeof v.reviewerAnswer === "string" &&
          v.reviewerAnswer.length > 0 &&
          v.reviewerAnswer.length <= 4096)
      ) ||
      !(
        v.reviewerNotes === null ||
        (typeof v.reviewerNotes === "string" &&
          v.reviewerNotes.length > 0 &&
          v.reviewerNotes.length <= 4096)
      ) ||
      typeof v.wholeAuthorizedCorpusAbsenceChecked !== "boolean"
    )
      fail("SUBMISSION_CASE_INVALID");
    const c = packet.cases.get(v.reviewCaseKey as string)!;
    if (
      v.sourceAnswerability === "ANSWERABLE_EXPLICIT" &&
      (v.reviewerAnswer === null ||
        (v.supportingQuoteSpans as unknown[]).length === 0 ||
        v.wholeAuthorizedCorpusAbsenceChecked)
    )
      fail("POSITIVE_MISSING_ANSWER_OR_SOURCE");
    if (
      v.sourceAnswerability === "NOT_ANSWERABLE" &&
      (v.reviewerAnswer !== null ||
        (v.supportingQuoteSpans as unknown[]).length !== 0 ||
        !v.wholeAuthorizedCorpusAbsenceChecked)
    )
      fail("NEGATIVE_WITHOUT_WHOLE_CORPUS_ATTESTATION");
    if (
      (v.sourceAnswerability === "AMBIGUOUS" ||
        v.sourceAnswerability === "CONTRADICTED") &&
      (v.reviewerNotes === null || v.wholeAuthorizedCorpusAbsenceChecked)
    )
      fail("NONBINARY_REQUIRES_EXPLANATION");
    const spans = new Set<string>();
    for (const quote of v.supportingQuoteSpans as Record<string, unknown>[]) {
      if (
        !obj(quote) ||
        !keys(quote, [
          "sourceKeySha256",
          "startUtf16",
          "endUtf16",
          "exactText",
        ]) ||
        quote.sourceKeySha256 !== c.sourceKeySha256 ||
        typeof quote.exactText !== "string" ||
        quote.exactText.length < 1 ||
        quote.exactText.length > 8192
      )
        fail("QUOTE_SOURCE_OR_SHAPE_INVALID");
      const original = packet.sources.get(
        quote.sourceKeySha256 as string,
      )!.originalText;
      if (
        !boundary(original, quote.startUtf16) ||
        !boundary(original, quote.endUtf16) ||
        (quote.endUtf16 as number) <= (quote.startUtf16 as number) ||
        original.slice(quote.startUtf16 as number, quote.endUtf16 as number) !==
          quote.exactText
      )
        fail("QUOTE_RAW_SOURCE_SPAN_INVALID");
      const span =
        quote.sourceKeySha256 + ":" + quote.startUtf16 + ":" + quote.endUtf16;
      if (spans.has(span)) fail("QUOTE_SPAN_DUPLICATE");
      spans.add(span);
    }
    result.set(v.reviewCaseKey as string, v as Decision);
  }
  if (result.size !== packet.cases.size) fail("INCOMPLETE_REVIEWER_COVERAGE");
  return result;
}
export function auditS2ProspectiveSourceReview(input: {
  packetXBytes: Uint8Array;
  packetXSha256: string;
  packetYBytes: Uint8Array;
  packetYSha256: string;
  submissionXBytes: Uint8Array;
  submissionXSha256: string;
  submissionYBytes: Uint8Array;
  submissionYSha256: string;
}) {
  requirePin(input.packetXBytes, input.packetXSha256);
  requirePin(input.packetYBytes, input.packetYSha256);
  requirePin(input.submissionXBytes, input.submissionXSha256);
  requirePin(input.submissionYBytes, input.submissionYSha256);
  const packetX = validatePacket(parse(input.packetXBytes), "X");
  const packetY = validatePacket(parse(input.packetYBytes), "Y");
  if (
    packetX.intakePin !== packetY.intakePin ||
    packetX.cases.size !== packetY.cases.size ||
    packetX.sources.size !== packetY.sources.size
  )
    fail("REVIEW_PACKET_PAIR_MISMATCH");
  for (const [id, a] of packetX.cases) {
    const b = packetY.cases.get(id);
    if (!b || JSON.stringify(a) !== JSON.stringify(b))
      fail("REVIEW_QUESTION_OR_SOURCE_DIFFERENCE");
  }
  for (const [id, a] of packetX.sources) {
    const b = packetY.sources.get(id);
    if (!b || JSON.stringify(a) !== JSON.stringify(b))
      fail("REVIEW_SOURCE_DOCUMENT_DIFFERENCE");
  }
  const X = validateSubmission(
    parse(input.submissionXBytes),
    "X",
    input.packetXSha256,
    packetX,
  );
  const Y = validateSubmission(
    parse(input.submissionYBytes),
    "Y",
    input.packetYSha256,
    packetY,
  );
  const disagreements: string[] = [];
  let fullyAgreed = 0,
    negativeAgreed = 0,
    explicitAgreed = 0;
  for (const id of [...packetX.cases.keys()].sort()) {
    const a = X.get(id)!,
      b = Y.get(id)!;
    // Same label AND answer text/spans needed to count full SOURCE consensus.
    const eq =
      a.sourceAnswerability === b.sourceAnswerability &&
      a.reviewerAnswer === b.reviewerAnswer &&
      JSON.stringify(
        [...a.supportingQuoteSpans].sort((x, y) => x.startUtf16 - y.startUtf16),
      ) ===
        JSON.stringify(
          [...b.supportingQuoteSpans].sort(
            (x, y) => x.startUtf16 - y.startUtf16,
          ),
        );
    if (!eq) {
      disagreements.push(id);
      continue;
    }
    fullyAgreed++;
    if (a.sourceAnswerability === "NOT_ANSWERABLE") negativeAgreed++;
    if (a.sourceAnswerability === "ANSWERABLE_EXPLICIT") explicitAgreed++;
  }
  const sourceForZ = new Set(
    disagreements.map((id) => packetX.cases.get(id)!.sourceKeySha256),
  );
  const zPacket = {
    schemaVersion: "akp.s2.preinference-source-adjudication-z.v1" as const,
    frozenIntakeSha256: packetX.intakePin,
    originalPacketsSha256: { X: input.packetXSha256, Y: input.packetYSha256 },
    sourceDocs: [...sourceForZ].sort().map((id) => packetX.sources.get(id)!),
    cases: disagreements.map((id) => {
      const c = packetX.cases.get(id)!;
      return {
        ...c,
        sourceAnswerability: null,
        reviewerAnswer: null,
        supportingQuoteSpans: [],
        wholeAuthorizedCorpusAbsenceChecked: null,
        reviewerNotes: null,
      };
    }),
    reviewerXAndYAnswersIncluded: false as const,
    independentAdjudicatorVerified: false as const,
    independentTruthCertified: false as const,
    releaseGateAccepted: false as const,
  };
  return {
    schemaVersion: "akp.s2.preinference-source-review-audit.v1" as const,
    status:
      "TWO_REVIEW_SUBMISSIONS_STRUCTURALLY_VERIFIED_NOT_ADJUDICATED" as const,
    caseCount: packetX.cases.size,
    sourceCount: packetX.sources.size,
    packetHashes: { X: input.packetXSha256, Y: input.packetYSha256 },
    submissionHashes: {
      X: input.submissionXSha256,
      Y: input.submissionYSha256,
    },
    agreement: {
      fullyAgreed,
      negativeAgreed,
      explicitAgreed,
      disagreements: disagreements.length,
    },
    zPacket,
    reviewerIdentitiesAuthenticated: false as const,
    externalSourceAuthorityAuthenticated: false as const,
    completeCorpusAbsenceIndependentlyProven: false as const,
    independentSourceGoldCertified: false as const,
    releaseGateAccepted: false as const,
  };
}
