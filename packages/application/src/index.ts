import type {
  ContextPacket,
  IngestRequest,
  SearchRequest,
  SearchHit,
} from "@akp/contracts";
import type { JobId } from "@akp/domain";

export type BootstrapContextMode =
  "COMPACT_AGENT_PACKET" | "FULL_CONTEXT_PACKET";

export interface BootstrapWorkContextSnapshot {
  session: {
    id: string;
    spaceId: string;
    vaultId: string;
    purpose: string;
    contextBudget: number;
    coordinationVersion: number;
  };
  claims: Array<{
    id: string;
    workKey: string;
    ownerId: string;
    status: string;
    fencingToken: number;
    leaseExpiresAt: Date;
  }>;
  events: Array<Record<string, unknown>>;
  snapshotVersion: number;
  eventWindow: {
    total: number;
    returned: number;
    truncated: boolean;
    oldestVersion: number | null;
    latestVersion: number | null;
  };
  contextRevision: {
    status: "CURRENT" | "CHANGED" | "LEGACY_UNPINNED";
    pinned: { revisionSetHash: string } | null;
    current: { revisionSetHash: string };
    changedDimensions: string[];
  };
}

export interface BootstrapKnowledgeProfile {
  source: "DEFAULT" | "DURABLE_REVISION";
  revisionId: string | null;
  profileId: string;
  version: string;
  hash: string;
  policyRevision: string;
  allowedKnowledgeKinds: string[];
  mandatoryKinds: string[];
  progressiveDisclosure: string[];
  promotion: { allowedTargetScopes: string[]; reviewRequired: boolean };
}

export interface BootstrapAuthorizationSnapshot {
  principalId: string;
  principalKind: string;
  principalPolicyRevision: number;
  scopeFingerprint: string;
}

export interface BootstrapContextRequest {
  sessionId: string;
  actorId: string;
  query?: string;
  intent?: string;
  mode?: BootstrapContextMode;
}

export interface PromotionRequestDraft {
  sessionId: string;
  evidenceEventIds: string[];
  summary: string;
  changes: Array<{ path: string; content: string; reason?: string }>;
}

export interface BootstrapContextResult<TContextPacket = unknown> {
  schemaVersion: 1;
  workContext: BootstrapWorkContextSnapshot;
  revisionSetHash: string;
  authorization: BootstrapAuthorizationSnapshot;
  knowledgeProfile: BootstrapKnowledgeProfile;
  context: TContextPacket;
  openWork: BootstrapWorkContextSnapshot["claims"];
  handoffs: Array<Record<string, unknown>>;
  findings: Array<Record<string, unknown>>;
  blockers: Array<Record<string, unknown>>;
  lifecycleGaps: string[];
  suggestedActions: string[];
}

export interface BootstrapContextPorts<TContextPacket = unknown> {
  loadWorkContext(
    sessionId: string,
    actorId: string,
  ): Promise<BootstrapWorkContextSnapshot | null>;
  loadKnowledgeProfile(
    spaceId: string,
    vaultId: string,
    intent: string,
  ): Promise<BootstrapKnowledgeProfile>;
  buildAuthorizedContext(input: {
    query: string;
    intent: string;
    spaceId: string;
    vaultId: string;
    maxTokens: number;
    mode: BootstrapContextMode;
  }): Promise<TContextPacket>;
  verifyRevisionCurrent(
    sessionId: string,
    spaceId: string,
    vaultId: string,
  ): Promise<void>;
}

export class BootstrapContextError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, statusCode: number) {
    super(code);
    this.name = "BootstrapContextError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

function bootstrapContextError(code: string, statusCode: number): Error {
  return new BootstrapContextError(code, statusCode);
}

function workspaceEventsOfType(
  snapshot: BootstrapWorkContextSnapshot,
  eventType: string,
): Array<Record<string, unknown>> {
  return snapshot.events.filter(
    (event) => String(event.event_type ?? event.eventType ?? "") === eventType,
  );
}

export class BootstrapContext<TContextPacket = unknown> {
  constructor(private readonly ports: BootstrapContextPorts<TContextPacket>) {}

  async execute(
    request: BootstrapContextRequest,
    authorization: BootstrapAuthorizationSnapshot,
  ): Promise<BootstrapContextResult<TContextPacket>> {
    const snapshot = await this.ports.loadWorkContext(
      request.sessionId,
      request.actorId,
    );
    if (!snapshot) throw bootstrapContextError("SESSION_NOT_FOUND", 404);
    if (snapshot.contextRevision.status === "CHANGED") {
      throw bootstrapContextError("CONTEXT_REVISION_CHANGED", 409);
    }
    if (!snapshot.contextRevision.pinned) {
      throw bootstrapContextError("CONTEXT_REVISION_PIN_REQUIRED", 409);
    }

    const intent = request.intent?.trim() || "WORKFLOW_EXECUTION";
    const profile = await this.ports.loadKnowledgeProfile(
      snapshot.session.spaceId,
      snapshot.session.vaultId,
      intent,
    );
    const context = await this.ports.buildAuthorizedContext({
      query: request.query?.trim() || snapshot.session.purpose,
      intent,
      spaceId: snapshot.session.spaceId,
      vaultId: snapshot.session.vaultId,
      maxTokens: snapshot.session.contextBudget,
      mode: request.mode ?? "COMPACT_AGENT_PACKET",
    });

    // Context assembly may cross asynchronous index/provider boundaries. Verify
    // the pinned truth set again before handing the packet to an agent.
    await this.ports.verifyRevisionCurrent(
      snapshot.session.id,
      snapshot.session.spaceId,
      snapshot.session.vaultId,
    );

    const openWork = snapshot.claims.filter(
      (claim) => claim.status === "ACTIVE" && claim.leaseExpiresAt > new Date(),
    );
    const handoffs = workspaceEventsOfType(snapshot, "CLAIM_HANDOFF");
    const findings = workspaceEventsOfType(snapshot, "FINDING");
    const blockers = workspaceEventsOfType(snapshot, "BLOCKER");
    const lifecycleGaps = [
      ...profile.mandatoryKinds.map((kind) => `MANDATORY_KIND:${kind}`),
      ...(snapshot.eventWindow.truncated
        ? ["WORKSPACE_EVENT_WINDOW_TRUNCATED"]
        : []),
    ];
    const suggestedActions = [
      ...(blockers.length ? ["RESOLVE_BLOCKERS"] : []),
      ...(openWork.length ? ["CONTINUE_OPEN_WORK"] : ["CLAIM_WORK"]),
      ...(findings.length ? ["REVIEW_FINDINGS"] : []),
      ...(lifecycleGaps.length ? ["RESOLVE_CONTEXT_GAPS"] : []),
    ];

    return {
      schemaVersion: 1,
      workContext: snapshot,
      revisionSetHash: snapshot.contextRevision.pinned.revisionSetHash,
      authorization,
      knowledgeProfile: profile,
      context,
      openWork,
      handoffs,
      findings,
      blockers,
      lifecycleGaps,
      suggestedActions: [...new Set(suggestedActions)],
    };
  }
}

export interface SearchPort {
  search(request: SearchRequest): Promise<SearchHit[]>;
}

export interface ContextPacketPort {
  build(
    request: SearchRequest & { maxTokens: number; intent: string },
  ): Promise<ContextPacket>;
}

export interface IngestJobPort {
  submit(request: IngestRequest, actorId: string): Promise<JobId>;
  status(jobId: JobId): Promise<{ id: JobId; state: string; error?: string }>;
}

export interface AuditPort {
  append(event: {
    actorId: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void>;
}

export class SubmitIngest {
  constructor(
    private readonly jobs: IngestJobPort,
    private readonly audit: AuditPort,
  ) {}

  async execute(request: IngestRequest, actorId: string): Promise<JobId> {
    const jobId = await this.jobs.submit(request, actorId);
    await this.audit.append({
      actorId,
      action: "ingest.submit",
      resourceType: "ingest_job",
      resourceId: jobId,
      metadata: { sourceUri: request.sourceUri, spaceId: request.spaceId },
    });
    return jobId;
  }
}
