import { createHash } from "node:crypto";
import {
  bindS2VerbatimWindowQuote,
  selectS2ClaimEvidenceWindows,
  type S2EvidenceWindowSelectorConfig,
  type S2EvidenceWindowResult,
} from "./s2-evidence-window-selection.js";
import {
  assessS2FrozenReaderChoice,
  freezeS2FrozenReaderChoicePlan,
  type S2FrozenReaderChoiceInput,
  type S2FrozenReaderChoicePlan,
  type S2FrozenReaderChoiceResult,
} from "./s2-frozen-reader-source-bridge.js";
import type { S2ExactQuoteOriginal } from "./s2-exact-quote-attribution.js";
import {
  freezeS2HttpAdmittedReaderPlan,
  type S2HttpFrozenReaderInput,
  type S2HttpFrozenReaderPlan,
} from "./s2-http-admitted-frozen-reader.js";
import type { S2SemanticEvidenceConfig } from "./s2-semantic-evidence.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Shadow-only integration of original-byte bounded window discovery (§32) and
 * original-token/question/claim evaluation (§44). Neither window ranking nor
 * model tokens may create an admitted Fastify hit or a source citation.
 */
export interface S2AtomicWindowInput {
  readonly originalQuestion: string;
  readonly proposedClaim: string;
  /** Scope/ACL, trust, lifecycle and revision were checked by the caller. */
  readonly authorizedOriginal: S2ExactQuoteOriginal;
}

export interface S2AtomicWindowChoice {
  readonly id: string;
  readonly exactSourceQuote: string;
  readonly originalStartUtf16: number;
  readonly originalEndUtf16: number;
  readonly quoteSha256: string;
  readonly frozenReader: S2FrozenReaderChoicePlan;
}

export interface S2AtomicWindowPlan {
  readonly schemaVersion: "akp.s2.atomic-original-window-selection.v1";
  readonly status: "CANDIDATES" | "NO_BOUND_WINDOWS";
  readonly selectorReason: string;
  readonly examined: number;
  readonly overBudget: number;
  readonly originalQuestionSha256: string;
  readonly proposedClaimSha256: string;
  readonly sourceId: string;
  readonly sourceSha256: string;
  readonly tokenizerId: string;
  readonly options: readonly S2AtomicWindowChoice[];
  readonly modelSchema: {
    readonly type: "object";
    readonly additionalProperties: false;
    readonly required: readonly ["windowId", "questionToken", "claimToken"];
    readonly properties: {
      readonly windowId: {
        readonly type: "string";
        readonly enum: readonly string[];
      };
      readonly questionToken: {
        readonly type: "string";
        readonly enum: readonly string[];
      };
      readonly claimToken: {
        readonly type: "string";
        readonly enum: readonly string[];
      };
    };
  };
  readonly authorizationIndependentlyVerified: false;
  readonly independentSemanticProof: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

export interface S2AtomicWindowAssessment {
  readonly status: "HELD" | "SOURCE_BOUND_SEMANTIC_CANDIDATE_ONLY";
  readonly reason: string;
  readonly selectedWindowId: string | null;
  readonly sourceStartUtf16: number | null;
  readonly sourceEndUtf16: number | null;
  readonly reader: S2FrozenReaderChoiceResult | null;
  readonly authorizationIndependentlyVerified: false;
  readonly independentSemanticProof: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

const held = (reason: string): S2AtomicWindowAssessment => ({
  status: "HELD",
  reason,
  selectedWindowId: null,
  sourceStartUtf16: null,
  sourceEndUtf16: null,
  reader: null,
  authorizationIndependentlyVerified: false,
  independentSemanticProof: false,
  productionAdmission: false,
  releaseGateAccepted: false,
});

function schema(
  options: readonly S2AtomicWindowChoice[],
): S2AtomicWindowPlan["modelSchema"] {
  const tokens = new Set<string>(["INSUFFICIENT@NONE"]);
  for (const option of options)
    for (const token of option.frozenReader.tokenSchema.properties.questionToken
      .enum)
      tokens.add(token);
  return {
    type: "object",
    additionalProperties: false,
    required: ["windowId", "questionToken", "claimToken"],
    properties: {
      windowId: { type: "string", enum: ["NONE", ...options.map((o) => o.id)] },
      questionToken: { type: "string", enum: [...tokens] },
      claimToken: { type: "string", enum: [...tokens] },
    },
  };
}

/**
 * Snapshot an immutable, enumerable menu BEFORE inference. The deterministic
 * selector can propose a relevant window but never validate its relation.
 * Unique F3 quote binding must also hold for every offered window.
 */
export async function freezeS2AtomicOriginalWindowPlan(
  input: S2AtomicWindowInput,
  selector: S2EvidenceWindowSelectorConfig,
): Promise<S2AtomicWindowPlan> {
  if (
    !input?.originalQuestion?.trim() ||
    input.originalQuestion.length > 2048 ||
    !input.proposedClaim?.trim() ||
    input.proposedClaim.length > 4096 ||
    !input.authorizedOriginal?.assignedSourceId
  )
    throw Error("S2_ATOMIC_WINDOW_INPUT_INVALID");

  const selected: S2EvidenceWindowResult = await selectS2ClaimEvidenceWindows(
    input.authorizedOriginal,
    input.originalQuestion,
    input.proposedClaim,
    selector,
  );
  if (selected.status === "REJECTED")
    throw Error("S2_ATOMIC_WINDOW_SOURCE_SELECTOR_REJECTED");
  const options: S2AtomicWindowChoice[] = [];
  for (const window of selected.windows) {
    const bound = bindS2VerbatimWindowQuote(input.authorizedOriginal, window);
    if (!bound) continue;
    const readerInput: S2FrozenReaderChoiceInput = {
      originalQuestion: input.originalQuestion,
      proposedClaim: input.proposedClaim,
      exactSourceQuote: bound.quote,
      authorizedOriginal: input.authorizedOriginal,
    };
    const frozenReader = freezeS2FrozenReaderChoicePlan(readerInput);
    if (
      frozenReader.sourceStartUtf16 !== bound.startUtf16 ||
      frozenReader.sourceEndUtf16 !== bound.endUtf16
    )
      throw Error("S2_ATOMIC_WINDOW_BINDING_DRIFT");
    options.push({
      id: "W" + (options.length + 1),
      exactSourceQuote: bound.quote,
      originalStartUtf16: bound.startUtf16,
      originalEndUtf16: bound.endUtf16,
      quoteSha256: sha(bound.quote),
      frozenReader,
    });
  }
  return {
    schemaVersion: "akp.s2.atomic-original-window-selection.v1",
    status: options.length ? "CANDIDATES" : "NO_BOUND_WINDOWS",
    selectorReason: selected.reason,
    examined: selected.examined,
    overBudget: selected.overBudget,
    originalQuestionSha256: sha(input.originalQuestion),
    proposedClaimSha256: sha(input.proposedClaim),
    sourceId: input.authorizedOriginal.assignedSourceId,
    sourceSha256: input.authorizedOriginal.sourceSha256,
    tokenizerId: selector.tokenizerId,
    options,
    modelSchema: schema(options),
    authorizationIndependentlyVerified: false,
    independentSemanticProof: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  };
}

/**
 * Recalculate selector and original-source binding before trusting a model
 * identifier. A tokenizer failure, changed shortlist or forged schema holds.
 * The two model tokens must resolve within the SAME frozen original window;
 * separate question/claim probes still decide whether to propose support.
 */
export async function assessS2AtomicOriginalWindowChoice(
  input: S2AtomicWindowInput,
  plan: S2AtomicWindowPlan,
  output: unknown,
  selector: S2EvidenceWindowSelectorConfig,
  semantic: S2SemanticEvidenceConfig,
): Promise<S2AtomicWindowAssessment> {
  let replay: S2AtomicWindowPlan;
  try {
    replay = await freezeS2AtomicOriginalWindowPlan(input, selector);
  } catch {
    return held("ORIGINAL_WINDOW_REPLAY_FAILED");
  }
  if (JSON.stringify(plan) !== JSON.stringify(replay))
    return held("SOURCE_QUESTION_CLAIM_TOKENIZER_OR_WINDOW_DRIFT");
  if (!output || typeof output !== "object" || Array.isArray(output))
    return held("MODEL_WINDOW_OUTPUT_INVALID");
  const proposal = output as Record<string, unknown>;
  if (
    Object.keys(proposal).sort().join(",") !==
    "claimToken,questionToken,windowId"
  )
    return held("MODEL_WINDOW_OUTPUT_INVALID");
  if (
    proposal.windowId === "NONE" &&
    proposal.questionToken === "INSUFFICIENT@NONE" &&
    proposal.claimToken === "INSUFFICIENT@NONE"
  )
    return held("MODEL_ABSTAINED_WITHOUT_SOURCE_SUPPORT");
  if (typeof proposal.windowId !== "string")
    return held("MODEL_WINDOW_ID_INVALID");
  const chosen = replay.options.find((o) => o.id === proposal.windowId);
  if (!chosen) return held("MODEL_WINDOW_ID_INVALID");
  const result = await assessS2FrozenReaderChoice(
    {
      originalQuestion: input.originalQuestion,
      proposedClaim: input.proposedClaim,
      exactSourceQuote: chosen.exactSourceQuote,
      authorizedOriginal: input.authorizedOriginal,
    },
    chosen.frozenReader,
    {
      questionToken: proposal.questionToken,
      claimToken: proposal.claimToken,
    },
    semantic,
  );
  if (result.status !== "SOURCE_BOUND_SEMANTIC_CANDIDATE_ONLY")
    return {
      ...held("SELECTED_WINDOW_QUESTION_CLAIM_OR_F3_NOT_PROVEN"),
      reader: result,
    };
  if (
    result.originalQuoteStartUtf16 === null ||
    result.originalQuoteEndUtf16 === null ||
    result.originalQuoteStartUtf16 < chosen.originalStartUtf16 ||
    result.originalQuoteEndUtf16 > chosen.originalEndUtf16
  )
    return held("MODEL_WINDOW_QUOTE_OUTSIDE_FROZEN_RANGE");
  return {
    status: "SOURCE_BOUND_SEMANTIC_CANDIDATE_ONLY",
    reason: "EXACT_WINDOW_TWO_SEMANTIC_PROPOSALS_NOT_INDEPENDENT_PROOF",
    selectedWindowId: chosen.id,
    sourceStartUtf16: result.originalQuoteStartUtf16,
    sourceEndUtf16: result.originalQuoteEndUtf16,
    reader: result,
    authorizationIndependentlyVerified: false,
    independentSemanticProof: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  };
}

/**
 * The HTTP composition constrains the atomic selector to the *admitted excerpt*
 * that was already replayed against original bytes by §45. It MUST NOT scan
 * the rest of the document or any exploratory HTTP hit.
 */
export interface S2HttpAtomicWindowPlan {
  readonly schemaVersion: "akp.s2.http-admitted-atomic-original-window.v1";
  readonly http: S2HttpFrozenReaderPlan;
  readonly atomic: S2AtomicWindowPlan;
  readonly sourceAuthorityIndependentlyVerified: false;
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

function admittedAtomicInput(
  input: S2HttpFrozenReaderInput,
  http: S2HttpFrozenReaderPlan,
): S2AtomicWindowInput {
  const from = http.selection.sourceStartUtf16;
  const to = http.selection.sourceEndUtf16;
  if (
    http.originalHttpQuoteReplay !== "REPLAY_VERIFIED" ||
    from >= to ||
    http.selection.sourceSha256 !== input.original.fileSha256
  )
    throw Error("S2_HTTP_ATOMIC_ADMITTED_EXCERPT_INVALID");
  return {
    originalQuestion: input.originalQuestion,
    proposedClaim: input.proposedClaim,
    authorizedOriginal: {
      assignedSourceId: http.originalDocumentKeySha256,
      sourceSha256: input.original.fileSha256,
      exactUtf8Bytes: input.original.fileBytes,
      bodyStartUtf16: from,
      bodyEndUtf16: to,
    },
  };
}

/** Caller passes the authentic Fastify capture; this is not an HTTP client. */
export async function freezeS2HttpAdmittedAtomicWindowPlan(
  input: S2HttpFrozenReaderInput,
  selector: S2EvidenceWindowSelectorConfig,
): Promise<S2HttpAtomicWindowPlan> {
  const http = freezeS2HttpAdmittedReaderPlan(input);
  const atomic = await freezeS2AtomicOriginalWindowPlan(
    admittedAtomicInput(input, http),
    selector,
  );
  return {
    schemaVersion: "akp.s2.http-admitted-atomic-original-window.v1",
    http,
    atomic,
    sourceAuthorityIndependentlyVerified: false,
    productionAdmission: false,
    releaseGateAccepted: false,
  };
}

export async function assessS2HttpAdmittedAtomicWindowChoice(
  input: S2HttpFrozenReaderInput,
  plan: S2HttpAtomicWindowPlan,
  modelOutput: unknown,
  selector: S2EvidenceWindowSelectorConfig,
  semantic: S2SemanticEvidenceConfig,
): Promise<S2AtomicWindowAssessment> {
  let current: S2HttpAtomicWindowPlan;
  try {
    current = await freezeS2HttpAdmittedAtomicWindowPlan(input, selector);
  } catch {
    return held("HTTP_ADMITTED_SOURCE_OR_WINDOW_REPLAY_FAILED");
  }
  if (JSON.stringify(current) !== JSON.stringify(plan))
    return held("HTTP_RECEIPT_OR_ATOMIC_WINDOW_PLAN_DRIFT");
  return assessS2AtomicOriginalWindowChoice(
    admittedAtomicInput(input, current.http),
    current.atomic,
    modelOutput,
    selector,
    semantic,
  );
}
