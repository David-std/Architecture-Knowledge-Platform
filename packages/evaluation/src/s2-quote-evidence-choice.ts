import { createHash } from "node:crypto";
import type { S2SemanticProbeResult } from "./s2-semantic-evidence.js";
const sha = (x: string) => createHash("sha256").update(x).digest("hex");
export interface S2QuoteEvidenceOption {
  readonly id: string;
  /** Offsets are relative to the original, unmodified evidence quote (UTF-16). */
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly text: string;
  readonly textSha256: string;
}
export interface S2FrozenQuoteEvidenceOptions {
  readonly schemaVersion: "akp.s2.literal-quote-selection.v1";
  readonly sourceQuoteSha256: string;
  readonly maxChunkUtf16: number;
  readonly options: readonly S2QuoteEvidenceOption[];
  readonly modelEvidenceTextIsNeverAccepted: true;
  readonly originalSourceAuthIndependentlyVerified: false;
  readonly semanticEntailmentIndependentlyVerified: false;
  readonly productionAdmission: false;
}
const boundary = (s: string, i: number) =>
  i >= 0 &&
  i <= s.length &&
  Number.isSafeInteger(i) &&
  !(
    i > 0 &&
    i < s.length &&
    s.charCodeAt(i - 1) >= 0xd800 &&
    s.charCodeAt(i - 1) <= 0xdbff &&
    s.charCodeAt(i) >= 0xdc00 &&
    s.charCodeAt(i) <= 0xdfff
  );
/**
 * Immutable literal evidence menu, generated BEFORE calling a model.
 * For longer passages, split only at valid Unicode boundaries; never remove,
 * normalize, paraphrase or rewrite bytes. A selected ID is evidence identity,
 * NOT proof that a claim actually follows from the quoted text.
 */
export function freezeS2QuoteEvidenceOptions(
  exactQuote: string,
  maxChunkUtf16 = 1400,
): S2FrozenQuoteEvidenceOptions {
  if (
    typeof exactQuote !== "string" ||
    exactQuote.trim() !== exactQuote ||
    exactQuote.length < 8 ||
    exactQuote.length > 12000 ||
    !Number.isSafeInteger(maxChunkUtf16) ||
    maxChunkUtf16 < 256 ||
    maxChunkUtf16 > 4000
  )
    throw Error("S2_EVIDENCE_CHOICES_INVALID_ORIGINAL");
  const options: S2QuoteEvidenceOption[] = [];
  let start = 0;
  while (start < exactQuote.length) {
    let end = Math.min(start + maxChunkUtf16, exactQuote.length);
    if (!boundary(exactQuote, end)) end--;
    if (end <= start) throw Error("S2_EVIDENCE_CHOICES_SPLIT_INVALID");
    const text = exactQuote.slice(start, end);
    options.push({
      id: "Q" + (options.length + 1),
      startUtf16: start,
      endUtf16: end,
      text,
      textSha256: sha(text),
    });
    if (options.length > 48) throw Error("S2_EVIDENCE_CHOICES_EXCESSIVE");
    start = end;
  }
  return {
    schemaVersion: "akp.s2.literal-quote-selection.v1",
    sourceQuoteSha256: sha(exactQuote),
    maxChunkUtf16,
    options,
    modelEvidenceTextIsNeverAccepted: true,
    originalSourceAuthIndependentlyVerified: false,
    semanticEntailmentIndependentlyVerified: false,
    productionAdmission: false,
  };
}
/** Provider JSON schema is derived ONLY from pre-frozen original-source IDs. */
export function buildS2QuoteEvidenceChoiceFormat(
  exactQuote: string,
  frozen: S2FrozenQuoteEvidenceOptions,
) {
  if (
    !frozen ||
    sha(exactQuote) !== frozen.sourceQuoteSha256 ||
    JSON.stringify(
      freezeS2QuoteEvidenceOptions(exactQuote, frozen.maxChunkUtf16),
    ) !== JSON.stringify(frozen)
  )
    throw Error("S2_EVIDENCE_CHOICES_SCHEMA_SOURCE_DRIFT");
  return {
    type: "object",
    additionalProperties: false,
    required: ["decision", "evidenceId"],
    properties: {
      decision: {
        type: "string",
        enum: ["SUPPORTS", "CONTRADICTS", "INSUFFICIENT"],
      },
      evidenceId: {
        type: "string",
        enum: ["NONE", ...frozen.options.map((option) => option.id)],
      },
    },
  } as const;
}
export interface S2QuoteEvidenceModelVerdict {
  readonly decision: "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT";
  readonly evidenceId: string;
}
/**
 * A model may only choose a candidate already frozen from source bytes.
 * Invalid, invented or contradictory answer shapes fail closed; no fuzzy
 * matching, nearest neighbor, UTF-16 repair or posthoc source text injection.
 */
export function resolveS2QuoteEvidenceChoice(
  exactQuote: string,
  frozen: S2FrozenQuoteEvidenceOptions,
  verdict: unknown,
): S2SemanticProbeResult {
  const fail: S2SemanticProbeResult = {
    decision: "INSUFFICIENT",
    reason: "MODEL_LITERAL_EVIDENCE_CHOICE_INVALID",
  };
  if (
    typeof exactQuote !== "string" ||
    !frozen ||
    typeof frozen.sourceQuoteSha256 !== "string" ||
    sha(exactQuote) !== frozen.sourceQuoteSha256 ||
    !Array.isArray(frozen.options) ||
    !Number.isSafeInteger(frozen.maxChunkUtf16)
  )
    return fail;
  let exact: S2FrozenQuoteEvidenceOptions;
  try {
    exact = freezeS2QuoteEvidenceOptions(exactQuote, frozen.maxChunkUtf16);
  } catch {
    return fail;
  }
  if (JSON.stringify(exact) !== JSON.stringify(frozen)) return fail;
  if (typeof verdict !== "object" || verdict === null || Array.isArray(verdict))
    return fail;
  const v = verdict as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "decision,evidenceId") return fail;
  if (v.decision === "INSUFFICIENT" && v.evidenceId === "NONE")
    return { decision: "INSUFFICIENT", reason: "MODEL_INSUFFICIENT" };
  if (v.decision !== "SUPPORTS" && v.decision !== "CONTRADICTS") return fail;
  const opt = frozen.options.find((x) => x.id === v.evidenceId);
  if (
    !opt ||
    exactQuote.slice(opt.startUtf16, opt.endUtf16) !== opt.text ||
    sha(opt.text) !== opt.textSha256
  )
    return fail;
  return {
    decision: v.decision,
    reason: "MODEL_VERDICT_ORIGINAL_LITERAL_ID_SELECTED",
    evidenceSpan: { startUtf16: opt.startUtf16, endUtf16: opt.endUtf16 },
  };
}

/**
 * Atomic decision+evidence token. Unlike the legacy two-independent-fields
 * provider schema, a single enum value CANNOT express INSUFFICIENT with a
 * supporting Q1 citation. The source/UTF-16 resolver remains the canonical
 * verifier: a legal token does not imply the claim is semantically true.
 */
export function buildS2PairedQuoteEvidenceTokenFormat(
  exactQuote: string,
  frozen: S2FrozenQuoteEvidenceOptions,
) {
  // This reuses the existing original/hash/freeze verifier; tokens are derived
  // solely from the same immutable, pre-inference source quote IDs.
  const base = buildS2QuoteEvidenceChoiceFormat(exactQuote, frozen);
  const ids = base.properties.evidenceId.enum.filter((id) => id !== "NONE");
  const tokens = [
    "INSUFFICIENT@NONE",
    ...ids.flatMap((id) => ["SUPPORTS@" + id, "CONTRADICTS@" + id]),
  ];
  return {
    type: "object",
    additionalProperties: false,
    required: ["questionToken", "claimToken"],
    properties: {
      questionToken: { type: "string", enum: tokens },
      claimToken: { type: "string", enum: tokens },
    },
  } as const;
}

/** Literal token syntax only; no heuristic backfill or model-text repair. */
export function resolveS2QuoteEvidenceToken(
  exactQuote: string,
  frozen: S2FrozenQuoteEvidenceOptions,
  token: unknown,
): S2SemanticProbeResult {
  const fail: S2SemanticProbeResult = {
    decision: "INSUFFICIENT",
    reason: "MODEL_LITERAL_EVIDENCE_CHOICE_INVALID",
  };
  if (typeof token !== "string" || token.length > 32) return fail;
  if (token === "INSUFFICIENT@NONE")
    return resolveS2QuoteEvidenceChoice(exactQuote, frozen, {
      decision: "INSUFFICIENT",
      evidenceId: "NONE",
    });
  const match = /^(SUPPORTS|CONTRADICTS)@(Q[1-9][0-9]*)$/u.exec(token);
  if (!match) return fail;
  return resolveS2QuoteEvidenceChoice(exactQuote, frozen, {
    decision: match[1],
    evidenceId: match[2],
  });
}
