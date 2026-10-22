import { createHash } from "node:crypto";
const sha = (x: Uint8Array) => createHash("sha256").update(x).digest("hex");
const hex = /^[0-9a-f]{64}$/u;
const boundary = (s: string, n: number): boolean =>
  Number.isSafeInteger(n) &&
  n >= 0 &&
  n <= s.length &&
  !(
    n > 0 &&
    n < s.length &&
    s.charCodeAt(n - 1) >= 0xd800 &&
    s.charCodeAt(n - 1) <= 0xdbff &&
    s.charCodeAt(n) >= 0xdc00 &&
    s.charCodeAt(n) <= 0xdfff
  );
export interface S2ExactQuoteOriginal {
  readonly assignedSourceId: string;
  readonly sourceSha256: string;
  readonly exactUtf8Bytes: Uint8Array;
  readonly bodyStartUtf16: number;
  readonly bodyEndUtf16: number;
}
export interface S2ExactQuoteModelOutput {
  readonly answerText: string;
  readonly evidenceQuote: string;
  readonly sourceId: string;
  readonly abstained: boolean;
}
export interface S2ExactQuoteAttribution {
  readonly status:
    "VERBATIM_UNIQUE_SOURCE_BOUND" | "VALID_ABSTAIN" | "REJECTED";
  readonly reason: string;
  readonly assignedSourceId: string | null;
  readonly modelSourceId: string | null;
  readonly sourceSha256: string | null;
  readonly startUtf16: number | null;
  readonly endUtf16: number | null;
  readonly modelSourceIdConfirmed: boolean;
  readonly modelSourceIdRepairedByLiteralProof: boolean;
  readonly semanticEntailmentVerified: false;
  readonly releaseGateAccepted: false;
}
/**
 * Development-only attribution. The model's source ID is untrusted.
 * Resolve ONE exact quote in ONE SHA-verified authorized original source.
 * NEVER rewrite, fuzzy-match, trim, case-fold, or invent the quote. Even a
 * valid offset does NOT establish that the quote entails the answer.
 */
export function attributeS2VerbatimQuote(
  output: S2ExactQuoteModelOutput,
  originals: readonly S2ExactQuoteOriginal[],
): S2ExactQuoteAttribution {
  const reject = (reason: string): S2ExactQuoteAttribution => ({
    status: "REJECTED",
    reason,
    assignedSourceId: null,
    modelSourceId: typeof output.sourceId === "string" ? output.sourceId : null,
    sourceSha256: null,
    startUtf16: null,
    endUtf16: null,
    modelSourceIdConfirmed: false,
    modelSourceIdRepairedByLiteralProof: false,
    semanticEntailmentVerified: false,
    releaseGateAccepted: false,
  });
  if (
    typeof output.abstained !== "boolean" ||
    typeof output.answerText !== "string" ||
    typeof output.evidenceQuote !== "string" ||
    typeof output.sourceId !== "string"
  )
    return reject("MODEL_FIELDS_NOT_STRING_OR_BOOLEAN");
  if (originals.length === 0 || originals.length > 16)
    return reject("AUTHORITATIVE_ORIGINALS_MISSING_OR_UNBOUNDED");
  const seen = new Set<string>(),
    decoded = [];
  for (const entry of originals) {
    if (
      !entry.assignedSourceId.trim() ||
      seen.has(entry.assignedSourceId) ||
      !hex.test(entry.sourceSha256) ||
      entry.exactUtf8Bytes.length === 0 ||
      entry.exactUtf8Bytes.length > 2_000_000 ||
      sha(entry.exactUtf8Bytes) !== entry.sourceSha256
    )
      return reject("AUTHORITATIVE_SOURCE_PROVENANCE_INVALID");
    seen.add(entry.assignedSourceId);
    let content: string;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(entry.exactUtf8Bytes);
    } catch {
      return reject("AUTHORITATIVE_SOURCE_UTF8_INVALID");
    }
    if (
      !boundary(content, entry.bodyStartUtf16) ||
      !boundary(content, entry.bodyEndUtf16) ||
      entry.bodyStartUtf16 >= entry.bodyEndUtf16
    )
      return reject("AUTHORITATIVE_BODY_UTF16_FRAME_INVALID");
    decoded.push({ ...entry, content });
  }
  if (output.abstained) {
    return output.answerText === "" &&
      output.evidenceQuote === "" &&
      output.sourceId === ""
      ? {
          status: "VALID_ABSTAIN",
          reason: "EMPTY_AND_CONSISTENT",
          assignedSourceId: null,
          modelSourceId: null,
          sourceSha256: null,
          startUtf16: null,
          endUtf16: null,
          modelSourceIdConfirmed: false,
          modelSourceIdRepairedByLiteralProof: false,
          semanticEntailmentVerified: false,
          releaseGateAccepted: false,
        }
      : reject("ABSTENTION_WITH_NONEMPTY_FIELDS");
  }
  if (
    !output.answerText.trim() ||
    output.evidenceQuote.length < 12 ||
    output.evidenceQuote.length > 12000 ||
    output.evidenceQuote.trim() !== output.evidenceQuote
  )
    return reject("NONEMPTY_CLAIM_REQUIRES_EXACT_UNALTERED_QUOTE");
  const matches = [];
  for (const entry of decoded) {
    const body = entry.content.slice(entry.bodyStartUtf16, entry.bodyEndUtf16);
    let local = body.indexOf(output.evidenceQuote);
    while (local >= 0) {
      const startUtf16 = entry.bodyStartUtf16 + local;
      const endUtf16 = startUtf16 + output.evidenceQuote.length;
      if (
        boundary(entry.content, startUtf16) &&
        boundary(entry.content, endUtf16)
      )
        matches.push({ entry, startUtf16, endUtf16 });
      if (matches.length > 1)
        return reject("QUOTE_NOT_UNIQUE_IN_AUTHORIZED_SOURCES");
      local = body.indexOf(output.evidenceQuote, local + 1);
    }
  }
  if (matches.length !== 1) return reject("NO_UNIQUE_VERBATIM_QUOTE_MATCH");
  const match = matches[0]!;
  const confirmed = output.sourceId === match.entry.assignedSourceId;
  return {
    status: "VERBATIM_UNIQUE_SOURCE_BOUND",
    reason: confirmed
      ? "MODEL_SOURCE_ID_AND_QUOTE_BOUND"
      : "MODEL_SOURCE_ID_REPAIRED_FROM_LITERAL_SOURCE",
    assignedSourceId: match.entry.assignedSourceId,
    modelSourceId: output.sourceId,
    sourceSha256: match.entry.sourceSha256,
    startUtf16: match.startUtf16,
    endUtf16: match.endUtf16,
    modelSourceIdConfirmed: confirmed,
    modelSourceIdRepairedByLiteralProof: !confirmed,
    semanticEntailmentVerified: false,
    releaseGateAccepted: false,
  };
}
