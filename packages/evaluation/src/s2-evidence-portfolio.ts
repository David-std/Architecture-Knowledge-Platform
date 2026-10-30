import { createHash } from "node:crypto";
import {
  assessS2QuoteSemantics,
  type S2SemanticEvidenceConfig,
  type S2SemanticEvidenceAssessment,
} from "./s2-semantic-evidence.js";
import {
  bindS2VerbatimWindowQuote,
  selectS2ClaimEvidenceWindows,
  type S2EvidenceWindow,
  type S2EvidenceWindowSelectorConfig,
} from "./s2-evidence-window-selection.js";
import type { S2ExactQuoteOriginal } from "./s2-exact-quote-attribution.js";

export interface S2WindowClaimCheck {
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly quoteSha256: string;
  readonly quoteStartUtf16: number;
  readonly quoteEndUtf16: number;
  readonly status: S2SemanticEvidenceAssessment["status"];
  readonly reason: string;
  readonly questionDecision: string | null;
  readonly entailmentDecision: string | null;
}
export interface S2EvidencePortfolioResult {
  readonly status:
    | "SUPPORTED_CANDIDATE"
    | "INSUFFICIENT"
    | "CONTRADICTION_PROPOSED"
    | "CONFLICTING_PROPOSALS"
    | "REJECTED"
    | "ERROR";
  readonly reason: string;
  readonly checks: readonly S2WindowClaimCheck[];
  readonly supportedEvidence: number;
  readonly contradictedEvidence: number;
  /** False when the intentionally inexpensive discovery mode stopped early. */
  readonly exhaustiveEvidenceScan: boolean;
  readonly unexaminedWindows: number;
  readonly questionFocusVerified: false;
  readonly completeAnswerVerified: false;
  readonly independentEvaluation: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}
export interface S2EvidencePortfolioConfig {
  readonly semantic: S2SemanticEvidenceConfig;
  readonly maxWindows?: number;
  /** SHADOW ONLY. A first-support discovery does not check later conflicts. */
  readonly verificationMode?: "EXHAUSTIVE" | "FIRST_SUPPORT";
}

/**
 * Evaluate a question/complete declarative claim against several already
 * authorized, literal source windows. Prevent one irrelevant rank-1 window
 * from irrevocably vetoing an otherwise source-backed claim.
 *
 * A portfolio result is an untrusted development observation: it NEVER
 * promotes exploratory hits, manufactures provenance, or approves an answer.
 * Contradictory original-bound model proposals are exposed as *proposals*,
 * not an authoritative refutation of a factual claim.
 */
export async function assessS2ClaimEvidencePortfolio(
  question: string,
  declarativeClaim: string,
  authorizedOriginals: readonly S2ExactQuoteOriginal[],
  windows: readonly Pick<
    S2EvidenceWindow,
    | "sourceId"
    | "sourceSha256"
    | "startUtf16"
    | "endUtf16"
    | "exactText"
    | "productionAdmission"
  >[],
  config: S2EvidencePortfolioConfig,
): Promise<S2EvidencePortfolioResult> {
  const checks: S2WindowClaimCheck[] = [];
  const make = (
    status: S2EvidencePortfolioResult["status"],
    reason: string,
  ): S2EvidencePortfolioResult => ({
    status,
    reason,
    checks,
    supportedEvidence: checks.filter((x) => x.status === "SUPPORTED_CANDIDATE")
      .length,
    contradictedEvidence: checks.filter((x) => x.status === "CONTRADICTED")
      .length,
    exhaustiveEvidenceScan: checks.length === windows.length,
    unexaminedWindows: Math.max(0, windows.length - checks.length),
    questionFocusVerified: false,
    completeAnswerVerified: false,
    independentEvaluation: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  const max = config?.maxWindows ?? 8;
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > 2048 ||
    typeof declarativeClaim !== "string" ||
    !declarativeClaim.trim() ||
    declarativeClaim.length > 2048 ||
    !Array.isArray(authorizedOriginals) ||
    authorizedOriginals.length < 1 ||
    authorizedOriginals.length > 16 ||
    !Array.isArray(windows) ||
    windows.length < 1 ||
    windows.length > max ||
    !Number.isSafeInteger(max) ||
    max < 1 ||
    max > 16 ||
    !config?.semantic?.questionRelevanceProbe?.id ||
    !config?.semantic?.claimEntailmentProbe?.id ||
    !["EXHAUSTIVE", "FIRST_SUPPORT"].includes(
      config.verificationMode ?? "EXHAUSTIVE",
    )
  )
    return make("REJECTED", "PORTFOLIO_INPUT_OR_BUDGET_INVALID");
  const originalsById = new Map<string, S2ExactQuoteOriginal>();
  for (const original of authorizedOriginals) {
    if (originalsById.has(original.assignedSourceId))
      return make("REJECTED", "DUPLICATE_AUTHORIZED_SOURCE_ID");
    originalsById.set(original.assignedSourceId, original);
  }
  // Validate the entire candidate set *before* the first model call,
  // including FIRST_SUPPORT discovery. No later malformed/foreign source may
  // hide behind an earlier positive verdict.
  const seen = new Set<string>();
  const verified: NonNullable<ReturnType<typeof bindS2VerbatimWindowQuote>>[] =
    [];
  for (const window of windows) {
    if (!window || window.productionAdmission !== false)
      return make("REJECTED", "WINDOW_NOT_EXPERIMENTAL");
    const original = originalsById.get(window.sourceId);
    if (!original) return make("REJECTED", "WINDOW_SOURCE_NOT_AUTHORIZED");
    const bound = bindS2VerbatimWindowQuote(original, window);
    if (!bound) return make("REJECTED", "WINDOW_ORIGINAL_BYTES_NOT_BOUND");
    const key =
      bound.sourceSha256 + ":" + bound.startUtf16 + ":" + bound.endUtf16;
    if (seen.has(key)) return make("REJECTED", "DUPLICATE_BOUND_WINDOW");
    seen.add(key);
    verified.push(bound);
  }
  for (const bound of verified) {
    const assessment = await assessS2QuoteSemantics(
      question,
      {
        answerText: declarativeClaim,
        evidenceQuote: bound.quote,
        sourceId: bound.sourceId,
        abstained: false,
      },
      authorizedOriginals,
      config.semantic,
    );
    checks.push({
      sourceId: bound.sourceId,
      sourceSha256: bound.sourceSha256,
      quoteSha256: createHash("sha256")
        .update(bound.quote, "utf8")
        .digest("hex"),
      quoteStartUtf16: bound.startUtf16,
      quoteEndUtf16: bound.endUtf16,
      status: assessment.status,
      reason: assessment.reason,
      questionDecision: assessment.questionRelevance?.decision ?? null,
      entailmentDecision: assessment.claimEntailment?.decision ?? null,
    });
    if (assessment.status === "REJECTED" || assessment.status === "ERROR")
      return make(
        assessment.status,
        "SOURCE_BOUND_VERIFIER_" + assessment.status,
      );
    // Discovery may return after a candidate is found. This is never an
    // exhaustive contradiction scan and cannot clear a full-answer gate.
    if (
      config.verificationMode === "FIRST_SUPPORT" &&
      assessment.status === "SUPPORTED_CANDIDATE"
    )
      return make(
        "SUPPORTED_CANDIDATE",
        "FIRST_SUPPORT_DISCOVERY_UNCHECKED_WINDOWS",
      );
  }
  const supported = checks.some((x) => x.status === "SUPPORTED_CANDIDATE");
  const conflicting = checks.some((x) => x.status === "CONTRADICTED");
  if (supported && conflicting)
    return make(
      "CONFLICTING_PROPOSALS",
      "UNVERIFIED_SUPPORT_AND_CONTRADICTION_PROPOSALS",
    );
  if (supported)
    return make("SUPPORTED_CANDIDATE", "AT_LEAST_ONE_COMPLETE_CLAIM_CANDIDATE");
  if (conflicting)
    // One reader's NLI contradiction is not an independently corroborated
    // logical refutation. Retain it only as a model proposal.
    return make(
      "CONTRADICTION_PROPOSED",
      "NO_SUPPORT_AND_UNCORROBORATED_CONTRADICTION",
    );
  return make("INSUFFICIENT", "NO_ORIGINAL_WINDOW_ENTAILS_COMPLETE_CLAIM");
}

/**
 * Two independently segmented views of the same source: sentences retain
 * short exact facts; Markdown blocks preserve headings, lists, and method
 * definitions. Proposal ranking never establishes support. Both strategies
 * use the identical revision-pinned token counter and source originals.
 */
export async function assessS2MultiGranularityClaim(
  original: S2ExactQuoteOriginal,
  question: string,
  declarativeClaim: string,
  selector: Omit<S2EvidenceWindowSelectorConfig, "segmentationMode">,
  portfolio: S2EvidencePortfolioConfig,
): Promise<S2EvidencePortfolioResult> {
  const denied = (reason: string): S2EvidencePortfolioResult => ({
    status: "REJECTED",
    reason,
    checks: [],
    supportedEvidence: 0,
    contradictedEvidence: 0,
    exhaustiveEvidenceScan: false,
    unexaminedWindows: 0,
    questionFocusVerified: false,
    completeAnswerVerified: false,
    independentEvaluation: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  if (
    !Number.isSafeInteger(selector?.maxWindows) ||
    selector.maxWindows < 1 ||
    selector.maxWindows > 8
  )
    return denied("MULTIGRANULARITY_WINDOW_LIMIT_INVALID");
  const results = await Promise.all([
    selectS2ClaimEvidenceWindows(original, question, declarativeClaim, {
      ...selector,
      segmentationMode: "SENTENCES",
    }),
    selectS2ClaimEvidenceWindows(original, question, declarativeClaim, {
      ...selector,
      segmentationMode: "MARKDOWN_BLOCKS",
    }),
  ]);
  if (results.some((x) => x.status === "REJECTED"))
    return denied("MULTIGRANULARITY_SOURCE_OR_TOKENIZER_INVALID");
  const combined = new Map<
    string,
    { window: S2EvidenceWindow; start: number; end: number; sha: string }
  >();
  // Interleave both strategies. If one bound quote completely includes
  // another from the same original, verify the larger context once rather
  // than invoking the reader repeatedly for redundant substrings.
  // Partially overlapping windows are NOT discarded: the missing region
  // might contain conditions, negations, or a different factual relation.
  for (let i = 0; i < selector.maxWindows; i++) {
    for (const result of results) {
      const window = result.windows[i];
      if (!window) continue;
      const literal = window.exactText.trim();
      if (literal.length < 12 || literal.length > 12000) continue;
      const bound = bindS2VerbatimWindowQuote(original, window);
      if (!bound) return denied("MULTIGRANULARITY_ORIGINAL_QUOTE_INVALID");
      const key =
        bound.sourceSha256 + ":" + bound.startUtf16 + ":" + bound.endUtf16;
      const covered = [...combined.values()].some(
        (item) =>
          item.sha === bound.sourceSha256 &&
          bound.startUtf16 >= item.start &&
          bound.endUtf16 <= item.end,
      );
      if (covered) continue;
      for (const [existingKey, item] of combined) {
        if (
          item.sha === bound.sourceSha256 &&
          item.start >= bound.startUtf16 &&
          item.end <= bound.endUtf16
        )
          combined.delete(existingKey);
      }
      combined.set(key, {
        window,
        start: bound.startUtf16,
        end: bound.endUtf16,
        sha: bound.sourceSha256,
      });
    }
  }
  const eligible = [...combined.values()]
    .map((x) => x.window)
    .slice(0, selector.maxWindows * 2);
  if (!eligible.length)
    return {
      ...denied("NO_ATTRIBUTABLE_QUOTE_FROM_BOTH_SEGMENTATIONS"),
      status: "INSUFFICIENT",
    };
  return assessS2ClaimEvidencePortfolio(
    question,
    declarativeClaim,
    [original],
    eligible,
    { ...portfolio, maxWindows: selector.maxWindows * 2 },
  );
}

/**
 * Complete-claim decomposition for the EXISTING source-bound portfolio.
 * Atomic boundaries are supplied by a caller and verified by exact UTF-16
 * coverage, but their semantic atomicity remains UNPROVEN until separately
 * checked. An atom's evidence must entail the entire atom in one original
 * window; keyword overlap or facts assembled across unrelated excerpts are
 * not sufficient. Different atoms may use different authentic originals.
 */
export interface S2PortfolioAtomicClaim {
  readonly claimText: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly windows: readonly Pick<
    S2EvidenceWindow,
    | "sourceId"
    | "sourceSha256"
    | "startUtf16"
    | "endUtf16"
    | "exactText"
    | "productionAdmission"
  >[];
}
export interface S2AtomicPortfolioResult {
  readonly status:
    | "ALL_ATOMS_SOURCE_CANDIDATES_UNVERIFIED"
    | "WITHHELD_UNSUPPORTED_ATOM"
    | "WITHHELD_SOURCE_CONFLICT"
    | "REJECTED"
    | "ERROR";
  readonly reason: string;
  readonly atomResults: readonly {
    readonly claimSha256: string;
    readonly startUtf16: number;
    readonly endUtf16: number;
    readonly review: S2EvidencePortfolioResult;
  }[];
  readonly totalWindows: number;
  readonly verifiedAtoms: number;
  readonly contradictionProposals: number;
  readonly entireClaimTextCovered: boolean;
  readonly everyWindowSourceBoundBeforeInference: boolean;
  readonly independentlyValidatedAtomicity: false;
  readonly questionAnswerSlotsVerified: false;
  readonly sourceAuthorizationReauthenticated: false;
  readonly completeAnswerVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

/**
 * Exhaustively inspect source windows for ALL proposed atoms. Fail closed on
 * invalid source/revision/span and incomplete claim coverage BEFORE the
 * first semantic model call (including an unexamined later atom). Conflict
 * takes priority over support. No early "first support" from the prior
 * portfolio API may be used for this verification path.
 *
 * This is deliberately SHADOW and cannot be fed exploratory review-plan
 * windows into a production writer. Caller scope/current ACL is NOT checked.
 */
export async function assessS2AtomicEvidencePortfolio(
  question: string,
  completeDeclarativeClaim: string,
  originals: readonly S2ExactQuoteOriginal[],
  atoms: readonly S2PortfolioAtomicClaim[],
  config: {
    readonly semantic: S2SemanticEvidenceConfig;
    readonly maxAtoms?: number;
    readonly maxWindowsPerAtom?: number;
    readonly maxTotalWindows?: number;
  },
): Promise<S2AtomicPortfolioResult> {
  const reviews: S2AtomicPortfolioResult["atomResults"][number][] = [];
  const total = Array.isArray(atoms)
    ? atoms.reduce(
        (n, atom) =>
          n + (Array.isArray(atom?.windows) ? atom.windows.length : 0),
        0,
      )
    : 0;
  const make = (
    status: S2AtomicPortfolioResult["status"],
    reason: string,
    covered = false,
    verified = false,
  ): S2AtomicPortfolioResult => ({
    status,
    reason,
    atomResults: reviews,
    totalWindows: total,
    verifiedAtoms: reviews.filter(
      (x) =>
        x.review.status === "SUPPORTED_CANDIDATE" &&
        x.review.exhaustiveEvidenceScan,
    ).length,
    contradictionProposals: reviews.reduce(
      (sum, item) => sum + item.review.contradictedEvidence,
      0,
    ),
    entireClaimTextCovered: covered,
    everyWindowSourceBoundBeforeInference: verified,
    independentlyValidatedAtomicity: false,
    questionAnswerSlotsVerified: false,
    sourceAuthorizationReauthenticated: false,
    completeAnswerVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  const maxAtoms = config?.maxAtoms ?? 6;
  const maxPerAtom = config?.maxWindowsPerAtom ?? 8;
  const maxTotal = config?.maxTotalWindows ?? 32;
  if (
    typeof question !== "string" ||
    !question.trim() ||
    question.length > 2048 ||
    typeof completeDeclarativeClaim !== "string" ||
    !completeDeclarativeClaim.trim() ||
    completeDeclarativeClaim.length > 4096 ||
    !Array.isArray(originals) ||
    originals.length < 1 ||
    originals.length > 16 ||
    !Array.isArray(atoms) ||
    !Number.isSafeInteger(maxAtoms) ||
    maxAtoms < 1 ||
    maxAtoms > 12 ||
    atoms.length < 1 ||
    atoms.length > maxAtoms ||
    !Number.isSafeInteger(maxPerAtom) ||
    maxPerAtom < 1 ||
    maxPerAtom > 16 ||
    !Number.isSafeInteger(maxTotal) ||
    maxTotal < 1 ||
    maxTotal > 64 ||
    total > maxTotal ||
    !config?.semantic?.questionRelevanceProbe?.id?.includes("@") ||
    !config?.semantic?.claimEntailmentProbe?.id?.includes("@")
  )
    return make("REJECTED", "ATOM_OR_REVIEW_BUDGET_INVALID");

  const uniqueSources = new Map<string, S2ExactQuoteOriginal>();
  for (const source of originals) {
    if (!source?.assignedSourceId || uniqueSources.has(source.assignedSourceId))
      return make("REJECTED", "MISSING_OR_DUPLICATE_ORIGINAL_SOURCE");
    uniqueSources.set(source.assignedSourceId, source);
  }
  let consumed = 0;
  const boundAtoms: S2PortfolioAtomicClaim[] = [];
  for (const atom of atoms) {
    if (
      !atom ||
      typeof atom.claimText !== "string" ||
      !atom.claimText.trim() ||
      atom.claimText.length > 2048 ||
      !Number.isSafeInteger(atom.startUtf16) ||
      !Number.isSafeInteger(atom.endUtf16) ||
      atom.startUtf16 < consumed ||
      atom.endUtf16 <= atom.startUtf16 ||
      atom.endUtf16 > completeDeclarativeClaim.length ||
      completeDeclarativeClaim.slice(atom.startUtf16, atom.endUtf16) !==
        atom.claimText ||
      completeDeclarativeClaim.slice(consumed, atom.startUtf16).trim() !== "" ||
      !Array.isArray(atom.windows) ||
      atom.windows.length < 1 ||
      atom.windows.length > maxPerAtom
    )
      return make("REJECTED", "ATOMIC_CLAIM_TEXT_OR_WINDOWS_INCOMPLETE");
    // JS UTF-16 indexes must not split surrogate pairs.
    for (const pos of [atom.startUtf16, atom.endUtf16]) {
      if (
        pos > 0 &&
        pos < completeDeclarativeClaim.length &&
        completeDeclarativeClaim.charCodeAt(pos - 1) >= 0xd800 &&
        completeDeclarativeClaim.charCodeAt(pos - 1) <= 0xdbff &&
        completeDeclarativeClaim.charCodeAt(pos) >= 0xdc00 &&
        completeDeclarativeClaim.charCodeAt(pos) <= 0xdfff
      )
        return make("REJECTED", "ATOM_BOUNDARY_SPLITS_UNICODE");
    }
    const fingerprints = new Set<string>();
    for (const win of atom.windows) {
      const source = win && uniqueSources.get(win.sourceId);
      if (!source || !bindS2VerbatimWindowQuote(source, win))
        return make("REJECTED", "ATOM_WINDOW_NOT_ORIGINAL_BOUND");
      const key = win.sourceSha256 + ":" + win.startUtf16 + ":" + win.endUtf16;
      if (fingerprints.has(key))
        return make("REJECTED", "DUPLICATE_SOURCE_WINDOW_FOR_ATOM");
      fingerprints.add(key);
    }
    boundAtoms.push(atom);
    consumed = atom.endUtf16;
  }
  if (completeDeclarativeClaim.slice(consumed).trim() !== "")
    return make("REJECTED", "TRAILING_UNCHECKED_CLAIM_TEXT");
  // Global source-window validation and full UTF-16 coverage succeeded.
  for (const atom of boundAtoms) {
    const review = await assessS2ClaimEvidencePortfolio(
      question,
      atom.claimText,
      originals,
      atom.windows,
      {
        semantic: config.semantic,
        maxWindows: maxPerAtom,
        verificationMode: "EXHAUSTIVE",
      },
    );
    reviews.push({
      claimSha256: createHash("sha256")
        .update(atom.claimText, "utf8")
        .digest("hex"),
      startUtf16: atom.startUtf16,
      endUtf16: atom.endUtf16,
      review,
    });
    if (review.status === "ERROR" || review.status === "REJECTED")
      return make(review.status, "ATOMIC_SEMANTIC_REVIEW_FAILED", true, true);
  }
  if (
    reviews.some(
      (x) =>
        x.review.status === "CONFLICTING_PROPOSALS" ||
        x.review.status === "CONTRADICTION_PROPOSED",
    )
  )
    return make(
      "WITHHELD_SOURCE_CONFLICT",
      "ONE_OR_MORE_ATOMS_CONTESTED",
      true,
      true,
    );
  if (
    reviews.some(
      (x) =>
        x.review.status !== "SUPPORTED_CANDIDATE" ||
        !x.review.exhaustiveEvidenceScan,
    )
  )
    return make(
      "WITHHELD_UNSUPPORTED_ATOM",
      "ONE_OR_MORE_ATOMS_NOT_SUPPORTED",
      true,
      true,
    );
  return make(
    "ALL_ATOMS_SOURCE_CANDIDATES_UNVERIFIED",
    "EVERY_ATOM_HAS_ORIGINAL_BOUND_MODEL_SUPPORT_BUT_NO_INDEPENDENT_PROOF",
    true,
    true,
  );
}
