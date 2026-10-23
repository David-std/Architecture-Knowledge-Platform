import { createHash } from "node:crypto";
import type { S2ExactQuoteOriginal } from "./s2-exact-quote-attribution.js";

/**
 * Candidate discovery over already-authorized and hash-verified originals.
 * A selected window is not an entailment verdict or an admitted answer.
 */
export interface S2EvidenceWindow {
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly exactText: string;
  readonly modelTokens: number;
  readonly lexicalScore: number;
  readonly productionAdmission: false;
}

export interface S2VerbatimWindowQuoteCandidate {
  readonly status: "VERBATIM_UNIQUE_ORIGINAL_CANDIDATE";
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly quote: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly productionAdmission: false;
}

/**
 * Bridge source-bound retrieval windows into the existing exact-quote F3 API.
 * Markdown blocks can end with CRLF/whitespace, while verbatim attribution
 * correctly forbids surrounding whitespace. Trim ONLY the original window
 * boundaries, then verify the resulting quote remains unique in the pinned
 * SHA-verified source. No fuzzy matching, invented text or admission.
 */
export function bindS2VerbatimWindowQuote(
  original: S2ExactQuoteOriginal,
  window: Pick<
    S2EvidenceWindow,
    | "sourceId"
    | "sourceSha256"
    | "startUtf16"
    | "endUtf16"
    | "exactText"
    | "productionAdmission"
  >,
): S2VerbatimWindowQuoteCandidate | null {
  const source = verifySource(original);
  if (
    source === null ||
    original.assignedSourceId !== window.sourceId ||
    original.sourceSha256 !== window.sourceSha256 ||
    !validBoundary(source, window.startUtf16) ||
    !validBoundary(source, window.endUtf16) ||
    window.endUtf16 <= window.startUtf16 ||
    source.slice(window.startUtf16, window.endUtf16) !== window.exactText ||
    window.productionAdmission !== false
  )
    return null;
  const quote = window.exactText.trim();
  if (quote.length < 12 || quote.length > 12000) return null;
  const offsetInWindow = window.exactText.indexOf(quote);
  const start = window.startUtf16 + offsetInWindow;
  const end = start + quote.length;
  if (
    offsetInWindow < 0 ||
    !validBoundary(source, start) ||
    !validBoundary(source, end) ||
    end > window.endUtf16 ||
    source.slice(start, end) !== quote
  )
    return null;
  const body = source.slice(original.bodyStartUtf16, original.bodyEndUtf16);
  const local = body.indexOf(quote);
  if (
    local < 0 ||
    original.bodyStartUtf16 + local !== start ||
    body.indexOf(quote, local + 1) !== -1
  )
    return null;
  return {
    status: "VERBATIM_UNIQUE_ORIGINAL_CANDIDATE",
    sourceId: window.sourceId,
    sourceSha256: window.sourceSha256,
    quote,
    startUtf16: start,
    endUtf16: end,
    productionAdmission: false,
  };
}

export interface S2EvidenceWindowResult {
  readonly status: "CANDIDATES" | "INSUFFICIENT" | "REJECTED";
  readonly reason: string;
  readonly examined: number;
  readonly overBudget: number;
  readonly windows: readonly S2EvidenceWindow[];
  readonly productionAdmission: false;
}

export interface S2EvidenceWindowSelectorConfig {
  /** Same revision-pinned tokenizer used by the entailment verifier. */
  readonly tokenizerId: string;
  countTokens(premise: string, hypothesis: string): Promise<number>;
  readonly maxTokens: number;
  readonly maxWindows: number;
  readonly maxSentencesPerWindow: 1 | 2;
  /** Shadow-only selection mode. Default leaves existing selection unchanged. */
  readonly diversityMode?: "NONE" | "NON_REDUNDANT";
  /** Shadow-only alternative preserving Markdown prose/code block boundaries. */
  readonly segmentationMode?: "SENTENCES" | "MARKDOWN_BLOCKS";
  /** Only for MARKDOWN_BLOCKS; at most three adjacent original blocks. */
  readonly maxMarkdownBlocksPerWindow?: 1 | 2 | 3;
}

const tokenize = (value: string): string[] =>
  [
    ...value
      .normalize("NFKC")
      .toLocaleLowerCase()
      .matchAll(/[\p{L}\p{N}]+/gu),
  ]
    .map((m) => m[0])
    .filter((w) => w.length > 1);

const STOPWORDS = new Set([
  "the",
  "and",
  "that",
  "with",
  "this",
  "from",
  "where",
  "when",
  "what",
  "which",
  "how",
  "are",
  "was",
  "were",
  "have",
  "has",
  "does",
  "for",
  "into",
  "many",
  "much",
  "their",
  "after",
  "before",
  "del",
  "los",
  "las",
  "una",
  "unos",
  "unas",
  "para",
  "como",
  "que",
  "por",
  "con",
  "donde",
  "cuando",
  "cuantos",
  "cuantas",
  "cual",
  "sobre",
  "sus",
  "son",
  "están",
  "esta",
]);

const validBoundary = (text: string, position: number): boolean =>
  Number.isSafeInteger(position) &&
  position >= 0 &&
  position <= text.length &&
  !(
    position > 0 &&
    position < text.length &&
    text.charCodeAt(position - 1) >= 0xd800 &&
    text.charCodeAt(position - 1) <= 0xdbff &&
    text.charCodeAt(position) >= 0xdc00 &&
    text.charCodeAt(position) <= 0xdfff
  );

function verifySource(original: S2ExactQuoteOriginal): string | null {
  if (
    !original.assignedSourceId?.trim() ||
    !/^[a-f0-9]{64}$/iu.test(original.sourceSha256) ||
    !(original.exactUtf8Bytes instanceof Uint8Array)
  )
    return null;
  const observed = createHash("sha256")
    .update(original.exactUtf8Bytes)
    .digest("hex");
  if (observed !== original.sourceSha256.toLowerCase()) return null;
  try {
    const body = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(original.exactUtf8Bytes);
    if (
      !validBoundary(body, original.bodyStartUtf16) ||
      !validBoundary(body, original.bodyEndUtf16) ||
      original.bodyEndUtf16 <= original.bodyStartUtf16
    )
      return null;
    return body;
  } catch {
    return null;
  }
}

function sentences(source: string, start: number, end: number) {
  const body = source.slice(start, end);
  const segments: { start: number; end: number }[] = [];
  for (const part of new Intl.Segmenter("en", {
    granularity: "sentence",
  }).segment(body)) {
    const trimmed = part.segment.trim();
    if (!trimmed) continue;
    const begin = part.index + part.segment.indexOf(trimmed) + start;
    const finish = begin + trimmed.length;
    if (!validBoundary(source, begin) || !validBoundary(source, finish))
      continue;
    segments.push({ start: begin, end: finish });
  }
  return segments;
}

/**
 * Identify bounded Markdown blocks without normalizing original text.
 * Blank-line separation is ignored inside fenced code; headings remain
 * source text and can be joined to following explanatory/code blocks.
 * This is segmentation only, never source or answer authority.
 */
function markdownBlocks(source: string, start: number, end: number) {
  const body = source.slice(start, end);
  const lines = body.match(/[^\n]*(?:\n|$)/gu) ?? [];
  const blocks: { start: number; end: number }[] = [];
  let cursor = 0;
  let activeStart = -1;
  let activeEnd = 0;
  let fence: string | null = null;
  const flush = () => {
    if (activeStart < 0) return;
    if (validBoundary(source, activeStart) && validBoundary(source, activeEnd))
      blocks.push({ start: activeStart, end: activeEnd });
    activeStart = -1;
  };
  for (const line of lines) {
    if (!line) continue;
    const trim = line.trim();
    const lineStart = start + cursor;
    cursor += line.length;
    const marker = trim.match(/^(`{3,}|~{3,})/u)?.[1] ?? null;
    if (activeStart < 0 && trim) activeStart = lineStart;
    if (trim) activeEnd = start + cursor;
    if (marker) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence && marker.length >= 3) fence = null;
    }
    if (!trim && fence === null) flush();
  }
  flush();
  return blocks;
}

/**
 * Rank contiguous source windows, preserving original UTF-16 coordinates.
 * Its lexical score is only a proposal order; external verifiers must assess
 * each claim with independently observed source text and question context.
 */
export async function selectS2ClaimEvidenceWindows(
  original: S2ExactQuoteOriginal,
  question: string,
  claim: string,
  config: S2EvidenceWindowSelectorConfig,
): Promise<S2EvidenceWindowResult> {
  const result = (
    status: S2EvidenceWindowResult["status"],
    reason: string,
    examined = 0,
    overBudget = 0,
    windows: readonly S2EvidenceWindow[] = [],
  ): S2EvidenceWindowResult => ({
    status,
    reason,
    examined,
    overBudget,
    windows,
    productionAdmission: false,
  });
  if (
    typeof question !== "string" ||
    typeof claim !== "string" ||
    !question.trim() ||
    !claim.trim() ||
    question.length > 2048 ||
    claim.length > 4096 ||
    !config?.tokenizerId?.includes("@") ||
    !Number.isSafeInteger(config.maxTokens) ||
    config.maxTokens < 1 ||
    config.maxTokens > 8192 ||
    !Number.isSafeInteger(config.maxWindows) ||
    config.maxWindows < 1 ||
    config.maxWindows > 16 ||
    ![1, 2].includes(config.maxSentencesPerWindow) ||
    (config.diversityMode !== undefined &&
      !["NONE", "NON_REDUNDANT"].includes(config.diversityMode)) ||
    (config.segmentationMode !== undefined &&
      !["SENTENCES", "MARKDOWN_BLOCKS"].includes(config.segmentationMode)) ||
    (config.maxMarkdownBlocksPerWindow !== undefined &&
      ![1, 2, 3].includes(config.maxMarkdownBlocksPerWindow)) ||
    typeof config.countTokens !== "function"
  )
    return result("REJECTED", "EVIDENCE_SELECTOR_INPUT_OR_CONFIG_INVALID");
  const source = verifySource(original);
  if (source === null || source.length > 100_000)
    return result("REJECTED", "SOURCE_HASH_UTF8_OR_SPAN_INVALID");
  const useBlocks = config.segmentationMode === "MARKDOWN_BLOCKS";
  const spans = useBlocks
    ? markdownBlocks(source, original.bodyStartUtf16, original.bodyEndUtf16)
    : sentences(source, original.bodyStartUtf16, original.bodyEndUtf16);
  if (spans.length > 2000)
    return result("INSUFFICIENT", "SOURCE_SENTENCE_BUDGET_EXCEEDED");
  const terms = new Set(
    [...tokenize(question), ...tokenize(claim)].filter(
      (w) => !STOPWORDS.has(w),
    ),
  );
  const weighted = [...terms];
  if (weighted.length === 0)
    return result("INSUFFICIENT", "NO_CLAIM_FOCUS_TERMS");

  const pool: { begin: number; finish: number; score: number }[] = [];
  for (let i = 0; i < spans.length; i++) {
    const limit = useBlocks
      ? (config.maxMarkdownBlocksPerWindow ?? 3)
      : config.maxSentencesPerWindow;
    for (let width = 1; width <= limit; width++) {
      if (i + width > spans.length) continue;
      // Never join two independent Markdown sections to manufacture a
      // subject/predicate relationship across sibling headings. The first
      // block may be its section heading; later blocks must not start one.
      if (
        useBlocks &&
        width > 1 &&
        Array.from({ length: width - 1 }, (_, offset) => i + offset + 1).some(
          (index) =>
            /^ {0,3}#{1,6}(?:\s|$)/u.test(
              source.slice(spans[index]!.start, spans[index]!.end),
            ),
        )
      )
        continue;
      const begin = spans[i]!.start;
      const finish = spans[i + width - 1]!.end;
      const phrase = source.slice(begin, finish);
      if (phrase.length > 8000) continue;
      const observed = new Set(tokenize(phrase));
      const overlap = weighted.filter((w) => observed.has(w)).length;
      if (overlap === 0) continue;
      // Prefer focused windows without silently forbidding two-sentence proof.
      const score = overlap / weighted.length - (width - 1) * 0.015;
      pool.push({ begin, finish, score });
    }
  }
  pool.sort(
    (a, b) =>
      b.score - a.score ||
      a.finish - a.begin - (b.finish - b.begin) ||
      a.begin - b.begin,
  );
  // Limit expensive tokenizer calls and maintain deterministic upper bounds.
  const shortlisted = pool.slice(
    0,
    Math.min(96, Math.max(12, config.maxWindows * 12)),
  );
  const eligible: S2EvidenceWindow[] = [];
  let rejectedForTokens = 0;
  for (const entry of shortlisted) {
    const exactText = source.slice(entry.begin, entry.finish);
    let count: number;
    try {
      count = await config.countTokens(exactText, claim);
    } catch {
      return result(
        "REJECTED",
        "PINNED_TOKENIZER_FAILURE",
        shortlisted.length,
        rejectedForTokens,
      );
    }
    if (!Number.isSafeInteger(count) || count < 1)
      return result(
        "REJECTED",
        "PINNED_TOKENIZER_INVALID",
        shortlisted.length,
        rejectedForTokens,
      );
    if (count > config.maxTokens) {
      rejectedForTokens++;
      continue;
    }
    if (source.slice(entry.begin, entry.finish) !== exactText)
      return result(
        "REJECTED",
        "SOURCE_SPAN_REPLAY_FAILED",
        shortlisted.length,
        rejectedForTokens,
      );
    eligible.push({
      sourceId: original.assignedSourceId,
      sourceSha256: original.sourceSha256,
      startUtf16: entry.begin,
      endUtf16: entry.finish,
      exactText,
      modelTokens: count,
      lexicalScore: entry.score,
      productionAdmission: false,
    });
    if (
      config.diversityMode !== "NON_REDUNDANT" &&
      eligible.length >= config.maxWindows
    )
      break;
  }
  const windows = eligible.slice(0, config.maxWindows);
  if (config.diversityMode === "NON_REDUNDANT") {
    const diverse: S2EvidenceWindow[] = [];
    const fractionalOverlap = (
      left: S2EvidenceWindow,
      right: S2EvidenceWindow,
    ) => {
      const overlap = Math.max(
        0,
        Math.min(left.endUtf16, right.endUtf16) -
          Math.max(left.startUtf16, right.startUtf16),
      );
      const shorter = Math.min(
        left.endUtf16 - left.startUtf16,
        right.endUtf16 - right.startUtf16,
      );
      return shorter > 0 ? overlap / shorter : 1;
    };
    for (const candidate of eligible) {
      if (
        diverse.every(
          (previous) => fractionalOverlap(previous, candidate) <= 0.5,
        )
      )
        diverse.push(candidate);
      if (diverse.length >= config.maxWindows) break;
    }
    // Fill unused slots without claiming uniqueness or source completeness.
    for (const candidate of eligible) {
      if (diverse.length >= config.maxWindows) break;
      if (!diverse.includes(candidate)) diverse.push(candidate);
    }
    windows.splice(0, windows.length, ...diverse);
  }
  return windows.length
    ? result(
        "CANDIDATES",
        "CANDIDATE_WINDOWS_NOT_FACTUAL_PROOF",
        shortlisted.length,
        rejectedForTokens,
        windows,
      )
    : result(
        "INSUFFICIENT",
        pool.length
          ? "NO_WINDOW_WITHIN_TOKEN_BUDGET"
          : "NO_LEXICAL_WINDOW_CANDIDATES",
        shortlisted.length,
        rejectedForTokens,
      );
}
