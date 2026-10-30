import { createHash } from "node:crypto";

const sha = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const hex = /^[a-f0-9]{64}$/u;
const isCodePointBoundary = (s: string, n: number) =>
  n === 0 ||
  n === s.length ||
  !(
    s.charCodeAt(n - 1) >= 0xd800 &&
    s.charCodeAt(n - 1) <= 0xdbff &&
    s.charCodeAt(n) >= 0xdc00 &&
    s.charCodeAt(n) <= 0xdfff
  );

export interface S2ReaderAdmittedReviewInput {
  readonly caseId: string;
  readonly language: "en" | "es";
  readonly originalQuestion: string;
  readonly proposedAnswer: string;
  readonly sourcePassage: string;
  readonly sourcePassageSha256: string;
  readonly evidenceQuote: string;
  readonly quoteStartUtf16: number;
  readonly quoteEndUtf16: number;
}
export type S2ReaderReviewLabel =
  | "FULLY_SUPPORTED"
  | "WRONG_OR_UNSUPPORTED"
  | "PARTIALLY_SUPPORTED"
  | "UNCERTAIN";
export type S2ReaderRelationFacet =
  "ALIGNED" | "CONFLICT" | "UNKNOWN" | "NOT_APPLICABLE";
export const S2_READER_REVIEW_FACETS = [
  "subject",
  "predicate",
  "direction",
  "polarity",
  "modality",
  "temporal",
  "conditions",
  "answerRole",
] as const;

export interface S2ReaderReviewItem {
  readonly responseKeySha256: string;
  readonly language: "en" | "es";
  readonly originalQuestion: string;
  readonly proposedAnswer: string;
  readonly sourcePassage: string;
  readonly sourcePassageSha256: string;
  readonly evidenceQuote: string;
  readonly quoteStartUtf16: number;
  readonly quoteEndUtf16: number;
}
export interface S2ReaderReviewPacket {
  readonly schemaVersion: "akp.s2.reader-claim-review-packet.v1";
  readonly reviewerAssignment: "X" | "Y";
  readonly scope: "PREVIOUSLY_INSPECTED_DEVELOPER_SOURCE_SUPPLIED";
  readonly sourceProvenanceIndependentlyAuthenticated: false;
  readonly historicalUnitGoldIncluded: false;
  readonly modelAdmitVerdictsIncluded: false;
  readonly independentHumanReviewCompleted: false;
  readonly releaseGateAccepted: false;
  readonly instructions: string;
  readonly cases: readonly S2ReaderReviewItem[];
}
export interface S2ReaderReviewSubmission {
  readonly schemaVersion: "akp.s2.reader-claim-review-submission.v1";
  readonly reviewerAssignment: "X" | "Y";
  readonly packetSha256: string;
  readonly reviewerSelfAttestedIndependent: boolean;
  /** Audit hint only; not authenticated reviewer identity or separation. */
  readonly reviewerId: string;
  readonly cases: readonly {
    readonly responseKeySha256: string;
    readonly answerFaithfulness: S2ReaderReviewLabel;
    readonly facets: Record<
      (typeof S2_READER_REVIEW_FACETS)[number],
      S2ReaderRelationFacet
    >;
    readonly note: string;
  }[];
}
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
export function prepareS2ReaderClaimReview(
  rows: readonly S2ReaderAdmittedReviewInput[],
  seed: Uint8Array,
) {
  if (
    !(seed instanceof Uint8Array) ||
    seed.length !== 32 ||
    rows.length === 0 ||
    rows.length > 500
  ) {
    throw new Error("S2_READER_REVIEW_INPUT_INVALID");
  }
  const seen = new Set<string>();
  const cases: (S2ReaderReviewItem & { originalCaseId: string })[] = [];
  for (const r of rows) {
    if (
      !r ||
      !/^[\w:-]{2,100}$/u.test(r.caseId) ||
      seen.has(r.caseId) ||
      (r.language !== "en" && r.language !== "es") ||
      !r.originalQuestion?.trim() ||
      r.originalQuestion.length > 2048 ||
      !r.proposedAnswer?.trim() ||
      r.proposedAnswer.length > 2048 ||
      !r.sourcePassage?.trim() ||
      r.sourcePassage.length > 32000 ||
      !hex.test(r.sourcePassageSha256) ||
      sha(r.sourcePassage) !== r.sourcePassageSha256 ||
      !r.evidenceQuote?.trim() ||
      !Number.isSafeInteger(r.quoteStartUtf16) ||
      !Number.isSafeInteger(r.quoteEndUtf16) ||
      r.quoteStartUtf16 < 0 ||
      r.quoteEndUtf16 > r.sourcePassage.length ||
      r.quoteStartUtf16 >= r.quoteEndUtf16 ||
      !isCodePointBoundary(r.sourcePassage, r.quoteStartUtf16) ||
      !isCodePointBoundary(r.sourcePassage, r.quoteEndUtf16) ||
      r.sourcePassage.slice(r.quoteStartUtf16, r.quoteEndUtf16) !==
        r.evidenceQuote
    ) {
      throw new Error("S2_READER_REVIEW_SOURCE_OR_SPAN_INVALID");
    }
    seen.add(r.caseId);
    const responseKeySha256 = sha(
      Buffer.concat([
        Buffer.from(seed),
        Buffer.from(
          r.caseId +
            "|" +
            sha(r.originalQuestion) +
            "|" +
            r.sourcePassageSha256 +
            "|" +
            sha(r.evidenceQuote) +
            "|" +
            sha(r.proposedAnswer),
        ),
      ]),
    );
    cases.push({
      originalCaseId: r.caseId,
      responseKeySha256,
      language: r.language,
      originalQuestion: r.originalQuestion,
      proposedAnswer: r.proposedAnswer,
      sourcePassage: r.sourcePassage,
      sourcePassageSha256: r.sourcePassageSha256,
      evidenceQuote: r.evidenceQuote,
      quoteStartUtf16: r.quoteStartUtf16,
      quoteEndUtf16: r.quoteEndUtf16,
    });
  }
  const common = {
    schemaVersion: "akp.s2.reader-claim-review-packet.v1" as const,
    scope: "PREVIOUSLY_INSPECTED_DEVELOPER_SOURCE_SUPPLIED" as const,
    sourceProvenanceIndependentlyAuthenticated: false as const,
    historicalUnitGoldIncluded: false as const,
    modelAdmitVerdictsIncluded: false as const,
    independentHumanReviewCompleted: false as const,
    releaseGateAccepted: false as const,
    instructions:
      "Judge whether the proposed answer addresses the exact question and follows from the quoted source. Independently assess subject, predicate, direction, polarity, modality, temporal, conditions, answerRole. An inverse relationship, silence or unrelated negation is NOT proof of 'no'. Record uncertainty; do not infer missing context. Reviewer independence is separately authenticated outside this packet.",
  };
  const stripped = (c: (typeof cases)[number]): S2ReaderReviewItem => ({
    responseKeySha256: c.responseKeySha256,
    language: c.language,
    originalQuestion: c.originalQuestion,
    proposedAnswer: c.proposedAnswer,
    sourcePassage: c.sourcePassage,
    sourcePassageSha256: c.sourcePassageSha256,
    evidenceQuote: c.evidenceQuote,
    quoteStartUtf16: c.quoteStartUtf16,
    quoteEndUtf16: c.quoteEndUtf16,
  });
  const ordered = (label: "X" | "Y") =>
    cases
      .slice()
      .sort((a, b) =>
        sha(
          Buffer.concat([
            Buffer.from(seed),
            Buffer.from(label + "|" + a.responseKeySha256),
          ]),
        ).localeCompare(
          sha(
            Buffer.concat([
              Buffer.from(seed),
              Buffer.from(label + "|" + b.responseKeySha256),
            ]),
          ),
        ),
      )
      .map(stripped);
  const packetX: S2ReaderReviewPacket = {
    ...common,
    reviewerAssignment: "X",
    cases: ordered("X"),
  };
  const packetY: S2ReaderReviewPacket = {
    ...common,
    reviewerAssignment: "Y",
    cases: ordered("Y"),
  };
  const packetXBytes = Buffer.from(serialize(packetX));
  const packetYBytes = Buffer.from(serialize(packetY));
  const receipt = {
    schemaVersion: "akp.s2.reader-claim-review-receipt.v1" as const,
    caseCount: cases.length,
    packetXSha256: sha(packetXBytes),
    packetYSha256: sha(packetYBytes),
    historicalSourceGoldNotIndependent: true as const,
    reviewerIndependenceAuthenticated: false as const,
    semanticSupportIndependentlyEstablished: false as const,
    gateAccepted: false as const,
  };
  const skeleton = (
    label: "X" | "Y",
    packet: S2ReaderReviewPacket,
    packetHash: string,
  ): S2ReaderReviewSubmission => ({
    schemaVersion: "akp.s2.reader-claim-review-submission.v1",
    reviewerAssignment: label,
    packetSha256: packetHash,
    reviewerSelfAttestedIndependent: false,
    reviewerId: "UNASSIGNED",
    cases: packet.cases.map((c) => ({
      responseKeySha256: c.responseKeySha256,
      answerFaithfulness: "UNCERTAIN",
      facets: Object.fromEntries(
        S2_READER_REVIEW_FACETS.map((f) => [f, "UNKNOWN"]),
      ) as Record<
        (typeof S2_READER_REVIEW_FACETS)[number],
        S2ReaderRelationFacet
      >,
      note: "",
    })),
  });
  // Skeleton UNKNOWN/UNCERTAIN labels are intentionally NOT completed reviews.
  return {
    packetXBytes,
    packetYBytes,
    receiptBytes: Buffer.from(serialize(receipt)),
    submissionXBytes: Buffer.from(
      serialize(skeleton("X", packetX, receipt.packetXSha256)),
    ),
    submissionYBytes: Buffer.from(
      serialize(skeleton("Y", packetY, receipt.packetYSha256)),
    ),
    privateMap: cases.map((c) => ({
      caseId: c.originalCaseId,
      responseKeySha256: c.responseKeySha256,
    })),
    independentHumanReviewCompleted: false as const,
    releaseGateAccepted: false as const,
  };
}

const exactKeys = (input: unknown, fields: readonly string[]) =>
  typeof input === "object" &&
  input !== null &&
  !Array.isArray(input) &&
  Object.keys(input).sort().join("|") === [...fields].sort().join("|");
const receiptFields = [
  "schemaVersion",
  "caseCount",
  "packetXSha256",
  "packetYSha256",
  "historicalSourceGoldNotIndependent",
  "reviewerIndependenceAuthenticated",
  "semanticSupportIndependentlyEstablished",
  "gateAccepted",
] as const;
const packetFields = [
  "schemaVersion",
  "reviewerAssignment",
  "scope",
  "sourceProvenanceIndependentlyAuthenticated",
  "historicalUnitGoldIncluded",
  "modelAdmitVerdictsIncluded",
  "independentHumanReviewCompleted",
  "releaseGateAccepted",
  "instructions",
  "cases",
] as const;
const caseFields = [
  "responseKeySha256",
  "language",
  "originalQuestion",
  "proposedAnswer",
  "sourcePassage",
  "sourcePassageSha256",
  "evidenceQuote",
  "quoteStartUtf16",
  "quoteEndUtf16",
] as const;
export function inspectS2ReaderReviewPacketPair(
  packetXBytes: Uint8Array,
  packetYBytes: Uint8Array,
  receiptBytes: Uint8Array,
): {
  status: "PACKETS_VERIFIED_UNREVIEWED";
  caseCount: number;
  independentHumanReviewVerified: false;
  releaseGateAccepted: false;
} {
  const parse = (bytes: Uint8Array): unknown => {
    if (bytes.length === 0 || bytes.length > 12_000_000)
      throw Error("S2_READER_REVIEW_PACKET_SIZE");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  };
  const r = parse(receiptBytes) as Record<string, unknown>;
  const x = parse(packetXBytes) as S2ReaderReviewPacket;
  const y = parse(packetYBytes) as S2ReaderReviewPacket;
  if (
    !exactKeys(r, receiptFields) ||
    !exactKeys(x, packetFields) ||
    !exactKeys(y, packetFields) ||
    r.historicalSourceGoldNotIndependent !== true ||
    r.reviewerIndependenceAuthenticated !== false ||
    r.schemaVersion !== "akp.s2.reader-claim-review-receipt.v1" ||
    r.packetXSha256 !== sha(packetXBytes) ||
    r.packetYSha256 !== sha(packetYBytes) ||
    r.semanticSupportIndependentlyEstablished !== false ||
    r.gateAccepted !== false ||
    x.schemaVersion !== "akp.s2.reader-claim-review-packet.v1" ||
    y.schemaVersion !== x.schemaVersion ||
    x.reviewerAssignment !== "X" ||
    y.reviewerAssignment !== "Y" ||
    x.scope !== "PREVIOUSLY_INSPECTED_DEVELOPER_SOURCE_SUPPLIED" ||
    y.scope !== x.scope ||
    x.sourceProvenanceIndependentlyAuthenticated !== false ||
    y.sourceProvenanceIndependentlyAuthenticated !== false ||
    x.independentHumanReviewCompleted !== false ||
    y.independentHumanReviewCompleted !== false ||
    x.historicalUnitGoldIncluded !== false ||
    y.historicalUnitGoldIncluded !== false ||
    x.modelAdmitVerdictsIncluded !== false ||
    y.modelAdmitVerdictsIncluded !== false ||
    x.releaseGateAccepted !== false ||
    y.releaseGateAccepted !== false ||
    !Array.isArray(x.cases) ||
    !Array.isArray(y.cases) ||
    x.cases.length !== r.caseCount ||
    y.cases.length !== r.caseCount
  )
    throw Error("S2_READER_REVIEW_PACKET_BINDING_INVALID");
  const ids = (packet: S2ReaderReviewPacket) => {
    const result = new Set<string>();
    for (const c of packet.cases) {
      if (
        !exactKeys(c, caseFields) ||
        (c.language !== "en" && c.language !== "es") ||
        typeof c.originalQuestion !== "string" ||
        !c.originalQuestion.trim() ||
        typeof c.proposedAnswer !== "string" ||
        !c.proposedAnswer.trim() ||
        typeof c.sourcePassage !== "string" ||
        typeof c.evidenceQuote !== "string" ||
        !hex.test(c.responseKeySha256) ||
        result.has(c.responseKeySha256) ||
        sha(c.sourcePassage) !== c.sourcePassageSha256 ||
        !Number.isSafeInteger(c.quoteStartUtf16) ||
        !Number.isSafeInteger(c.quoteEndUtf16) ||
        c.quoteStartUtf16 < 0 ||
        c.quoteEndUtf16 > c.sourcePassage.length ||
        c.quoteStartUtf16 >= c.quoteEndUtf16 ||
        !isCodePointBoundary(c.sourcePassage, c.quoteStartUtf16) ||
        !isCodePointBoundary(c.sourcePassage, c.quoteEndUtf16) ||
        c.sourcePassage.slice(c.quoteStartUtf16, c.quoteEndUtf16) !==
          c.evidenceQuote
      )
        throw Error("S2_READER_REVIEW_CASE_INVALID");
      result.add(c.responseKeySha256);
    }
    return result;
  };
  const a = ids(x),
    b = ids(y);
  if (a.size !== b.size || [...a].some((k) => !b.has(k)))
    throw Error("S2_READER_REVIEW_CASE_SET_MISMATCH");
  const content = (p: S2ReaderReviewPacket) =>
    new Map(p.cases.map((c) => [c.responseKeySha256, serialize(c)]));
  const contentX = content(x),
    contentY = content(y);
  if ([...contentX].some(([k, v]) => v !== contentY.get(k)))
    throw Error("S2_READER_REVIEW_CROSS_REVIEWER_MUTATION");
  return {
    status: "PACKETS_VERIFIED_UNREVIEWED",
    caseCount: a.size,
    independentHumanReviewVerified: false,
    releaseGateAccepted: false,
  };
}

/**
 * Offline structural receipt verification only. Two distinct textual reviewer
 * IDs and two complete label sets do NOT authenticate reviewer identity,
 * independence, frozen selection or original SOURCE custody. These reports
 * must never automatically approve S2 or overwrite disputed cases.
 */
export function inspectS2ReaderClaimReviewSubmissions(input: {
  readonly packetXBytes: Uint8Array;
  readonly packetYBytes: Uint8Array;
  readonly receiptBytes: Uint8Array;
  readonly submissionXBytes: Uint8Array;
  readonly submissionYBytes: Uint8Array;
}): {
  readonly status: "TWO_COMPLETE_SUBMISSIONS_STRUCTURALLY_VERIFIED";
  readonly caseCount: number;
  readonly labelAgreements: number;
  readonly labelDisagreements: number;
  /** Count cases where any of the eight semantic dimensions differs. */
  readonly facetDisagreementCases: number;
  readonly facetDisagreementsByName: Record<
    (typeof S2_READER_REVIEW_FACETS)[number],
    number
  >;
  /** Complete agreement is still only reviewer agreement, not ground truth. */
  readonly bothSupported: number;
  readonly bothWrongOrUnsupported: number;
  readonly unresolvedCases: number;
  readonly reviewerIdentityAuthenticated: false;
  readonly independentHumanReviewVerified: false;
  readonly originalSourceCustodyAuthenticated: false;
  readonly releaseGateAccepted: false;
} {
  const preflight = inspectS2ReaderReviewPacketPair(
    input.packetXBytes,
    input.packetYBytes,
    input.receiptBytes,
  );
  const parse = (bytes: Uint8Array): unknown => {
    if (bytes.byteLength === 0 || bytes.byteLength > 12_000_000)
      throw Error("S2_READER_REVIEW_SUBMISSION_SIZE");
    try {
      return JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown;
    } catch {
      throw Error("S2_READER_REVIEW_SUBMISSION_INVALID_JSON");
    }
  };
  const pX = parse(input.packetXBytes) as S2ReaderReviewPacket;
  const pY = parse(input.packetYBytes) as S2ReaderReviewPacket;
  const labels = new Set<S2ReaderReviewLabel>([
    "FULLY_SUPPORTED",
    "WRONG_OR_UNSUPPORTED",
    "PARTIALLY_SUPPORTED",
    "UNCERTAIN",
  ]);
  const facets = new Set<S2ReaderRelationFacet>([
    "ALIGNED",
    "CONFLICT",
    "UNKNOWN",
    "NOT_APPLICABLE",
  ]);
  type Review = S2ReaderReviewSubmission["cases"][number];
  const validate = (
    assignment: "X" | "Y",
    packet: S2ReaderReviewPacket,
    bytes: Uint8Array,
    packetSha256: string,
  ): { reviewerId: string; indexed: Map<string, Review> } => {
    const raw = parse(bytes);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw Error("S2_READER_REVIEW_SUBMISSION_INVALID");
    const sub = raw as S2ReaderReviewSubmission;
    if (
      !exactKeys(sub, [
        "schemaVersion",
        "reviewerAssignment",
        "packetSha256",
        "reviewerSelfAttestedIndependent",
        "reviewerId",
        "cases",
      ]) ||
      sub.schemaVersion !== "akp.s2.reader-claim-review-submission.v1" ||
      sub.reviewerAssignment !== assignment ||
      sub.packetSha256 !== packetSha256 ||
      sub.reviewerSelfAttestedIndependent !== true ||
      !/^[a-zA-Z0-9_.:@-]{6,100}$/u.test(sub.reviewerId ?? "") ||
      sub.reviewerId === "UNASSIGNED" ||
      !Array.isArray(sub.cases) ||
      sub.cases.length !== packet.cases.length
    )
      throw Error("S2_READER_REVIEW_SUBMISSION_METADATA_INVALID");
    const indexed = new Map<string, Review>();
    const authorized = new Set(packet.cases.map((c) => c.responseKeySha256));
    for (const item of sub.cases) {
      if (
        !item ||
        !exactKeys(item, [
          "responseKeySha256",
          "answerFaithfulness",
          "facets",
          "note",
        ]) ||
        !authorized.has(item.responseKeySha256) ||
        indexed.has(item.responseKeySha256) ||
        !labels.has(item.answerFaithfulness) ||
        !item.facets ||
        typeof item.facets !== "object" ||
        Array.isArray(item.facets) ||
        Object.keys(item.facets).length !== S2_READER_REVIEW_FACETS.length ||
        S2_READER_REVIEW_FACETS.some((f) => !facets.has(item.facets[f])) ||
        typeof item.note !== "string" ||
        item.note.length > 2000 ||
        (item.answerFaithfulness === "UNCERTAIN" && !item.note.trim()) ||
        // A reviewer cannot claim FULL support while simultaneously recording
        // an unknown or conflicting subject/relation/condition/answer role.
        // NOT_APPLICABLE remains valid for genuinely irrelevant dimensions.
        (item.answerFaithfulness === "FULLY_SUPPORTED" &&
          S2_READER_REVIEW_FACETS.some(
            (f) =>
              item.facets[f] === "CONFLICT" || item.facets[f] === "UNKNOWN",
          ))
      ) {
        throw Error("S2_READER_REVIEW_SUBMISSION_CASE_INVALID");
      }
      indexed.set(item.responseKeySha256, item);
    }
    return { reviewerId: sub.reviewerId, indexed };
  };
  const x = validate("X", pX, input.submissionXBytes, sha(input.packetXBytes));
  const y = validate("Y", pY, input.submissionYBytes, sha(input.packetYBytes));
  if (x.reviewerId === y.reviewerId)
    throw Error("S2_READER_REVIEW_REVIEWERS_NOT_DISTINCT");
  let labelAgreements = 0,
    facetDisagreementCases = 0,
    bothSupported = 0,
    bothWrongOrUnsupported = 0,
    unresolvedCases = 0;
  const facetDisagreementsByName = Object.fromEntries(
    S2_READER_REVIEW_FACETS.map((facet) => [facet, 0]),
  ) as Record<(typeof S2_READER_REVIEW_FACETS)[number], number>;
  for (const key of x.indexed.keys()) {
    const a = x.indexed.get(key)!,
      b = y.indexed.get(key);
    if (!b) throw Error("S2_READER_REVIEW_SUBMISSION_PAIR_MISSING");
    const same = a.answerFaithfulness === b.answerFaithfulness;
    if (same) labelAgreements++;
    let facetsAgree = true;
    for (const facet of S2_READER_REVIEW_FACETS) {
      if (a.facets[facet] !== b.facets[facet]) {
        facetDisagreementsByName[facet]++;
        facetsAgree = false;
      }
    }
    if (!facetsAgree) facetDisagreementCases++;
    // A shared overall label must not conceal a disagreement about the
    // subject, direction, polarity, exception or requested answer role.
    if (same && facetsAgree && a.answerFaithfulness === "FULLY_SUPPORTED")
      bothSupported++;
    if (same && facetsAgree && a.answerFaithfulness === "WRONG_OR_UNSUPPORTED")
      bothWrongOrUnsupported++;
    if (
      !same ||
      !facetsAgree ||
      a.answerFaithfulness === "UNCERTAIN" ||
      a.answerFaithfulness === "PARTIALLY_SUPPORTED"
    )
      unresolvedCases++;
  }
  return {
    status: "TWO_COMPLETE_SUBMISSIONS_STRUCTURALLY_VERIFIED",
    caseCount: preflight.caseCount,
    labelAgreements,
    labelDisagreements: preflight.caseCount - labelAgreements,
    facetDisagreementCases,
    facetDisagreementsByName,
    bothSupported,
    bothWrongOrUnsupported,
    unresolvedCases,
    reviewerIdentityAuthenticated: false,
    independentHumanReviewVerified: false,
    originalSourceCustodyAuthenticated: false,
    releaseGateAccepted: false,
  };
}
