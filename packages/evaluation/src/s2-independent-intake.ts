import { createHash } from "node:crypto";

const sha = (b: Uint8Array | string) =>
  createHash("sha256").update(b).digest("hex");
const isSha = (s: unknown): s is string =>
  typeof s === "string" && /^[a-f0-9]{64}$/u.test(s);
const isRev = (s: string) => /^[a-f0-9]{40}$/u.test(s);
const fail = (x: string): never => {
  throw Error("S2_EXTERNAL_INTAKE_" + x);
};
const HEAD = [
  "caseSeat",
  "publisherFamilySeat",
  "language",
  "targetStratum",
  "publisherName",
  "upstreamRepository",
  "sourceRevision40Hex",
  "sourceRelativePath",
  "originalSha256",
  "authorizedVaultScope",
  "sourceLocatorUtf16Start",
  "sourceLocatorUtf16End",
  "question",
  "ownerSuggestedGoldKeepPrivate",
  "externalCustodianSourceSelectionReason",
  "externalCustodianCaseAuthor",
] as const;
export type ExternalIntakeRow = Record<(typeof HEAD)[number], string>;
/** RFC 4180 quoted fields, with bounded input and no partial/extra columns. */
export function parseS2ExternalIntakeCsv(
  bytes: Uint8Array,
): ExternalIntakeRow[] {
  if (bytes.length < 1 || bytes.length > 2_000_000) fail("CSV_SIZE");
  const src = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (src.charCodeAt(0) === 0xfeff) fail("BOM_UNTRUSTED");
  const records: string[][] = [];
  let record: string[] = [],
    field = "",
    quote = false,
    closed = false;
  const pushField = () => {
    record.push(field);
    field = "";
    closed = false;
  };
  const pushRow = () => {
    if (record.length) {
      records.push(record);
      record = [];
    }
  };
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quote) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quote = false;
          closed = true;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      if (field !== "" || closed) fail("CSV_QUOTE_POSITION");
      quote = true;
    } else if (ch === ",") {
      pushField();
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      pushField();
      pushRow();
    } else {
      if (closed) fail("CSV_TRAILING_GARBAGE");
      field += ch;
    }
    if (field.length > 8192 || records.length > 242) fail("CSV_ROW_BUDGET");
  }
  if (quote) fail("CSV_UNCLOSED_QUOTE");
  if (record.length || field || closed) {
    pushField();
    pushRow();
  }
  const h = records.shift();
  if (!h || h.length !== HEAD.length || h.some((s, i) => s !== HEAD[i]))
    fail("CSV_HEADER");
  return records.map((row) => {
    if (row.length !== HEAD.length) fail("CSV_COLUMNS");
    return Object.fromEntries(
      row.map((v, i) => [HEAD[i], v]),
    ) as ExternalIntakeRow;
  });
}
const safePath = (s: string) =>
  s.length > 0 &&
  s.length <= 260 &&
  !s.startsWith("/") &&
  !s.includes("\\") &&
  !s.includes(":") &&
  s.split("/").every((p) => !!p && p !== "." && p !== ".." && p.trim() === p);
const utf16Boundary = (s: string, n: number): boolean => {
  if (!Number.isSafeInteger(n) || n < 0 || n > s.length) return false;
  if (n === 0 || n === s.length) return true;
  const a = s.charCodeAt(n - 1),
    b = s.charCodeAt(n);
  return !(a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff);
};
export type ExternalSourceFile = {
  familySeat: string;
  relativePath: string;
  rawBytes: Uint8Array;
};
export function preflightS2IndependentIntake(input: {
  templateBytes: Uint8Array;
  templateSha256: string;
  filledBytes: Uint8Array;
  filledSha256: string;
  sourceFiles: readonly ExternalSourceFile[];
  excludedDevelopmentPublisherFamilies: readonly string[];
}) {
  if (
    !isSha(input.templateSha256) ||
    sha(input.templateBytes) !== input.templateSha256 ||
    !isSha(input.filledSha256) ||
    sha(input.filledBytes) !== input.filledSha256
  )
    fail("UNPINNED_BYTES");
  const template = parseS2ExternalIntakeCsv(input.templateBytes);
  const filled = parseS2ExternalIntakeCsv(input.filledBytes);
  if (template.length !== 240 || filled.length !== 240)
    fail("REQUIRED_240_SEATS");
  const counts = new Map<string, number>(),
    familyStrata = new Map<string, number>(),
    familyMeta = new Map<string, string>(),
    seats = new Set<string>(),
    questions = new Set<string>();
  const originalBytes = new Map<string, Uint8Array>();
  for (const f of input.sourceFiles) {
    if (
      !/^F\d{2}$/u.test(f.familySeat) ||
      !safePath(f.relativePath) ||
      f.rawBytes.length < 10 ||
      f.rawBytes.length > 2_000_000
    )
      fail("SOURCE_FILE_SCOPE");
    const key = f.familySeat + "/" + f.relativePath;
    if (originalBytes.has(key)) fail("SOURCE_DUPLICATE");
    originalBytes.set(key, f.rawBytes);
  }
  if (
    !input.excludedDevelopmentPublisherFamilies.length ||
    new Set(input.excludedDevelopmentPublisherFamilies).size !==
      input.excludedDevelopmentPublisherFamilies.length
  )
    fail("DENYLIST_REQUIRED");
  const denied = new Set(input.excludedDevelopmentPublisherFamilies);
  let filledCount = 0,
    sourceCount = 0;
  const countedSources = new Set<string>();
  for (const [i, row] of filled.entries()) {
    const t = template[i]!;
    for (const fixed of [
      "caseSeat",
      "publisherFamilySeat",
      "language",
      "targetStratum",
    ] as const)
      if (row![fixed] !== t[fixed]) fail("SEAT_OR_STRATUM_CHANGED");
    if (
      !/^F(0[1-9]|1[0-2])$/u.test(row!.publisherFamilySeat) ||
      !/^(en|es)$/u.test(row!.language) ||
      !["POSITIVE", "NEGATIVE_ADVERSARIAL"].includes(row!.targetStratum) ||
      seats.has(row!.caseSeat)
    )
      fail("SEAT_IDENTITY_INVALID");
    seats.add(row!.caseSeat);
    const key = row!.language + ":" + row!.targetStratum;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const localKey = row!.publisherFamilySeat + ":" + key;
    familyStrata.set(localKey, (familyStrata.get(localKey) ?? 0) + 1);
    const fields = [
      row!.publisherName,
      row!.upstreamRepository,
      row!.sourceRevision40Hex,
      row!.sourceRelativePath,
      row!.originalSha256,
      row!.authorizedVaultScope,
      row!.sourceLocatorUtf16Start,
      row!.sourceLocatorUtf16End,
      row!.question,
      row!.externalCustodianSourceSelectionReason,
      row!.externalCustodianCaseAuthor,
    ];
    if (fields.some((x) => !x?.trim()) || row!.question.length > 4096)
      fail("UNFILLED_SOURCE_OR_QUESTION");
    filledCount++;
    if (
      !/^[a-z0-9][a-z0-9.-]{1,70}$/u.test(row!.publisherName) ||
      denied.has(row!.publisherName) ||
      !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/u.test(row!.upstreamRepository) ||
      !isRev(row!.sourceRevision40Hex) ||
      !safePath(row!.sourceRelativePath) ||
      !isSha(row!.originalSha256) ||
      row!.authorizedVaultScope.length > 256 ||
      row!.externalCustodianCaseAuthor.length > 128 ||
      row!.externalCustodianSourceSelectionReason.length > 512
    )
      fail("SOURCE_SCOPE_OR_PROVENANCE_INVALID");
    const metadata = JSON.stringify([
      row!.publisherName,
      row!.upstreamRepository,
      row!.sourceRevision40Hex,
    ]);
    const existing = familyMeta.get(row!.publisherFamilySeat);
    if (existing && existing !== metadata) fail("FAMILY_REVISION_CHANGED");
    familyMeta.set(row!.publisherFamilySeat, metadata);
    const questionKey = sha(row!.language + "\0" + row!.question.trim());
    if (questions.has(questionKey)) fail("QUESTION_DUPLICATE");
    questions.add(questionKey);
    const sourceKey = row!.publisherFamilySeat + "/" + row!.sourceRelativePath;
    const bytes = originalBytes.get(sourceKey);
    if (!bytes || sha(bytes) !== row!.originalSha256)
      fail("ORIGINAL_SOURCE_HASH_MISMATCH");
    let original: string;
    try {
      original = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return fail("SOURCE_NOT_UTF8");
    }
    const start = Number(row!.sourceLocatorUtf16Start),
      end = Number(row!.sourceLocatorUtf16End);
    if (
      !/^(0|[1-9]\d{0,7})$/u.test(row!.sourceLocatorUtf16Start) ||
      !/^(0|[1-9]\d{0,7})$/u.test(row!.sourceLocatorUtf16End) ||
      !utf16Boundary(original, start) ||
      !utf16Boundary(original, end) ||
      end <= start ||
      end - start > 8192
    )
      fail("SOURCE_UTF16_SPAN_INVALID");
    if (!countedSources.has(sourceKey)) {
      sourceCount++;
      countedSources.add(sourceKey);
    }
  }
  if (
    seats.size !== 240 ||
    familyMeta.size !== 12 ||
    [...counts.values()].some((x) => x !== 60) ||
    counts.size !== 4 ||
    new Set([...familyMeta.values()]).size !== 12 ||
    new Set([...familyMeta.values()].map((s) => JSON.parse(s)[0] as string))
      .size !== 12 ||
    familyStrata.size !== 48 ||
    [...familyStrata.values()].some((x) => x !== 5)
  )
    fail("FAMILY_OR_LANGUAGE_BALANCE");
  if (input.sourceFiles.length !== countedSources.size)
    fail("UNUSED_SOURCE_FILE");
  return {
    schemaVersion: "akp.s2.independent-intake-preflight.v1" as const,
    status: "STRUCTURALLY_COMPLETE_UNADJUDICATED_NOT_FROZEN" as const,
    intakeSha256: input.filledSha256,
    templateSha256: input.templateSha256,
    seatCount: filledCount,
    familyCount: familyMeta.size,
    sourceCount,
    counts: Object.fromEntries(
      [...counts].sort(([a], [b]) => a.localeCompare(b)),
    ),
    sourceOriginalByteHashesVerified: true as const,
    sourceUTF16SpansVerified: true as const,
    familyDisjointFromDeclaredDenylist: true as const,
    upstreamRepositoryCommitVerifiedExternally: false as const,
    sourceAccessRightsExternallyVerified: false as const,
    independentCustodianAuthenticated: false as const,
    independentReviewerGoldAdjudicated: false as const,
    modelRuns: 0 as const,
    freezeSignatureVerified: false as const,
    releaseGateAccepted: false as const,
  };
}
