import { createHash } from "node:crypto";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const object = (x: unknown): x is Record<string, unknown> =>
  x !== null && typeof x === "object" && !Array.isArray(x);
const exact = (v: Record<string, unknown>, fields: string[]) =>
  Object.keys(v).sort().join(",") === fields.sort().join(",");
const hex = (x: unknown): x is string =>
  typeof x === "string" && /^[a-f0-9]{64}$/u.test(x);
const fail = (code: string): never => {
  throw Error("S2_OWNER_AUDIT_" + code);
};
const parse = (b: Uint8Array, code: string): unknown => {
  if (!b.length || b.length > 5_000_000) fail(code);
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(b),
    ) as unknown;
  } catch {
    fail(code);
  }
};
function boundary(s: string, n: unknown): n is number {
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
}
const allowed = new Set([
  "ANSWERABLE_EXPLICIT",
  "CONTRADICTED",
  "NOT_ANSWERABLE",
  "AMBIGUOUS",
]);
type PacketCase = {
  questionKeySha256: string;
  sourceKeySha256: string;
  question: string;
  language: string;
  reviewerDisposition: null;
  reviewerAnswer: null;
  supportingQuotes: [];
};
export interface OwnerReviewAudit {
  schemaVersion: "akp.s2.owner-review-audit.v1";
  status:
    | "OWNER_PACKETS_VERIFIED_UNREVIEWED"
    | "OWNER_TWO_SUBMISSIONS_STRUCTURALLY_VERIFIED";
  totalQuestions: number;
  totalOriginalDocuments: number;
  submittedReviewers: 0 | 2;
  literalOriginalQuoteSpans: number | null;
  exactLabelAgreement: number | null;
  labelDisagreements: number | null;
  custodianMode: "OWNER_CONTROLLED";
  independentlyAuthenticatedReviewers: false;
  externallyAccreditedCustodian: false;
  negativeAbsenceIndependentlyEstablished: false;
  claimToInferencePassageBindingEstablished: false;
  semanticCorrectnessAdjudicated: false;
  gateAccepted: false;
}
export function auditOwnerReviewPackets(input: {
  receiptBytes: Uint8Array;
  packetXBytes: Uint8Array;
  packetYBytes: Uint8Array;
  reviewerX?: unknown;
  reviewerY?: unknown;
}): OwnerReviewAudit {
  const receipt = parse(input.receiptBytes, "RECEIPT_INVALID");
  if (!object(receipt)) throw Error("S2_OWNER_AUDIT_RECEIPT_SCHEMA_INVALID");
  if (
    !object(receipt) ||
    !exact(receipt, [
      "schemaVersion",
      "sourceManifestSha256",
      "caseManifestSha256",
      "packets",
      "ownerControlled",
      "externalIndependenceCertified",
      "evaluationsReceived",
      "gateAccepted",
    ]) ||
    receipt.schemaVersion !== "akp.s2.owner-review-packets-receipt.v1" ||
    !hex(receipt.sourceManifestSha256) ||
    !hex(receipt.caseManifestSha256) ||
    receipt.ownerControlled !== true ||
    receipt.externalIndependenceCertified !== false ||
    receipt.evaluationsReceived !== 0 ||
    receipt.gateAccepted !== false ||
    !Array.isArray(receipt.packets) ||
    receipt.packets.length !== 2
  )
    fail("RECEIPT_SCHEMA_INVALID");
  const cases = new Map<string, PacketCase>();
  const originals = new Map<string, string>();
  const packets: [unknown, unknown] = [
    parse(input.packetXBytes, "PACKET_X_INVALID"),
    parse(input.packetYBytes, "PACKET_Y_INVALID"),
  ];
  const receiptRows = receipt.packets as Record<string, unknown>[];
  for (const [i, name, bytes] of [
    [0, "X", input.packetXBytes],
    [1, "Y", input.packetYBytes],
  ] as const) {
    const proof = receiptRows[i];
    if (!proof) throw Error("S2_OWNER_AUDIT_PACKET_RECEIPT_HASH_MISMATCH");
    if (
      !object(proof) ||
      !exact(proof, [
        "assignment",
        "packetFile",
        "packetSha256",
        "caseCount",
      ]) ||
      proof.assignment !== name ||
      proof.packetSha256 !== sha(bytes)
    )
      fail("PACKET_RECEIPT_HASH_MISMATCH");
    const packet = packets[i];
    if (!object(packet)) throw Error("S2_OWNER_AUDIT_PACKET_SCHEMA_INVALID");
    if (
      !object(packet) ||
      packet.schemaVersion !== "akp.s2.owner-holdout-reviewer-packet.v1" ||
      packet.reviewerAssignment !== name ||
      packet.custodianMode !== "OWNER_CONTROLLED" ||
      packet.candidateManifestSha256 !== receipt.sourceManifestSha256 ||
      packet.caseManifestSha256 !== receipt.caseManifestSha256 ||
      packet.ownerProposedGoldIncluded !== false ||
      packet.writerOutputsIncluded !== false ||
      packet.independentlyCredentialedReview !== false ||
      packet.gateAccepted !== false ||
      !Array.isArray(packet.originals) ||
      !Array.isArray(packet.cases) ||
      packet.cases.length !== proof.caseCount ||
      packet.cases.length < 8
    )
      fail("PACKET_SCHEMA_INVALID");
    const perSource = new Set<string>();
    for (const src of packet.originals as Record<string, unknown>[]) {
      if (
        !object(src) ||
        !hex(src.sourceKeySha256) ||
        typeof src.sourceText !== "string" ||
        !hex(src.sourceSha256) ||
        perSource.has(src.sourceKeySha256)
      )
        fail("SOURCE_IDENTITY_INVALID");
      perSource.add(src.sourceKeySha256 as string);
      const old = originals.get(src.sourceKeySha256 as string);
      if (old !== undefined && old !== src.sourceText)
        fail("ORIGINAL_CHANGED_CROSS_PACKET");
      originals.set(src.sourceKeySha256 as string, src.sourceText as string);
    }
    const seen = new Set<string>();
    for (const c of packet.cases as Record<string, unknown>[]) {
      if (
        !object(c) ||
        !hex(c.questionKeySha256) ||
        seen.has(c.questionKeySha256) ||
        !hex(c.sourceKeySha256) ||
        !perSource.has(c.sourceKeySha256) ||
        !["en", "es"].includes(String(c.language)) ||
        typeof c.question !== "string" ||
        sha(Buffer.from(c.language + "\0" + c.question)) !==
          c.questionKeySha256 ||
        c.reviewerDisposition !== null ||
        c.reviewerAnswer !== null ||
        !Array.isArray(c.supportingQuotes) ||
        c.supportingQuotes.length !== 0
      )
        fail("CASE_IDENTITY_OR_BLINDING_INVALID");
      seen.add(c.questionKeySha256 as string);
      const record = {
        questionKeySha256: c.questionKeySha256 as string,
        sourceKeySha256: c.sourceKeySha256 as string,
        question: c.question as string,
        language: c.language as string,
        reviewerDisposition: null,
        reviewerAnswer: null,
        supportingQuotes: [],
      } as PacketCase;
      const old = cases.get(record.questionKeySha256);
      if (old && JSON.stringify(old) !== JSON.stringify(record))
        fail("CASE_CHANGED_CROSS_PACKET");
      cases.set(record.questionKeySha256, record);
    }
    if (seen.size !== (packet.cases as unknown[]).length)
      fail("PACKET_CASE_COUNT_MISMATCH");
  }
  const pktX = packets[0] as {
    cases: PacketCase[];
    originals: { sourceKeySha256: string }[];
  };
  const pktY = packets[1] as {
    cases: PacketCase[];
    originals: { sourceKeySha256: string }[];
  };
  if (
    pktX.cases.length !== pktY.cases.length ||
    cases.size !== pktX.cases.length ||
    pktX.originals.length !== pktY.originals.length ||
    originals.size !== pktX.originals.length
  )
    fail("PACKETS_NOT_EQUIVALENT");
  const base = {
    schemaVersion: "akp.s2.owner-review-audit.v1" as const,
    totalQuestions: cases.size,
    totalOriginalDocuments: originals.size,
    custodianMode: "OWNER_CONTROLLED" as const,
    independentlyAuthenticatedReviewers: false as const,
    externallyAccreditedCustodian: false as const,
    negativeAbsenceIndependentlyEstablished: false as const,
    claimToInferencePassageBindingEstablished: false as const,
    semanticCorrectnessAdjudicated: false as const,
    gateAccepted: false as const,
  };
  if ((input.reviewerX === undefined) !== (input.reviewerY === undefined))
    fail("INCOMPLETE_REVIEWERS");
  if (input.reviewerX === undefined)
    return {
      ...base,
      status: "OWNER_PACKETS_VERIFIED_UNREVIEWED",
      submittedReviewers: 0,
      literalOriginalQuoteSpans: null,
      exactLabelAgreement: null,
      labelDisagreements: null,
    };
  const labels = new Map<"X" | "Y", Map<string, string>>();
  let literal = 0;
  for (const [assignment, submission, pBytes] of [
    ["X", input.reviewerX, input.packetXBytes],
    ["Y", input.reviewerY, input.packetYBytes],
  ] as const) {
    if (
      !object(submission) ||
      !exact(submission, [
        "schemaVersion",
        "reviewerAssignment",
        "packetSha256",
        "cases",
        "reviewerIndependenceSelfReported",
        "externallyCredentialed",
      ]) ||
      submission.schemaVersion !== "akp.s2.owner-reviewer-submission.v1" ||
      submission.reviewerAssignment !== assignment ||
      submission.packetSha256 !== sha(pBytes) ||
      typeof submission.reviewerIndependenceSelfReported !== "boolean" ||
      submission.externallyCredentialed !== false ||
      !Array.isArray(submission.cases) ||
      submission.cases.length !== cases.size
    )
      fail("SUBMISSION_HEADER_INVALID");
    if (!object(submission))
      throw Error("S2_OWNER_AUDIT_SUBMISSION_HEADER_INVALID");
    const map = new Map<string, string>();
    for (const row of submission.cases as Record<string, unknown>[]) {
      if (
        !object(row) ||
        !exact(row, [
          "questionKeySha256",
          "answerability",
          "answerText",
          "exactSourceQuotes",
          "note",
        ]) ||
        !hex(row.questionKeySha256) ||
        map.has(row.questionKeySha256) ||
        !cases.has(row.questionKeySha256) ||
        !allowed.has(String(row.answerability)) ||
        typeof row.answerText !== "string" ||
        !(row.note === null || typeof row.note === "string") ||
        !Array.isArray(row.exactSourceQuotes) ||
        row.exactSourceQuotes.length > 20
      )
        fail("SUBMISSION_CASE_INVALID");
      const c = cases.get(row.questionKeySha256 as string)!;
      const source = originals.get(c.sourceKeySha256)!;
      const seen = new Set<string>();
      for (const q of row.exactSourceQuotes as Record<string, unknown>[]) {
        if (
          !object(q) ||
          !exact(q, ["sourceKeySha256", "startUtf16", "endUtf16", "quote"]) ||
          q.sourceKeySha256 !== c.sourceKeySha256 ||
          typeof q.quote !== "string" ||
          !q.quote.trim() ||
          !boundary(source, q.startUtf16) ||
          !boundary(source, q.endUtf16) ||
          Number(q.endUtf16) <= Number(q.startUtf16) ||
          source.slice(q.startUtf16 as number, q.endUtf16 as number) !== q.quote
        )
          fail("QUOTE_NOT_LITERAL_FROZEN_ORIGINAL_UTF16");
        const id = q.startUtf16 + ":" + q.endUtf16;
        if (seen.has(id)) fail("DUPLICATE_QUOTE");
        seen.add(id);
        literal++;
      }
      if (
        row.answerability === "ANSWERABLE_EXPLICIT" ||
        row.answerability === "CONTRADICTED"
      ) {
        if (!(row.answerText as string).trim() || seen.size === 0)
          fail("EXPLICIT_ANSWER_NEEDS_EVIDENCE");
      } else if (row.answerability === "NOT_ANSWERABLE") {
        if (row.answerText !== "" || seen.size !== 0)
          fail("UNSUPPORTED_ANSWER_MUST_ABSTAIN");
      }
      map.set(row.questionKeySha256 as string, row.answerability as string);
    }
    if (map.size !== cases.size) fail("SUBMISSION_SCOPE_MISMATCH");
    labels.set(assignment, map);
  }
  let agreement = 0;
  for (const id of cases.keys())
    if (labels.get("X")!.get(id) === labels.get("Y")!.get(id)) agreement++;
  return {
    ...base,
    status: "OWNER_TWO_SUBMISSIONS_STRUCTURALLY_VERIFIED",
    submittedReviewers: 2,
    literalOriginalQuoteSpans: literal,
    exactLabelAgreement: agreement,
    labelDisagreements: cases.size - agreement,
  };
}
