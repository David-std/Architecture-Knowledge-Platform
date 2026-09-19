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

export type SourceConnectorPermissionFidelity =
  "SOURCE_ACL_EXACT" | "SOURCE_ACL_MAPPED" | "WORKSPACE_WIDE" | "NONE";

export interface SourceConnectorDescriptor {
  schemaVersion: 1;
  connectorId: string;
  sourceSystem: string;
  objectTypes: string[];
  incremental: {
    cursor: boolean;
    webhook: boolean;
  };
  permissionFidelity: SourceConnectorPermissionFidelity;
  replication: "FULL_MIRROR" | "METADATA_ONLY" | "REFERENCE";
  dataResidency: "LOCAL" | "ORG" | "EXTERNAL";
  attachments: {
    supported: boolean;
    maxBytes?: number;
  };
  rateLimit:
    | { kind: "NONE" }
    | {
        kind: "DECLARED";
        requestsPerMinute: number;
        burst?: number;
      };
  deletionPropagation: "TOMBSTONE" | "NONE";
  sourceVersioning: boolean;
  contentTrust: "UNTRUSTED_EXTERNAL";
}

export interface SourceConnectorCheckpoint {
  kind: "REVISION" | "OPAQUE_CURSOR";
  value: string;
}

export interface SourceConnectorObject {
  objectId: string;
  objectType: string;
  sourceSystem: string;
  sourceVersion: string;
  operation: "UPSERT" | "DELETE";
  path?: string;
  title?: string;
  content?: string;
  contentType?: string;
  contentTrust: "UNTRUSTED_EXTERNAL";
  permissions: {
    fidelity: SourceConnectorPermissionFidelity;
    uncertain: boolean;
    aclFingerprint?: string;
  };
  attachments: Array<{
    id: string;
    name: string;
    contentType?: string;
    sizeBytes?: number;
  }>;
  metadata: Record<string, unknown>;
}

export interface SourceConnectorPullRequest {
  from?: SourceConnectorCheckpoint;
  /** Fixed upper-bound checkpoint captured before pagination starts. */
  target: SourceConnectorCheckpoint;
  pageCursor?: string;
  limit: number;
}

export interface SourceConnectorPullPage {
  objects: SourceConnectorObject[];
  target: SourceConnectorCheckpoint;
  nextPageCursor: string | null;
  completed: boolean;
}

export interface SourceConnectorWebhookRequest {
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string | string[] | undefined>>;
}

export interface SourceConnectorWebhookVerification {
  accepted: boolean;
  eventId?: string;
  checkpoint?: SourceConnectorCheckpoint;
  reason?: string;
}

export interface SourceConnectorPort {
  describe(): Promise<SourceConnectorDescriptor>;
  checkpoint(): Promise<SourceConnectorCheckpoint>;
  pull(request: SourceConnectorPullRequest): Promise<SourceConnectorPullPage>;
  fetchById?(
    objectId: string,
    checkpoint?: SourceConnectorCheckpoint,
  ): Promise<SourceConnectorObject | null>;
  verifyWebhook?(
    request: SourceConnectorWebhookRequest,
  ): Promise<SourceConnectorWebhookVerification>;
}


export const ASSURANCE_DETECTORS = [
  "GROUNDING",
  "FRESHNESS",
  "CONTRADICTION",
  "DUPLICATE_IDENTITY",
  "GRAPH_HEALTH",
  "TEMPORAL_CONSISTENCY",
  "CODE_GRAPH_FRESHNESS",
  "LINK_ORPHAN",
  "SYNTHESIS_ACCESS_BOUNDARY",
  "CONNECTOR_DELETION",
  "CONNECTOR_FRESHNESS",
  "CONNECTOR_ACL_DRIFT",
  "GRAPH_DISAGREEMENT",
  "ORPHAN_WORK",
  "EXPIRED_CLAIM",
  "STALE_HANDOFF",
  "UNSUPPORTED_CAUSALITY",
] as const;

export type AssuranceDetector = (typeof ASSURANCE_DETECTORS)[number];
export type AssuranceSeverity = "INFO" | "WARN" | "HIGH" | "CRITICAL";

export interface AssuranceFinding {
  detector: AssuranceDetector;
  severity: AssuranceSeverity;
  code: string;
  subjectKind: string;
  subjectId: string;
  summary: string;
  evidenceRefs: string[];
  metadata: Record<string, unknown>;
}

export interface AssuranceRunCursor {
  detectorIndex: number;
  detectorCursor?: string;
}

export interface AssuranceRun {
  id: string;
  spaceId: string;
  vaultId: string;
  trigger:
    | "MANUAL"
    | "SCHEDULED"
    | "SOURCE_CHANGE"
    | "INDEX_CHANGE"
    | "CONNECTOR_EVENT";
  detectors: AssuranceDetector[];
  status: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  idempotencyKey: string;
  cursor: AssuranceRunCursor;
  attempts: number;
  maxAttempts: number;
  leaseOwner: string | null;
  leaseToken: number;
  leaseExpiresAt: Date | null;
  cancelRequestedAt: Date | null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
}
