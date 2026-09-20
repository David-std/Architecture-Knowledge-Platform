export interface DecisionReadinessInput {
  candidateStatus: string;
  alternatives: Array<{ status: string }>;
  objections: Array<{ status: string }>;
  consultations: Array<{ status: string }>;
  capturedEventId?: string | null;
  reviewId?: string | null;
}

export interface DecisionReadiness {
  editable: boolean;
  consideredAlternatives: number;
  respondedConsultations: number;
  openObjections: number;
  selectionReady: boolean;
  captureReady: boolean;
  promotionReady: boolean;
}

export function decisionReadiness(
  input: DecisionReadinessInput,
): DecisionReadiness {
  const editable = ["DRAFT", "CONSULTATION"].includes(input.candidateStatus);
  const consideredAlternatives = input.alternatives.filter(
    (alternative) => alternative.status === "CONSIDERED",
  ).length;
  const respondedConsultations = input.consultations.filter(
    (consultation) => consultation.status === "RESPONDED",
  ).length;
  const openObjections = input.objections.filter(
    (objection) => objection.status === "OPEN",
  ).length;

  return {
    editable,
    consideredAlternatives,
    respondedConsultations,
    openObjections,
    selectionReady:
      editable &&
      consideredAlternatives >= 2 &&
      respondedConsultations >= 1 &&
      openObjections === 0,
    captureReady: input.candidateStatus === "READY_FOR_REVIEW",
    promotionReady:
      input.candidateStatus === "READY_FOR_REVIEW" &&
      Boolean(input.capturedEventId) &&
      !input.reviewId,
  };
}
