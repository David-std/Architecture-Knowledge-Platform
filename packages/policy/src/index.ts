import type { TrustTier } from "@akp/contracts";

export type KnowledgeChangeKind =
  | "SOURCE_SUMMARY"
  | "CONCEPT"
  | "EXAMPLE"
  | "WORKFLOW"
  | "PROFILE"
  | "CLAIM"
  | "RULE"
  | "POLICY"
  | "ADR";

export interface ApprovalInput {
  kind: KnowledgeChangeKind;
  trust: TrustTier;
  disputed: boolean;
  touchesNormativePath: boolean;
  validationErrors: number;
  criticalProbeFailures: number;
}

export interface ApprovalDecision {
  decision: "AUTO_APPROVE" | "REVIEW_REQUIRED" | "REJECT";
  reasons: string[];
}

export function decideApproval(input: ApprovalInput): ApprovalDecision {
  const reasons: string[] = [];

  if (input.validationErrors > 0 || input.criticalProbeFailures > 0) {
    return {
      decision: "REJECT",
      reasons: [
        ...(input.validationErrors > 0 ? ["Validation errors are present."] : []),
        ...(input.criticalProbeFailures > 0 ? ["Critical compilation probes failed."] : []),
      ],
    };
  }

  if (
    input.disputed ||
    input.touchesNormativePath ||
    ["CLAIM", "RULE", "POLICY", "ADR"].includes(input.kind)
  ) {
    reasons.push("Normative or disputed knowledge requires human review.");
    return { decision: "REVIEW_REQUIRED", reasons };
  }

  if (input.kind === "SOURCE_SUMMARY" && input.trust === "MACHINE_SUPPORTED") {
    return {
      decision: "AUTO_APPROVE",
      reasons: ["Low-risk source summary passed deterministic gates."],
    };
  }

  return {
    decision: "REVIEW_REQUIRED",
    reasons: ["No explicit low-risk auto-approval policy matched."],
  };
}
