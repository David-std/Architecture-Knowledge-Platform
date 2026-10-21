import { createHash } from "node:crypto";

/**
 * Owner-custodied local study. This freezes bytes, NOT institutionally
 * independent gold. Reviewer packets deliberately omit the owner judgments.
 */
const sha = (x: Uint8Array | string) =>
  createHash("sha256").update(x).digest("hex");
const blob = (x: Uint8Array) =>
  createHash("sha1")
    .update(Buffer.from("blob " + x.length + "\0"))
    .update(x)
    .digest("hex");
const obj = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const hex = /^[a-f0-9]{64}$/u,
  sha1 = /^[a-f0-9]{40}$/u;
const fail = (x: string): never => {
  throw Error("S2_OWNER_HOLDOUT_" + x);
};
const parse = (buf: Uint8Array, reason: string): unknown => {
  if (!buf.length || buf.length > 1_000_000) fail(reason);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(buf),
    ) as unknown;
  } catch {
    fail(reason);
  }
};
const eq = (x: Record<string, unknown>, fields: string[]) =>
  Object.keys(x).sort().join(",") === fields.sort().join(",");
const safe = (v: unknown): v is string =>
  typeof v === "string" &&
  !!v &&
  !v.startsWith("/") &&
  !v.includes("\\") &&
  !v.split("/").some((c) => !c || c === "." || c === "..") &&
  !/^[a-zA-Z]:/u.test(v);
const boundary = (value: string, n: unknown): n is number => {
  if (
    typeof n !== "number" ||
    !Number.isSafeInteger(n) ||
    n < 0 ||
    n > value.length
  )
    return false;
  if (n === 0 || n === value.length) return true;
  const previous = value.charCodeAt(n - 1),
    next = value.charCodeAt(n);
  return !(
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
  );
};
export type SourceReference = {
  localRelativePath: string;
  originalBytes: Uint8Array;
};
export type OwnerHoldoutCase = {
  questionKeySha256: string;
  language: "en" | "es";
  question: string;
  sourceFamily: string;
  relativePath: string;
  proposedDisposition: "EXPLICITLY_DECIDABLE" | "NOT_SUPPORTED";
  proposedAnswer: string;
  proposedQuotes: { startUtf16: number; endUtf16: number; quote: string }[];
};
export interface OwnerHoldoutPacket {
  schemaVersion: "akp.s2.owner-holdout-reviewer-packet.v1";
  reviewerAssignment: "X" | "Y";
  candidateManifestSha256: string;
  caseManifestSha256: string;
  instructions: string;
  originals: {
    sourceKeySha256: string;
    sourceSha256: string;
    publisherFamily: string;
    relativePath: string;
    sourceText: string;
  }[];
  cases: {
    questionKeySha256: string;
    language: "en" | "es";
    question: string;
    sourceKeySha256: string;
    reviewerDisposition: null;
    reviewerAnswer: null;
    supportingQuotes: [];
  }[];
  ownerProposedGoldIncluded: false;
  writerOutputsIncluded: false;
  custodianMode: "OWNER_CONTROLLED";
  independentlyCredentialedReview: false;
  gateAccepted: false;
}
export interface PreparedOwnerHoldout {
  status: "OWNER_CUSTODIED_BLIND_PACKETS_PREPARED";
  sourceManifestSha256: string;
  caseManifestSha256: string;
  ownerProposedGoldSha256: string;
  families: number;
  originalFiles: number;
  questions: number;
  unsupportedQuestions: number;
  languages: { en: number; es: number };
  packets: [OwnerHoldoutPacket, OwnerHoldoutPacket];
  externalCustodianAuthenticated: false;
  independentReviewerAuthenticated: false;
  semanticGoldAdjudicated: false;
  gateAccepted: false;
}
export function prepareOwnerHoldout(input: {
  candidateManifestBytes: Uint8Array;
  precommittedCandidateManifestSha256: string;
  caseManifestBytes: Uint8Array;
  precommittedCaseManifestSha256: string;
  sourceFiles: readonly SourceReference[];
  privateShuffleSeed: Uint8Array;
}): PreparedOwnerHoldout {
  if (
    !hex.test(input.precommittedCandidateManifestSha256) ||
    !hex.test(input.precommittedCaseManifestSha256) ||
    input.privateShuffleSeed.length !== 32 ||
    sha(input.candidateManifestBytes) !==
      input.precommittedCandidateManifestSha256 ||
    sha(input.caseManifestBytes) !== input.precommittedCaseManifestSha256
  )
    fail("MISSING_PRECOMMITTED_MANIFEST_OR_SEED");
  const originalManifest = parse(
    input.candidateManifestBytes,
    "BAD_SOURCE_MANIFEST",
  );
  const caseManifest = parse(input.caseManifestBytes, "BAD_CASE_MANIFEST");
  if (!obj(originalManifest) || !obj(caseManifest))
    throw Error("S2_OWNER_HOLDOUT_MANIFEST_SCOPE_OR_FREEZE_INVALID");
  if (
    !obj(originalManifest) ||
    originalManifest.schemaVersion !==
      "akp.s2.external-public-source-candidates.v1" ||
    originalManifest.status !==
      "IMPLEMENTER_SELECTED_SOURCE_CANDIDATES_NOT_INDEPENDENT_HOLDOUT" ||
    originalManifest.answerLabelsCreated !== false ||
    originalManifest.independentSourceCustodianAttested !== false ||
    originalManifest.gateAccepted !== false ||
    !Array.isArray(originalManifest.developmentPublisherDenylist) ||
    !Array.isArray(originalManifest.families) ||
    originalManifest.families.length < 2 ||
    !obj(caseManifest) ||
    caseManifest.schemaVersion !== "akp.s2.owner-case-proposals.v1" ||
    caseManifest.candidateManifestSha256 !==
      input.precommittedCandidateManifestSha256 ||
    caseManifest.custodianMode !== "OWNER_CONTROLLED" ||
    caseManifest.questionsCreatedBeforeModelExecution !== true ||
    caseManifest.writerOutputsInspectedBeforeFreeze !== false ||
    !Array.isArray(caseManifest.cases) ||
    caseManifest.cases.length < 8 ||
    caseManifest.cases.length > 500
  )
    fail("MANIFEST_SCOPE_OR_FREEZE_INVALID");
  const deny = new Set(
    originalManifest.developmentPublisherDenylist as string[],
  );
  const files = new Map<
    string,
    {
      publisher: string;
      relativePath: string;
      text: string;
      fileSha256: string;
      sourceKey: string;
    }
  >();
  const allowed = new Map<string, Record<string, unknown>>();
  const publishers = new Set<string>(),
    repositories = new Set<string>();
  for (const family of originalManifest.families as Record<string, unknown>[]) {
    if (
      !obj(family) ||
      typeof family.publisherFamily !== "string" ||
      !/^[a-z0-9][a-z0-9.-]{1,70}$/u.test(family.publisherFamily) ||
      publishers.has(family.publisherFamily) ||
      deny.has(family.publisherFamily) ||
      typeof family.repository !== "string" ||
      repositories.has(family.repository) ||
      !sha1.test(String(family.commitSha)) ||
      !Array.isArray(family.files) ||
      family.files.length < 1
    )
      fail("SOURCE_FAMILY_INVALID");
    publishers.add(family.publisherFamily as string);
    repositories.add(family.repository as string);
    for (const f of family.files as Record<string, unknown>[]) {
      if (
        !obj(f) ||
        !safe(f.relativePath) ||
        !safe(f.localRelativePath) ||
        !hex.test(String(f.sourceSha256)) ||
        !sha1.test(String(f.upstreamGitBlobSha1)) ||
        f.upstreamCommitSha !== family.commitSha ||
        !Number.isSafeInteger(f.bytes) ||
        Number(f.bytes) < 1 ||
        allowed.has(f.localRelativePath)
      )
        fail("SOURCE_MANIFEST_FILE_INVALID");
      allowed.set(f.localRelativePath as string, {
        ...f,
        publisherFamily: family.publisherFamily,
      });
    }
  }
  if (input.sourceFiles.length !== allowed.size)
    fail("SOURCE_FILE_SET_NOT_COMPLETE");
  for (const file of input.sourceFiles) {
    const record = allowed.get(file.localRelativePath);
    if (
      !record ||
      files.has(file.localRelativePath) ||
      file.originalBytes.length !== record.bytes ||
      sha(file.originalBytes) !== record.sourceSha256 ||
      blob(file.originalBytes) !== record.upstreamGitBlobSha1
    )
      fail("ORIGINAL_FILE_BYTES_NOT_FROZEN");
    if (!record) throw Error("S2_OWNER_HOLDOUT_ORIGINAL_FILE_BYTES_NOT_FROZEN");
    let text = "";
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        file.originalBytes,
      );
    } catch {
      fail("ORIGINAL_FILE_INVALID_UTF8");
    }
    files.set(file.localRelativePath, {
      publisher: record.publisherFamily as string,
      relativePath: record.relativePath as string,
      text,
      fileSha256: record.sourceSha256 as string,
      sourceKey: sha(
        JSON.stringify([
          record.publisherFamily,
          record.relativePath,
          record.sourceSha256,
        ]),
      ),
    });
  }
  const questionIds = new Set<string>();
  const blindCases: OwnerHoldoutPacket["cases"] = [];
  const stratified = new Map<string, Set<string>>();
  let unsupported = 0,
    en = 0,
    es = 0;
  for (const v of caseManifest.cases as Record<string, unknown>[]) {
    if (
      !obj(v) ||
      !eq(v, [
        "questionKeySha256",
        "language",
        "question",
        "sourceFamily",
        "relativePath",
        "proposedDisposition",
        "proposedAnswer",
        "proposedQuotes",
      ]) ||
      !(v.language === "en" || v.language === "es") ||
      typeof v.question !== "string" ||
      !v.question.trim() ||
      v.question.length > 8000 ||
      !hex.test(String(v.questionKeySha256)) ||
      sha(v.language + "\0" + v.question) !== v.questionKeySha256 ||
      questionIds.has(v.questionKeySha256) ||
      typeof v.sourceFamily !== "string" ||
      !publishers.has(v.sourceFamily) ||
      typeof v.relativePath !== "string" ||
      !(
        v.proposedDisposition === "EXPLICITLY_DECIDABLE" ||
        v.proposedDisposition === "NOT_SUPPORTED"
      ) ||
      typeof v.proposedAnswer !== "string" ||
      !Array.isArray(v.proposedQuotes) ||
      v.proposedQuotes.length > 10
    )
      fail("QUESTION_NOT_FROZEN_OR_UNKNOWN");
    questionIds.add(v.questionKeySha256 as string);
    const original = [...files.values()].find(
      (x) =>
        x.publisher === v.sourceFamily && x.relativePath === v.relativePath,
    );
    if (!original)
      throw Error("S2_OWNER_HOLDOUT_QUESTION_SOURCE_NOT_IN_CANDIDATES");
    if (v.proposedDisposition === "NOT_SUPPORTED") {
      unsupported++;
      if (
        v.proposedAnswer !== "" ||
        (v.proposedQuotes as unknown[]).length !== 0
      )
        fail("UNSUPPORTED_GOLD_HAS_POSITIVE_QUOTE");
    } else {
      if (
        !(v.proposedAnswer as string).trim() ||
        (v.proposedQuotes as unknown[]).length === 0
      )
        fail("POSITIVE_PROPOSAL_LACKS_EVIDENCE");
    }
    const seenQuotes = new Set<string>();
    for (const q of v.proposedQuotes as Record<string, unknown>[]) {
      if (
        !obj(q) ||
        !eq(q, ["startUtf16", "endUtf16", "quote"]) ||
        !boundary(original.text, q.startUtf16) ||
        !boundary(original.text, q.endUtf16) ||
        Number(q.startUtf16) >= Number(q.endUtf16) ||
        typeof q.quote !== "string" ||
        !q.quote.trim() ||
        original.text.slice(q.startUtf16 as number, q.endUtf16 as number) !==
          q.quote
      )
        fail("GOLD_SOURCE_QUOTE_NOT_EXACT_UTF16");
      const key = q.startUtf16 + "|" + q.endUtf16;
      if (seenQuotes.has(key)) fail("DUPLICATE_GOLD_QUOTE");
      seenQuotes.add(key);
    }
    const stratum = v.sourceFamily + "|" + v.language;
    const current = stratified.get(stratum) ?? new Set<string>();
    current.add(v.proposedDisposition as string);
    stratified.set(stratum, current);
    if (v.language === "en") en++;
    else es++;
    blindCases.push({
      questionKeySha256: v.questionKeySha256 as string,
      language: v.language as "en" | "es",
      question: v.question as string,
      sourceKeySha256: original.sourceKey,
      reviewerDisposition: null,
      reviewerAnswer: null,
      supportingQuotes: [],
    });
  }
  if (
    unsupported === 0 ||
    unsupported === blindCases.length ||
    en === 0 ||
    es === 0 ||
    [...publishers].some((f) =>
      ["en", "es"].some(
        (l) =>
          !stratified.has(f + "|" + l) ||
          stratified.get(f + "|" + l)?.size !== 2,
      ),
    )
  )
    fail("NO_BALANCED_PUBLISHER_LANGUAGE_POLARITY_COVERAGE");
  const seed = Buffer.from(input.privateShuffleSeed).toString("hex");
  const originals = [...files.values()].map((x) => ({
    sourceKeySha256: x.sourceKey,
    sourceSha256: x.fileSha256,
    publisherFamily: x.publisher,
    relativePath: x.relativePath,
    sourceText: x.text,
  }));
  const packets = (["X", "Y"] as const).map((reviewerAssignment) => ({
    schemaVersion: "akp.s2.owner-holdout-reviewer-packet.v1" as const,
    reviewerAssignment,
    candidateManifestSha256: input.precommittedCandidateManifestSha256,
    caseManifestSha256: input.precommittedCaseManifestSha256,
    instructions:
      "Independent blind review of each question against provided frozen originals. Do not inspect owner-proposed labels or writer responses. Answer with exact original-file UTF-16 quotes for source-explicit cases; abstain when unsupported. Negatives require separate full-source consideration. Do not infer an external audit from owner custody.",
    originals: [...originals].sort((a, b) =>
      sha(seed + reviewerAssignment + a.sourceKeySha256).localeCompare(
        sha(seed + reviewerAssignment + b.sourceKeySha256),
      ),
    ),
    cases: [...blindCases].sort((a, b) =>
      sha(seed + reviewerAssignment + a.questionKeySha256).localeCompare(
        sha(seed + reviewerAssignment + b.questionKeySha256),
      ),
    ),
    ownerProposedGoldIncluded: false as const,
    writerOutputsIncluded: false as const,
    custodianMode: "OWNER_CONTROLLED" as const,
    independentlyCredentialedReview: false as const,
    gateAccepted: false as const,
  })) as [OwnerHoldoutPacket, OwnerHoldoutPacket];
  return {
    status: "OWNER_CUSTODIED_BLIND_PACKETS_PREPARED",
    sourceManifestSha256: input.precommittedCandidateManifestSha256,
    caseManifestSha256: input.precommittedCaseManifestSha256,
    ownerProposedGoldSha256: sha(input.caseManifestBytes),
    families: publishers.size,
    originalFiles: files.size,
    questions: blindCases.length,
    unsupportedQuestions: unsupported,
    languages: { en, es },
    packets,
    externalCustodianAuthenticated: false,
    independentReviewerAuthenticated: false,
    semanticGoldAdjudicated: false,
    gateAccepted: false,
  };
}
