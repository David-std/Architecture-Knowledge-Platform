import { createHash } from "node:crypto";

/**
 * An offline byte-level SOURCE/HTTP receipt check. This is deliberately not
 * an authorization, entailment, reviewer-custody, or release certificate.
 * Original source files must be supplied separately from captured HTTP hits.
 */
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const hex = /^[a-f0-9]{64}$/u;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const boundary = (value: string, i: number): boolean =>
  Number.isSafeInteger(i) &&
  i >= 0 &&
  i <= value.length &&
  !(
    i > 0 &&
    i < value.length &&
    value.charCodeAt(i - 1) >= 0xd800 &&
    value.charCodeAt(i - 1) <= 0xdbff &&
    value.charCodeAt(i) >= 0xdc00 &&
    value.charCodeAt(i) <= 0xdfff
  );

export interface S2RawHttpOriginal {
  readonly documentId: string;
  readonly vaultId: string;
  readonly path: string;
  readonly revision: string;
  readonly originalSha256: string;
  readonly bytes: Uint8Array;
  readonly bodyStartUtf16: number;
  readonly bodyEndUtf16: number;
}
export interface S2RawHttpQuote {
  readonly hitIndex: number;
  readonly documentId: string;
  readonly quote: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
}
export interface S2RawHttpEvidenceInput {
  readonly rawRequestBytes: Uint8Array;
  readonly externallyPinnedRequestSha256: string;
  readonly rawResponseBytes: Uint8Array;
  readonly externallyPinnedResponseSha256: string;
  readonly httpStatus: number;
  readonly expectedVaultId: string;
  readonly originals: readonly S2RawHttpOriginal[];
  readonly quotes: readonly S2RawHttpQuote[];
}
export interface S2RawHttpEvidenceResult {
  readonly status: "REPLAY_VERIFIED" | "REJECTED";
  readonly reason: string;
  readonly literalQuotesVerified: number;
  readonly requestResponseBytesReplayed: boolean;
  readonly quotedSourceSpansReplayed: boolean;
  readonly externalPinCustodyAuthenticated: false;
  readonly authorizationIndependentlyVerified: false;
  readonly semanticEntailmentVerified: false;
  readonly completeAnswerCorrectness: null;
  readonly releaseGateAccepted: false;
}
export function replayS2RawHttpEvidence(
  input: S2RawHttpEvidenceInput,
): S2RawHttpEvidenceResult {
  const make = (
    status: S2RawHttpEvidenceResult["status"],
    reason: string,
    count = 0,
  ): S2RawHttpEvidenceResult => ({
    status,
    reason,
    literalQuotesVerified: count,
    requestResponseBytesReplayed: status === "REPLAY_VERIFIED",
    quotedSourceSpansReplayed: status === "REPLAY_VERIFIED",
    externalPinCustodyAuthenticated: false,
    authorizationIndependentlyVerified: false,
    semanticEntailmentVerified: false,
    completeAnswerCorrectness: null,
    releaseGateAccepted: false,
  });
  const reject = (reason: string) => make("REJECTED", reason);
  if (
    !hex.test(input.externallyPinnedRequestSha256) ||
    !hex.test(input.externallyPinnedResponseSha256) ||
    input.rawRequestBytes.length === 0 ||
    input.rawRequestBytes.length > 64_000 ||
    input.rawResponseBytes.length === 0 ||
    input.rawResponseBytes.length > 2_000_000 ||
    sha(input.rawRequestBytes) !== input.externallyPinnedRequestSha256 ||
    sha(input.rawResponseBytes) !== input.externallyPinnedResponseSha256
  )
    return reject("HTTP_BYTES_NOT_EXTERNALLY_PINNED");
  let request: unknown, response: unknown;
  try {
    request = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.rawRequestBytes),
    );
    response = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(input.rawResponseBytes),
    );
  } catch {
    return reject("HTTP_PAYLOAD_NOT_UTF8_JSON");
  }
  if (
    input.httpStatus !== 200 ||
    !record(request) ||
    !record(response) ||
    typeof request.query !== "string" ||
    request.query.trim().length === 0 ||
    typeof input.expectedVaultId !== "string" ||
    input.expectedVaultId.length === 0 ||
    request.vaultId !== input.expectedVaultId ||
    !record(response.scope) ||
    !Array.isArray(response.scope.vaultIds) ||
    response.scope.vaultIds.length !== 1 ||
    response.scope.vaultIds[0] !== input.expectedVaultId ||
    !Array.isArray(response.hits) ||
    response.hits.length > 100
  )
    return reject("HTTP_REQUEST_RESPONSE_SCOPE_INVALID");

  if (
    !Array.isArray(input.originals) ||
    input.originals.length === 0 ||
    input.originals.length > 32 ||
    !Array.isArray(input.quotes) ||
    input.quotes.length === 0 ||
    input.quotes.length > 64
  )
    return reject("SOURCE_SET_OR_QUOTES_UNBOUNDED");

  const verifiedSources = new Map<
    string,
    { source: S2RawHttpOriginal; text: string }
  >();
  for (const source of input.originals) {
    if (
      !source.documentId ||
      !source.revision ||
      !source.path ||
      source.vaultId !== input.expectedVaultId ||
      !hex.test(source.originalSha256) ||
      source.bytes.length === 0 ||
      source.bytes.length > 2_000_000 ||
      sha(source.bytes) !== source.originalSha256 ||
      verifiedSources.has(source.documentId)
    )
      return reject("ORIGINAL_SOURCE_IDENTITY_OR_HASH_INVALID");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        source.bytes,
      );
    } catch {
      return reject("ORIGINAL_SOURCE_ENCODING_INVALID");
    }
    if (
      !boundary(text, source.bodyStartUtf16) ||
      !boundary(text, source.bodyEndUtf16) ||
      source.bodyStartUtf16 >= source.bodyEndUtf16
    )
      return reject("ORIGINAL_SOURCE_FRAME_INVALID");
    verifiedSources.set(source.documentId, { source, text });
  }
  const seen = new Set<string>();
  for (const citation of input.quotes) {
    if (
      !Number.isSafeInteger(citation.hitIndex) ||
      citation.hitIndex < 0 ||
      citation.hitIndex >= response.hits.length ||
      typeof citation.quote !== "string" ||
      citation.quote.trim() !== citation.quote ||
      citation.quote.length < 1 ||
      citation.quote.length > 12_000
    )
      return reject("QUOTE_SHAPE_OR_HIT_INDEX_INVALID");
    const hit: unknown = response.hits[citation.hitIndex];
    const matched = verifiedSources.get(citation.documentId);
    if (!record(hit) || !matched)
      return reject("QUOTE_NOT_BOUND_TO_AUTHORIZED_SOURCE");
    const { source, text } = matched;
    if (
      hit.documentId !== source.documentId ||
      hit.vaultId !== source.vaultId ||
      hit.revision !== source.revision ||
      !record(hit.document) ||
      hit.document.path !== source.path ||
      !Array.isArray(hit.citations) ||
      !hit.citations.includes(source.path + "@" + source.revision) ||
      typeof hit.excerpt !== "string" ||
      !hit.excerpt.includes(citation.quote)
    )
      return reject("HTTP_HIT_CITATION_OR_EXCERPT_MISMATCH");
    if (
      !boundary(text, citation.startUtf16) ||
      !boundary(text, citation.endUtf16) ||
      citation.startUtf16 < source.bodyStartUtf16 ||
      citation.endUtf16 > source.bodyEndUtf16 ||
      citation.endUtf16 <= citation.startUtf16 ||
      text.slice(citation.startUtf16, citation.endUtf16) !== citation.quote
    )
      return reject("QUOTE_DOES_NOT_REPLAY_AT_ORIGINAL_UTF16_SPAN");
    const identity =
      citation.hitIndex +
      ":" +
      citation.documentId +
      ":" +
      citation.startUtf16 +
      ":" +
      citation.endUtf16;
    if (seen.has(identity)) return reject("DUPLICATED_CITATION_PROOF");
    seen.add(identity);
  }
  return make(
    "REPLAY_VERIFIED",
    "PINNED_HTTP_AND_ORIGINAL_SOURCE_SPANS_MATCH",
    seen.size,
  );
}
