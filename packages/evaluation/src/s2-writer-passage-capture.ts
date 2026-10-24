import { createHash } from "node:crypto";

/**
 * OFFLINE EXPERIMENT: exact provider-request bytes and every passage ID/text.
 * Never use this record to grant production admission. The records contain
 * raw questions and passages, so store them only in restricted private files.
 */
const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const HEX = /^[a-f0-9]{64}$/u;
const fail = (reason: string): never => {
  throw new Error("S2_WRITER_CAPTURE_" + reason);
};
const boundary = (s: string, n: number) =>
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

export interface FrozenOriginalReference {
  documentKeySha256: string;
  fileSha256: string;
  /** Full original Markdown bytes; includes any frontmatter, newline or BOM. */
  fileBytes: Uint8Array;
  bodyStartUtf16: number;
  bodyEndUtf16: number;
}
export type S2Passage = {
  id: string;
  text: string;
  /** No invented offsets: leave null if derived/normalized text is not literal. */
  original: null | {
    documentKeySha256: string;
    fileSha256: string;
    startUtf16: number;
    endUtf16: number;
  };
};
export type WriterProbeInput = {
  caseKeySha256: string;
  caseManifestSha256: string;
  sourceManifestSha256: string;
  executedCommitSha: string;
  sourceFamilySha256: string;
  language: "en" | "es";
  question: string;
  model: string;
  modelDigestSha256: string;
  systemPrompt: string;
  temperature: 0;
  seed: number;
  maxTokens: number;
  passages: S2Passage[];
};
export type FrozenRequest = {
  schemaVersion: "akp.s2.writer-exact-request.v1";
  status: "PRIVATE_DEVELOPMENT_PRE_PROVIDER";
  caseKeySha256: string;
  caseManifestSha256: string;
  sourceManifestSha256: string;
  executedCommitSha: string;
  sourceFamilySha256: string;
  language: "en" | "es";
  modelDigestSha256: string;
  requestBodySha256: string;
  requestBodyUtf8Base64: string;
  passages: {
    id: string;
    textSha256: string;
    textUtf16Length: number;
    source: "ORIGINAL_LITERAL_MATCH" | "UNBOUND_PROJECTION";
    original: S2Passage["original"];
  }[];
  allPassagesLiteralOriginalBound: boolean;
  originalCustodianIndependentlyAttested: false;
  modelCitationFaithfulnessIndependentlyAdjudicated: false;
  gateAccepted: false;
};
export type RequestBuild = {
  requestBodyBytes: Uint8Array;
  frozen: FrozenRequest;
};

function decodeOriginal(ref: FrozenOriginalReference): string {
  if (
    !HEX.test(ref.documentKeySha256) ||
    !HEX.test(ref.fileSha256) ||
    ref.fileBytes.length === 0 ||
    ref.fileBytes.length > 2_000_000 ||
    hash(ref.fileBytes) !== ref.fileSha256
  )
    fail("ORIGINAL_FILE_HASH_OR_IDENTITY");
  let raw = "";
  try {
    raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      ref.fileBytes,
    );
  } catch {
    fail("ORIGINAL_FILE_UTF8");
  }
  if (
    !boundary(raw, ref.bodyStartUtf16) ||
    !boundary(raw, ref.bodyEndUtf16) ||
    ref.bodyStartUtf16 >= ref.bodyEndUtf16
  )
    fail("ORIGINAL_BODY_FRAME");
  return raw;
}
/** Construct the exact *same* UTF-8 bytes that must be sent to the provider. */
export function freezeExactWriterRequest(
  input: WriterProbeInput,
  originals: readonly FrozenOriginalReference[],
): RequestBuild {
  if (
    ![
      input.caseKeySha256,
      input.caseManifestSha256,
      input.sourceManifestSha256,
      input.sourceFamilySha256,
      input.modelDigestSha256,
    ].every((v) => HEX.test(v)) ||
    !/^[a-f0-9]{40}$/u.test(input.executedCommitSha) ||
    !(input.language === "en" || input.language === "es") ||
    hash(input.language + "\0" + input.question) !== input.caseKeySha256 ||
    typeof input.question !== "string" ||
    !input.question.trim() ||
    input.question.length > 8000 ||
    !input.systemPrompt.trim() ||
    input.systemPrompt.length > 8000 ||
    !input.model.trim() ||
    input.model.length > 128 ||
    input.temperature !== 0 ||
    !Number.isSafeInteger(input.seed) ||
    input.seed < 0 ||
    !Number.isSafeInteger(input.maxTokens) ||
    input.maxTokens < 1 ||
    input.maxTokens > 8192 ||
    !Array.isArray(input.passages) ||
    input.passages.length > 32 ||
    input.passages.length === 0
  )
    fail("INVALID_FROZEN_REQUEST");
  const byId = new Map<
    string,
    { meta: FrozenOriginalReference; text: string }
  >();
  for (const file of originals) {
    if (byId.has(file.documentKeySha256)) fail("DUPLICATE_FROZEN_ORIGINAL");
    byId.set(file.documentKeySha256, {
      meta: file,
      text: decodeOriginal(file),
    });
  }
  const seen = new Set<string>();
  const passages: FrozenRequest["passages"] = [];
  for (const item of input.passages) {
    if (
      !/^(SRC|SECTION)[1-9][0-9]*$/u.test(item.id) ||
      seen.has(item.id) ||
      typeof item.text !== "string" ||
      item.text.length === 0 ||
      item.text.length > 20_000
    )
      fail("INVALID_PASSAGE");
    seen.add(item.id);
    let source: "ORIGINAL_LITERAL_MATCH" | "UNBOUND_PROJECTION" =
      "UNBOUND_PROJECTION";
    if (item.original) {
      const o = item.original;
      const ref = byId.get(o.documentKeySha256);
      if (
        !ref ||
        !HEX.test(o.fileSha256) ||
        ref.meta.fileSha256 !== o.fileSha256 ||
        !boundary(ref.text, o.startUtf16) ||
        !boundary(ref.text, o.endUtf16) ||
        o.startUtf16 < ref.meta.bodyStartUtf16 ||
        o.endUtf16 > ref.meta.bodyEndUtf16 ||
        o.startUtf16 >= o.endUtf16 ||
        ref.text.slice(o.startUtf16, o.endUtf16) !== item.text
      )
        fail("PASSAGE_NOT_EXACT_ORIGINAL_UTF16");
      source = "ORIGINAL_LITERAL_MATCH";
    }
    passages.push({
      id: item.id,
      textSha256: hash(item.text),
      textUtf16Length: item.text.length,
      source,
      original: item.original,
    });
  }
  // This is deliberately identical to the provider-facing prompt renderer.
  const userPrompt =
    "Question:\n" +
    input.question +
    "\n\nAuthorized passages:\n" +
    input.passages.map((p) => "[" + p.id + "] " + p.text).join("\n\n");
  const request = {
    model: input.model,
    temperature: input.temperature,
    seed: input.seed,
    max_tokens: input.maxTokens,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: input.systemPrompt },
      { role: "user", content: userPrompt },
    ],
  };
  const requestBodyBytes = Buffer.from(JSON.stringify(request), "utf8");
  return {
    requestBodyBytes,
    frozen: {
      schemaVersion: "akp.s2.writer-exact-request.v1",
      status: "PRIVATE_DEVELOPMENT_PRE_PROVIDER",
      caseKeySha256: input.caseKeySha256,
      caseManifestSha256: input.caseManifestSha256,
      sourceManifestSha256: input.sourceManifestSha256,
      executedCommitSha: input.executedCommitSha,
      sourceFamilySha256: input.sourceFamilySha256,
      language: input.language,
      modelDigestSha256: input.modelDigestSha256,
      requestBodySha256: hash(requestBodyBytes),
      requestBodyUtf8Base64: Buffer.from(requestBodyBytes).toString("base64"),
      passages,
      allPassagesLiteralOriginalBound: passages.every(
        (p) => p.source === "ORIGINAL_LITERAL_MATCH",
      ),
      originalCustodianIndependentlyAttested: false,
      modelCitationFaithfulnessIndependentlyAdjudicated: false,
      gateAccepted: false,
    },
  };
}
export function validateExactWriterRequest(
  frozen: FrozenRequest,
  sent: Uint8Array,
) {
  if (
    frozen.schemaVersion !== "akp.s2.writer-exact-request.v1" ||
    hash(sent) !== frozen.requestBodySha256 ||
    Buffer.from(sent).toString("base64") !== frozen.requestBodyUtf8Base64
  )
    fail("PROVIDER_REQUEST_NOT_FROZEN_BYTES");
  const parsed: unknown = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(sent),
  );
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("messages" in parsed) ||
    !Array.isArray(parsed.messages) ||
    parsed.messages.length !== 2
  )
    fail("INVALID_PROVIDER_REQUEST");
  const messages = (parsed as { messages: unknown[] }).messages;
  const last = messages[1] as { content?: unknown };
  const content = last?.content;
  if (
    typeof content !== "string" ||
    frozen.passages.some((p) => !content.includes("[" + p.id + "] "))
  )
    fail("PASSAGE_ID_NOT_IN_SENT_PAYLOAD");
  return true;
}
export function sealExactWriterResponse(
  frozen: FrozenRequest,
  exactSentBytes: Uint8Array,
  rawResponseBytes: Uint8Array,
  elapsedMs: number,
) {
  validateExactWriterRequest(frozen, exactSentBytes);
  if (
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 0 ||
    rawResponseBytes.length === 0 ||
    rawResponseBytes.length > 2_000_000
  )
    fail("INVALID_PROVIDER_RESPONSE");
  return {
    schemaVersion: "akp.s2.writer-exact-response-receipt.v1" as const,
    status: "PRIVATE_DEVELOPMENT_RECORDED" as const,
    requestBodySha256: frozen.requestBodySha256,
    rawResponseSha256: hash(rawResponseBytes),
    rawResponseBytes: rawResponseBytes.length,
    elapsedProviderMs: elapsedMs,
    allPassagesLiteralOriginalBound: frozen.allPassagesLiteralOriginalBound,
    originalCustodianIndependentlyAttested: false as const,
    modelCitationFaithfulnessIndependentlyAdjudicated: false as const,
    fullHttpEndToEndP95Measured: false as const,
    gateAccepted: false as const,
  };
}
