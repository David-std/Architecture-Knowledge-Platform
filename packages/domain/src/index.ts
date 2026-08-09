export type Brand<T, B extends string> = T & { readonly __brand: B };
export type SourceId = Brand<string, "SourceId">;
export type DocumentId = Brand<string, "DocumentId">;
export type JobId = Brand<string, "JobId">;
export type ReviewId = Brand<string, "ReviewId">;

export type IngestState =
  | "RECEIVED"
  | "HASHED"
  | "STORED"
  | "NORMALIZING"
  | "ANALYZING"
  | "PLANNED"
  | "DRAFTED"
  | "VALIDATING"
  | "REVIEW_REQUIRED"
  | "AUTO_APPROVED"
  | "MERGED"
  | "INDEXED"
  | "EVALUATED"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "NO_MATERIAL"
  | "QUARANTINED";

const transitions: Readonly<Record<IngestState, readonly IngestState[]>> = {
  RECEIVED: ["HASHED", "FAILED", "CANCELLED", "QUARANTINED"],
  HASHED: ["STORED", "FAILED", "CANCELLED"],
  STORED: ["NORMALIZING", "NO_MATERIAL", "FAILED", "CANCELLED"],
  NORMALIZING: ["ANALYZING", "FAILED", "QUARANTINED"],
  ANALYZING: ["PLANNED", "NO_MATERIAL", "FAILED"],
  PLANNED: ["DRAFTED", "FAILED"],
  DRAFTED: ["VALIDATING", "FAILED"],
  VALIDATING: ["REVIEW_REQUIRED", "AUTO_APPROVED", "FAILED", "QUARANTINED"],
  REVIEW_REQUIRED: ["MERGED", "DRAFTED", "CANCELLED"],
  AUTO_APPROVED: ["MERGED", "FAILED"],
  MERGED: ["INDEXED", "FAILED"],
  INDEXED: ["EVALUATED", "FAILED"],
  EVALUATED: ["COMPLETED", "FAILED"],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  NO_MATERIAL: [],
  QUARANTINED: ["NORMALIZING", "CANCELLED"],
};

export function transitionIngest(
  current: IngestState,
  next: IngestState,
): IngestState {
  if (!transitions[current].includes(next)) {
    throw new Error(`Invalid ingest transition: ${current} -> ${next}`);
  }
  return next;
}

export type RelationType =
  | "derives_from"
  | "supports"
  | "contradicts"
  | "supersedes"
  | "implements"
  | "applies_to"
  | "example_of"
  | "counterexample_of"
  | "uses"
  | "requires"
  | "validated_by"
  | "produces"
  | "consumed_by"
  | "related_to";

export interface KnowledgeRelation {
  from: DocumentId;
  to: DocumentId;
  type: RelationType;
  weight: number;
  source: "frontmatter" | "markdown" | "deterministic" | "reviewed_ai";
}
