import type { S2ExactQuoteOriginal } from "./s2-exact-quote-attribution.js";
import {
  assessS2QuoteSemantics,
  type S2SemanticEvidenceAssessment,
  type S2SemanticEvidenceConfig,
} from "./s2-semantic-evidence.js";
import {
  selectS2ClaimEvidenceWindows,
  type S2EvidenceWindowSelectorConfig,
} from "./s2-evidence-window-selection.js";

/**
 * Aggregate independent quote-bound diagnostics across a small group of
 * contiguous source windows. A contradiction in ANY inspected window vetoes
 * a positive one. This is not a proof of exhaustiveness across a full corpus.
 */
export interface S2WindowClaimAssessment {
  readonly status:
    | "SUPPORTED_CANDIDATE"
    | "CONTRADICTED"
    | "INSUFFICIENT"
    | "ERROR"
    | "REJECTED";
  readonly reason: string;
  readonly selectedWindows: number;
  readonly evaluatedWindows: number;
  readonly results: readonly S2SemanticEvidenceAssessment[];
  readonly productionAdmission: false;
  readonly releaseGateAccepted: false;
}

export async function assessS2WindowedClaim(
  originalQuestion: string,
  claim: string,
  source: S2ExactQuoteOriginal,
  selector: S2EvidenceWindowSelectorConfig,
  semantic: S2SemanticEvidenceConfig,
): Promise<S2WindowClaimAssessment> {
  const assessments: S2SemanticEvidenceAssessment[] = [];
  const make = (
    status: S2WindowClaimAssessment["status"],
    reason: string,
    selectedWindows = 0,
  ): S2WindowClaimAssessment => ({
    status,
    reason,
    selectedWindows,
    evaluatedWindows: assessments.length,
    results: assessments,
    productionAdmission: false,
    releaseGateAccepted: false,
  });
  const selection = await selectS2ClaimEvidenceWindows(
    source,
    originalQuestion,
    claim,
    selector,
  );
  if (selection.status === "REJECTED")
    return make("REJECTED", selection.reason);
  if (selection.status !== "CANDIDATES")
    return make("INSUFFICIENT", selection.reason);
  // A bounded source-window proposal has no authority until original SHA,
  // quoted span, question relevance and full claim have all been checked.
  for (const window of selection.windows) {
    const verdict = await assessS2QuoteSemantics(
      originalQuestion,
      {
        answerText: claim,
        evidenceQuote: window.exactText,
        sourceId: "UNTRUSTED_CANDIDATE",
        abstained: false,
      },
      [source],
      semantic,
    );
    assessments.push(verdict);
  }
  const statuses = assessments.map((a) => a.status);
  const selectedWindows = selection.windows.length;
  if (statuses.includes("ERROR"))
    return make("ERROR", "SOURCE_WINDOW_SEMANTIC_ERROR", selectedWindows);
  if (statuses.includes("REJECTED"))
    return make("REJECTED", "SOURCE_WINDOW_BINDING_REJECTED", selectedWindows);
  if (
    statuses.includes("CONTRADICTED") &&
    statuses.includes("SUPPORTED_CANDIDATE")
  )
    return make(
      "CONTRADICTED",
      "CONFLICTING_SOURCE_WINDOW_EVIDENCE",
      selectedWindows,
    );
  if (statuses.includes("CONTRADICTED"))
    return make(
      "CONTRADICTED",
      "CLAIM_CONTRADICTED_IN_SOURCE_WINDOW",
      selectedWindows,
    );
  if (statuses.includes("SUPPORTED_CANDIDATE"))
    return make(
      "SUPPORTED_CANDIDATE",
      "WINDOWED_SUPPORT_REQUIRES_INDEPENDENT_CONFIRMATION",
      selectedWindows,
    );
  return make("INSUFFICIENT", "NO_WINDOW_VERIFIES_FULL_CLAIM", selectedWindows);
}
