export interface AuthorDraftState {
  spaceId: string;
  vaultId: string;
  summary: string;
  path: string;
  reason: string;
  content: string;
  updatedAt: string;
}

export interface AuthorActionState {
  phase: "EDITING" | "SAVED" | "SUBMITTED" | "ERROR";
  reviewId?: string;
  headCommit?: string;
  message?: string;
}
