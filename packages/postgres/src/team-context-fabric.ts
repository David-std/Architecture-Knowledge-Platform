import type { Postgres, PostgresPoolClient } from "./index.js";
import { workspaceContextRevisionState } from "./context-revision-set.js";
import { appendOutboxEvent } from "./outbox.js";
import { appendWorkspaceEventInTransaction } from "./workspace-coordination.js";

export type ExternalObjectAuthority =
  "SYSTEM_OF_RECORD" | "REFERENCE" | "MIRRORED_PROJECTION";

export interface ExternalObjectRefRecord {
  id: string;
  spaceId: string;
  vaultId: string;
  sessionId: string | null;
  provider: string;
  objectType: string;
  externalId: string;
  canonicalUrl: string | null;
  sourceRevision: string | null;
  title: string | null;
  authority: ExternalObjectAuthority;
  workObjectClass: WorkObjectClass | null;
  owners: string[];
  metadata: Record<string, unknown>;
  observedAt: Date;
  updatedAt: Date;
}

export type OfflineDraftStatus =
  "QUEUED" | "RECONCILE_REQUIRED" | "APPLIED" | "DISCARDED";

export type OfflineDraftEventType =
  "FINDING" | "ARTIFACT" | "DECISION_CANDIDATE" | "NOTE";

export interface WorkspaceOfflineDraftRecord {
  id: string;
  clientDraftId: string;
  sessionId: string;
  spaceId: string;
  vaultId: string;
  actorId: string;
  baseRevisionSetHash: string;
  eventType: OfflineDraftEventType;
  payload: Record<string, unknown>;
  status: OfflineDraftStatus;
  queuedAt: Date;
  reconciledAt: Date | null;
  appliedEventId: number | null;
}

export type FederationDiscoveryMode =
  "CATALOG_ONLY" | "REMOTE_QUERY" | "MIRROR_BUNDLE";

export type FederationPeerTrustState = "DISCOVERED" | "APPROVED" | "DISABLED";

export interface ContextFabricPeerRecord {
  id: string;
  organizationId: string;
  spaceId: string | null;
  peerKey: string;
  displayName: string;
  endpoint: string | null;
  discoveryMode: FederationDiscoveryMode;
  trustState: FederationPeerTrustState;
  capabilities: Record<string, unknown>;
  revision: string | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContextFabricPeerRuntimeRecord
  extends ContextFabricPeerRecord {
  credentialRef: string | null;
}

function fabricError(code: string, statusCode: number): Error {
  const error = new Error(code) as Error & {
    code?: string;
    statusCode?: number;
  };
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function recordObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeExternalRef(
  row: Record<string, unknown>,
): ExternalObjectRefRecord {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    vaultId: String(row.vault_id),
    sessionId: row.session_id ? String(row.session_id) : null,
    provider: String(row.provider),
    objectType: String(row.object_type),
    externalId: String(row.external_id),
    canonicalUrl: row.canonical_url ? String(row.canonical_url) : null,
    sourceRevision: row.source_revision ? String(row.source_revision) : null,
    title: row.title ? String(row.title) : null,
    authority: String(row.authority) as ExternalObjectAuthority,
    workObjectClass:
      row.work_object_class === null || row.work_object_class === undefined
        ? null
        : (String(row.work_object_class) as WorkObjectClass),
    owners: Array.isArray(row.owners)
      ? (row.owners as unknown[]).map(String)
      : [],
    metadata: recordObject(row.metadata),
    observedAt: new Date(String(row.observed_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function normalizeOfflineDraft(
  row: Record<string, unknown>,
): WorkspaceOfflineDraftRecord {
  return {
    id: String(row.id),
    clientDraftId: String(row.client_draft_id),
    sessionId: String(row.session_id),
    spaceId: String(row.space_id),
    vaultId: String(row.vault_id),
    actorId: String(row.actor_id),
    baseRevisionSetHash: String(row.base_revision_set_hash),
    eventType: String(row.event_type) as OfflineDraftEventType,
    payload: recordObject(row.payload),
    status: String(row.status) as OfflineDraftStatus,
    queuedAt: new Date(String(row.queued_at)),
    reconciledAt: row.reconciled_at
      ? new Date(String(row.reconciled_at))
      : null,
    appliedEventId:
      row.applied_event_id === null || row.applied_event_id === undefined
        ? null
        : Number(row.applied_event_id),
  };
}

function normalizePeer(row: Record<string, unknown>): ContextFabricPeerRecord {
  return {
    id: String(row.id),
    organizationId: String(row.organization_id),
    spaceId: row.space_id ? String(row.space_id) : null,
    peerKey: String(row.peer_key),
    displayName: String(row.display_name),
    endpoint: row.endpoint ? String(row.endpoint) : null,
    discoveryMode: String(row.discovery_mode) as FederationDiscoveryMode,
    trustState: String(row.trust_state) as FederationPeerTrustState,
    capabilities: recordObject(row.capabilities),
    revision: row.revision ? String(row.revision) : null,
    lastSeenAt: row.last_seen_at ? new Date(String(row.last_seen_at)) : null,
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

async function requireSessionParticipant(
  client: PostgresPoolClient,
  sessionId: string,
  actorId: string,
): Promise<{ organizationId: string; spaceId: string; vaultId: string }> {
  const result = await client.query<{
    organization_id: string;
    space_id: string;
    vault_id: string;
  }>(
    `select sp.organization_id,s.space_id,s.vault_id
       from agent_sessions s
       join spaces sp on sp.id=s.space_id
       join workspace_session_participants p
         on p.session_id=s.id
        and p.user_id=$2
        and p.left_at is null
      where s.id=$1`,
    [sessionId, actorId],
  );
  const row = result.rows[0];
  if (!row) throw fabricError("SESSION_NOT_FOUND", 404);
  return {
    organizationId: row.organization_id,
    spaceId: row.space_id,
    vaultId: row.vault_id,
  };
}

export async function upsertExternalObjectRef(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    provider: string;
    objectType: string;
    externalId: string;
    canonicalUrl?: string | null;
    sourceRevision?: string | null;
    title?: string | null;
    authority?: ExternalObjectAuthority;
    workObjectClass?: WorkObjectClass | null;
    owners?: string[];
    metadata?: Record<string, unknown>;
    observedAt?: Date;
  },
): Promise<ExternalObjectRefRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const scope = await requireSessionParticipant(
      client,
      input.sessionId,
      input.actorId,
    );
    const result = await client.query<Record<string, unknown>>(
      `insert into external_object_refs(
         space_id,vault_id,session_id,provider,object_type,external_id,
         canonical_url,source_revision,title,authority,metadata,owners,
         observed_at,work_object_class
       ) values(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14
       )
       on conflict(vault_id,provider,object_type,external_id) do update
         set session_id=excluded.session_id,
             canonical_url=excluded.canonical_url,
             source_revision=excluded.source_revision,
             title=excluded.title,
             authority=excluded.authority,
             work_object_class=excluded.work_object_class,
             metadata=excluded.metadata,
             owners=excluded.owners,
             observed_at=excluded.observed_at,
             updated_at=now()
       returning *`,
      [
        scope.spaceId,
        scope.vaultId,
        input.sessionId,
        input.provider.trim(),
        input.objectType.trim(),
        input.externalId.trim(),
        input.canonicalUrl?.trim() || null,
        input.sourceRevision?.trim() || null,
        input.title?.trim() || null,
        input.authority ?? "SYSTEM_OF_RECORD",
        JSON.stringify(input.metadata ?? {}),
        JSON.stringify(input.owners ?? []),
        input.observedAt ?? new Date(),
        input.workObjectClass ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw fabricError("EXTERNAL_OBJECT_REF_WRITE_FAILED", 500);
    await appendOutboxEvent(client, {
      eventType: "ExternalObjectRefUpserted",
      resourceId: String(row.id),
      organizationId: scope.organizationId,
      spaceId: scope.spaceId,
      vaultId: scope.vaultId,
      payload: {
        sessionId: input.sessionId,
        actorId: input.actorId,
        provider: String(row.provider),
        objectType: String(row.object_type),
        externalId: String(row.external_id),
        authority: String(row.authority),
        workObjectClass: row.work_object_class
          ? String(row.work_object_class)
          : null,
        owners: Array.isArray(row.owners) ? row.owners.map(String) : [],
        sourceRevision: row.source_revision
          ? String(row.source_revision)
          : null,
      },
    });
    await client.query("commit");
    return normalizeExternalRef(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listExternalObjectRefsForSession(
  db: Postgres,
  sessionId: string,
  actorId: string,
): Promise<ExternalObjectRefRecord[]> {
  const client = await db.pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await requireSessionParticipant(client, sessionId, actorId);
    const result = await client.query<Record<string, unknown>>(
      `select * from external_object_refs
        where session_id=$1
        order by provider,object_type,external_id`,
      [sessionId],
    );
    await client.query("commit");
    return result.rows.map(normalizeExternalRef);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function queueWorkspaceOfflineDraft(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    clientDraftId: string;
    baseRevisionSetHash: string;
    eventType: OfflineDraftEventType;
    payload: Record<string, unknown>;
  },
): Promise<WorkspaceOfflineDraftRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const scope = await requireSessionParticipant(
      client,
      input.sessionId,
      input.actorId,
    );
    const revision = await workspaceContextRevisionState(
      client,
      input.sessionId,
      scope.spaceId,
      scope.vaultId,
    );
    const pinnedHash = revision.pinned?.revisionSetHash ?? null;
    const status: OfflineDraftStatus =
      revision.status === "CURRENT" &&
      pinnedHash !== null &&
      input.baseRevisionSetHash === pinnedHash
        ? "QUEUED"
        : "RECONCILE_REQUIRED";
    const result = await client.query<Record<string, unknown>>(
      `insert into workspace_offline_drafts(
         client_draft_id,session_id,space_id,vault_id,actor_id,
         base_revision_set_hash,event_type,payload,status
       ) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
       on conflict(session_id,actor_id,client_draft_id) do nothing
       returning *`,
      [
        input.clientDraftId,
        input.sessionId,
        scope.spaceId,
        scope.vaultId,
        input.actorId,
        input.baseRevisionSetHash,
        input.eventType,
        JSON.stringify(input.payload),
        status,
      ],
    );
    let row = result.rows[0];
    const inserted = Boolean(row);
    if (!row) {
      const existing = await client.query<Record<string, unknown>>(
        `select * from workspace_offline_drafts
          where session_id=$1 and actor_id=$2 and client_draft_id=$3`,
        [input.sessionId, input.actorId, input.clientDraftId],
      );
      row = existing.rows[0];
      if (!row) throw fabricError("OFFLINE_DRAFT_WRITE_FAILED", 500);
      const samePayload =
        String(row.base_revision_set_hash) === input.baseRevisionSetHash &&
        String(row.event_type) === input.eventType &&
        JSON.stringify(recordObject(row.payload)) ===
          JSON.stringify(input.payload);
      if (!samePayload)
        throw fabricError("OFFLINE_DRAFT_IDEMPOTENCY_CONFLICT", 409);
    }
    if (inserted) {
      await appendOutboxEvent(client, {
        eventType: "OfflineDraftQueued",
        resourceId: String(row.id),
        organizationId: scope.organizationId,
        spaceId: scope.spaceId,
        vaultId: scope.vaultId,
        payload: {
          sessionId: input.sessionId,
          actorId: input.actorId,
          clientDraftId: input.clientDraftId,
          baseRevisionSetHash: input.baseRevisionSetHash,
          eventType: input.eventType,
          status: String(row.status),
        },
      });
    }
    await client.query("commit");
    return normalizeOfflineDraft(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listWorkspaceOfflineDrafts(
  db: Postgres,
  sessionId: string,
  actorId: string,
): Promise<WorkspaceOfflineDraftRecord[]> {
  const client = await db.pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await requireSessionParticipant(client, sessionId, actorId);
    const result = await client.query<Record<string, unknown>>(
      `select * from workspace_offline_drafts
        where session_id=$1 and actor_id=$2
        order by queued_at,id`,
      [sessionId, actorId],
    );
    await client.query("commit");
    return result.rows.map(normalizeOfflineDraft);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function applyWorkspaceOfflineDraft(
  db: Postgres,
  input: { draftId: string; actorId: string },
): Promise<WorkspaceOfflineDraftRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const draftResult = await client.query<Record<string, unknown>>(
      `select * from workspace_offline_drafts
        where id=$1 and actor_id=$2
        for update`,
      [input.draftId, input.actorId],
    );
    const draft = draftResult.rows[0];
    if (!draft) throw fabricError("OFFLINE_DRAFT_NOT_FOUND", 404);
    if (String(draft.status) === "APPLIED") {
      await client.query("commit");
      return normalizeOfflineDraft(draft);
    }
    if (String(draft.status) === "DISCARDED") {
      throw fabricError("OFFLINE_DRAFT_DISCARDED", 409);
    }
    const sessionId = String(draft.session_id);
    const scope = await requireSessionParticipant(
      client,
      sessionId,
      input.actorId,
    );
    const revision = await workspaceContextRevisionState(
      client,
      sessionId,
      scope.spaceId,
      scope.vaultId,
    );
    const pinnedHash = revision.pinned?.revisionSetHash ?? null;
    if (
      revision.status !== "CURRENT" ||
      pinnedHash === null ||
      String(draft.base_revision_set_hash) !== pinnedHash
    ) {
      const conflict = await client.query<Record<string, unknown>>(
        `update workspace_offline_drafts
            set status='RECONCILE_REQUIRED'
          where id=$1
          returning *`,
        [input.draftId],
      );
      const row = conflict.rows[0];
      if (!row) throw fabricError("OFFLINE_DRAFT_WRITE_FAILED", 500);
      await client.query("commit");
      return normalizeOfflineDraft(row);
    }

    const event = await appendWorkspaceEventInTransaction(client, {
      sessionId,
      actorId: input.actorId,
      eventType: String(draft.event_type) as OfflineDraftEventType,
      payload: recordObject(draft.payload),
    });
    const applied = await client.query<Record<string, unknown>>(
      `update workspace_offline_drafts
          set status='APPLIED',reconciled_at=now(),applied_event_id=$2
        where id=$1
        returning *`,
      [input.draftId, Number(event.id)],
    );
    const row = applied.rows[0];
    if (!row) throw fabricError("OFFLINE_DRAFT_WRITE_FAILED", 500);
    await appendOutboxEvent(client, {
      eventType: "OfflineDraftReconciled",
      resourceId: String(row.id),
      organizationId: scope.organizationId,
      spaceId: scope.spaceId,
      vaultId: scope.vaultId,
      payload: {
        sessionId,
        actorId: input.actorId,
        clientDraftId: String(row.client_draft_id),
        baseRevisionSetHash: String(row.base_revision_set_hash),
        appliedEventId: Number(event.id),
        status: "APPLIED",
      },
    });
    await client.query("commit");
    return normalizeOfflineDraft(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertContextFabricPeer(
  db: Postgres,
  input: {
    organizationId: string;
    spaceId?: string | null;
    peerKey: string;
    displayName: string;
    endpoint?: string | null;
    discoveryMode?: FederationDiscoveryMode;
    trustState?: FederationPeerTrustState;
    capabilities: Record<string, unknown>;
    revision?: string | null;
    credentialRef?: string | null;
    lastSeenAt?: Date | null;
  },
): Promise<ContextFabricPeerRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    if (input.spaceId) {
      const scope = await client.query<{ id: string }>(
        `select id from spaces where id=$1 and organization_id=$2`,
        [input.spaceId, input.organizationId],
      );
      if (!scope.rows[0]) {
        throw fabricError("CONTEXT_FABRIC_PEER_SCOPE_MISMATCH", 409);
      }
    }
    const result = await client.query<Record<string, unknown>>(
      `insert into context_fabric_peers(
         organization_id,space_id,peer_key,display_name,endpoint,discovery_mode,
         trust_state,capabilities,revision,credential_ref,last_seen_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11)
       on conflict(organization_id,peer_key) do update
         set space_id=excluded.space_id,
             display_name=excluded.display_name,
             endpoint=excluded.endpoint,
             discovery_mode=excluded.discovery_mode,
             trust_state=excluded.trust_state,
             capabilities=excluded.capabilities,
             revision=excluded.revision,
             credential_ref=excluded.credential_ref,
             last_seen_at=excluded.last_seen_at,
             updated_at=now()
       returning *`,
      [
        input.organizationId,
        input.spaceId ?? null,
        input.peerKey,
        input.displayName,
        input.endpoint?.trim() || null,
        input.discoveryMode ?? "CATALOG_ONLY",
        input.trustState ?? "DISCOVERED",
        JSON.stringify(input.capabilities),
        input.revision?.trim() || null,
        input.credentialRef?.trim() || null,
        input.lastSeenAt ?? null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw fabricError("CONTEXT_FABRIC_PEER_WRITE_FAILED", 500);
    await appendOutboxEvent(client, {
      eventType: "ContextFabricPeerRegistered",
      resourceId: String(row.id),
      organizationId: input.organizationId,
      spaceId: row.space_id ? String(row.space_id) : null,
      payload: {
        peerKey: String(row.peer_key),
        discoveryMode: String(row.discovery_mode),
        trustState: String(row.trust_state),
        revision: row.revision ? String(row.revision) : null,
        boundary: "DISCOVERY_METADATA_ONLY",
      },
    });
    await client.query("commit");
    return normalizePeer(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function listContextFabricPeers(
  db: Postgres,
  organizationId: string,
  spaceIds: string[],
): Promise<ContextFabricPeerRecord[]> {
  const result = await db.pool.query<Record<string, unknown>>(
    `select * from context_fabric_peers
      where organization_id=$1
        and (space_id is null or space_id=any($2::uuid[]))
      order by trust_state,display_name,peer_key`,
    [organizationId, spaceIds],
  );
  return result.rows.map(normalizePeer);
}

export async function getContextFabricPeerRuntime(
  db: Postgres,
  peerId: string,
  authorizedSpaceIds: string[],
): Promise<ContextFabricPeerRuntimeRecord | null> {
  const result = await db.pool.query<Record<string, unknown>>(
    `select p.*
       from context_fabric_peers p
      where p.id=$1
        and (
          p.space_id=any($2::uuid[])
          or (
            p.space_id is null
            and p.organization_id in (
              select distinct organization_id
                from spaces
               where id=any($2::uuid[])
            )
          )
        )
      limit 1`,
    [peerId, authorizedSpaceIds],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...normalizePeer(row),
    credentialRef: row.credential_ref ? String(row.credential_ref) : null,
  };
}

export type WorkObjectClass =
  | "GOAL"
  | "PROJECT"
  | "WORK_ITEM"
  | "PULL_REQUEST"
  | "CODE_REVIEW"
  | "INCIDENT"
  | "CHANGE"
  | "BUILD"
  | "DEPLOYMENT"
  | "ENVIRONMENT"
  | "TEST_RUN"
  | "MEETING"
  | "MESSAGE"
  | "DOCUMENT"
  | "REPOSITORY"
  | "SERVICE";

const WORK_OBJECT_CLASSES: readonly WorkObjectClass[] = [
  "GOAL",
  "PROJECT",
  "WORK_ITEM",
  "PULL_REQUEST",
  "CODE_REVIEW",
  "INCIDENT",
  "CHANGE",
  "BUILD",
  "DEPLOYMENT",
  "ENVIRONMENT",
  "TEST_RUN",
  "MEETING",
  "MESSAGE",
  "DOCUMENT",
  "REPOSITORY",
  "SERVICE",
];

export type WorkActivityAction =
  | "CREATED"
  | "UPDATED"
  | "COMMENTED"
  | "REVIEWED"
  | "APPROVED"
  | "REJECTED"
  | "MERGED"
  | "CLOSED"
  | "REOPENED"
  | "ASSIGNED"
  | "ESCALATED"
  | "DEPLOYED"
  | "ROLLED_BACK"
  | "RESOLVED"
  | "LINKED"
  | "REFERENCED"
  | "CAUSED";

const WORK_ACTIVITY_ACTIONS: readonly WorkActivityAction[] = [
  "CREATED",
  "UPDATED",
  "COMMENTED",
  "REVIEWED",
  "APPROVED",
  "REJECTED",
  "MERGED",
  "CLOSED",
  "REOPENED",
  "ASSIGNED",
  "ESCALATED",
  "DEPLOYED",
  "ROLLED_BACK",
  "RESOLVED",
  "LINKED",
  "REFERENCED",
  "CAUSED",
];

/**
 * How an activity assertion is known.
 *
 * These are different epistemic claims, not confidence levels on one claim.
 * "The deploy log says this deployment happened" and "these two things tend to
 * co-occur" are not the same statement, and collapsing them is how a
 * correlation quietly becomes an architectural fact.
 */
export type WorkActivityDerivation =
  | "SOURCE_EXPLICIT"
  | "OBSERVED_CORRELATION"
  | "MODEL_INFERRED"
  | "HUMAN_ASSERTED"
  | "DYNAMICALLY_PROVEN";

const WORK_ACTIVITY_DERIVATIONS: readonly WorkActivityDerivation[] = [
  "SOURCE_EXPLICIT",
  "OBSERVED_CORRELATION",
  "MODEL_INFERRED",
  "HUMAN_ASSERTED",
  "DYNAMICALLY_PROVEN",
];

export type WorkActivityRelationKind =
  | "DEPENDS_ON"
  | "PROVIDES_TO"
  | "CODE_REPOSITORY"
  | "INCIDENT"
  | "RUNS_ON"
  | "RULE"
  | "RELATED";

const WORK_ACTIVITY_RELATION_KINDS: readonly WorkActivityRelationKind[] = [
  "DEPENDS_ON",
  "PROVIDES_TO",
  "CODE_REPOSITORY",
  "INCIDENT",
  "RUNS_ON",
  "RULE",
  "RELATED",
];

/** Actions that assert a relationship, so they need something to relate to. */
const RELATIONAL_ACTIONS: readonly WorkActivityAction[] = [
  "LINKED",
  "REFERENCED",
  "CAUSED",
  "RESOLVED",
];

/**
 * Only these support a causal claim.
 *
 * An observation of ordering and a model's guess are evidence that something
 * might be worth investigating; neither is evidence that one thing brought
 * about another. The database enforces this too, but rejecting it here gives
 * the caller a usable error instead of a constraint violation.
 */
const CAUSALITY_SUPPORTING_DERIVATIONS: readonly WorkActivityDerivation[] = [
  "SOURCE_EXPLICIT",
  "HUMAN_ASSERTED",
  "DYNAMICALLY_PROVEN",
];

export interface WorkActivityEventRecord {
  id: string;
  spaceId: string;
  vaultId: string;
  objectRefId: string;
  targetRefId: string | null;
  sessionId: string | null;
  actorPrincipalId: string | null;
  actorExternalId: string | null;
  action: WorkActivityAction;
  occurredAt: Date;
  recordedAt: Date;
  sourceSystem: string;
  derivation: WorkActivityDerivation;
  relationKind: WorkActivityRelationKind | null;
  evidenceRefs: string[];
  payload: Record<string, unknown>;
}

export function isWorkObjectClass(value: string): value is WorkObjectClass {
  return (WORK_OBJECT_CLASSES as readonly string[]).includes(value);
}

export function isWorkActivityAction(
  value: string,
): value is WorkActivityAction {
  return (WORK_ACTIVITY_ACTIONS as readonly string[]).includes(value);
}

export function isWorkActivityDerivation(
  value: string,
): value is WorkActivityDerivation {
  return (WORK_ACTIVITY_DERIVATIONS as readonly string[]).includes(value);
}

export function isWorkActivityRelationKind(
  value: string,
): value is WorkActivityRelationKind {
  return (WORK_ACTIVITY_RELATION_KINDS as readonly string[]).includes(value);
}

function normalizeActivity(
  row: Record<string, unknown>,
): WorkActivityEventRecord {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    vaultId: String(row.vault_id),
    objectRefId: String(row.object_ref_id),
    targetRefId: row.target_ref_id === null ? null : String(row.target_ref_id),
    sessionId: row.session_id === null ? null : String(row.session_id),
    actorPrincipalId:
      row.actor_principal_id === null ? null : String(row.actor_principal_id),
    actorExternalId:
      row.actor_external_id === null ? null : String(row.actor_external_id),
    action: String(row.action) as WorkActivityAction,
    occurredAt: new Date(String(row.occurred_at)),
    recordedAt: new Date(String(row.recorded_at)),
    sourceSystem: String(row.source_system),
    derivation: String(row.derivation) as WorkActivityDerivation,
    relationKind:
      row.relation_kind === null || row.relation_kind === undefined
        ? null
        : (String(row.relation_kind) as WorkActivityRelationKind),
    evidenceRefs: Array.isArray(row.evidence_refs)
      ? (row.evidence_refs as unknown[]).map(String)
      : [],
    payload:
      row.payload && typeof row.payload === "object"
        ? (row.payload as Record<string, unknown>)
        : {},
  };
}

/**
 * Record one observation about a work object.
 *
 * Activity is history, so this only ever appends. Correcting an earlier
 * observation means recording a later one that says so, which keeps the record
 * of what was believed when.
 */
export async function recordWorkActivity(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    objectRefId: string;
    targetRefId?: string | null;
    action: WorkActivityAction;
    occurredAt: Date;
    sourceSystem: string;
    derivation: WorkActivityDerivation;
    relationKind?: WorkActivityRelationKind | null;
    actorPrincipalId?: string | null;
    actorExternalId?: string | null;
    evidenceRefs?: string[];
    payload?: Record<string, unknown>;
  },
): Promise<WorkActivityEventRecord> {
  if (!isWorkActivityAction(input.action)) {
    throw fabricError("INVALID_WORK_ACTIVITY_ACTION", 400);
  }
  if (!isWorkActivityDerivation(input.derivation)) {
    throw fabricError("INVALID_WORK_ACTIVITY_DERIVATION", 400);
  }
  if (
    input.action === "CAUSED" &&
    !CAUSALITY_SUPPORTING_DERIVATIONS.includes(input.derivation)
  ) {
    throw fabricError("WORK_ACTIVITY_CAUSALITY_UNSUPPORTED", 422);
  }
  if (RELATIONAL_ACTIONS.includes(input.action) && !input.targetRefId) {
    throw fabricError("WORK_ACTIVITY_TARGET_REQUIRED", 400);
  }
  if (
    input.relationKind &&
    (!isWorkActivityRelationKind(input.relationKind) ||
      !input.targetRefId ||
      !["LINKED", "REFERENCED"].includes(input.action))
  ) {
    throw fabricError("INVALID_WORK_ACTIVITY_RELATION_KIND", 400);
  }
  if (!input.actorPrincipalId && !input.actorExternalId) {
    throw fabricError("WORK_ACTIVITY_ACTOR_REQUIRED", 400);
  }
  const sourceSystem = input.sourceSystem.trim();
  if (!sourceSystem || sourceSystem.length > 80) {
    throw fabricError("INVALID_WORK_ACTIVITY_SOURCE_SYSTEM", 400);
  }
  if (Number.isNaN(input.occurredAt.getTime())) {
    throw fabricError("INVALID_WORK_ACTIVITY_TIMESTAMP", 400);
  }

  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const scope = await requireSessionParticipant(
      client,
      input.sessionId,
      input.actorId,
    );
    // Both endpoints of the assertion must be objects this session's vault
    // already projects. Activity cannot introduce a reference to something the
    // caller was never authorized to see.
    const refIds = [input.objectRefId, input.targetRefId].filter(
      (value): value is string => Boolean(value),
    );
    const refs = await client.query<{ id: string }>(
      `select id from external_object_refs
        where vault_id=$1 and id = any($2::uuid[])`,
      [scope.vaultId, refIds],
    );
    if (refs.rowCount !== new Set(refIds).size) {
      throw fabricError("EXTERNAL_OBJECT_REF_NOT_FOUND", 404);
    }

    const inserted = await client.query<Record<string, unknown>>(
      `insert into work_activity_events(
         space_id,vault_id,object_ref_id,target_ref_id,session_id,
         actor_principal_id,actor_external_id,action,occurred_at,
         source_system,derivation,relation_kind,evidence_refs,payload
       ) values(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb
       )
       returning *`,
      [
        scope.spaceId,
        scope.vaultId,
        input.objectRefId,
        input.targetRefId ?? null,
        input.sessionId,
        input.actorPrincipalId ?? null,
        input.actorExternalId?.trim() || null,
        input.action,
        input.occurredAt,
        sourceSystem,
        input.derivation,
        input.relationKind ?? null,
        JSON.stringify(input.evidenceRefs ?? []),
        JSON.stringify(input.payload ?? {}),
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw fabricError("WORK_ACTIVITY_WRITE_FAILED", 500);
    // No integration event. Activity is an observation log, and nothing
    // downstream reacts to a single observation; inventing an event family
    // with no consumer would add a durable contract we would then have to
    // keep. The durable record is the row itself.
    await client.query("commit");
    return normalizeActivity(row);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * The activity a session may see, newest first.
 *
 * Scoped through session participation like every other workspace read, so an
 * actor cannot page through another vault's work history.
 */
export async function listWorkActivityForSession(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    objectRefId?: string;
    limit?: number;
  },
): Promise<WorkActivityEventRecord[]> {
  const limit = Math.min(Math.max(input.limit ?? 100, 1), 500);
  const client = await db.pool.connect();
  try {
    await client.query("begin read only");
    const scope = await requireSessionParticipant(
      client,
      input.sessionId,
      input.actorId,
    );
    const result = await client.query<Record<string, unknown>>(
      `select * from work_activity_events
        where vault_id=$1
          and ($2::uuid is null
               or object_ref_id=$2::uuid
               or target_ref_id=$2::uuid)
        order by occurred_at desc, id desc
        limit $3`,
      [scope.vaultId, input.objectRefId ?? null, limit],
    );
    await client.query("commit");
    return result.rows.map(normalizeActivity);
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
