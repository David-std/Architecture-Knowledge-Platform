import type { Postgres, PostgresPoolClient } from "./index.js";
import { workspaceContextRevisionState } from "./context-revision-set.js";
import { appendOutboxEvent } from "./outbox.js";

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
         canonical_url,source_revision,title,authority,metadata,observed_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
       on conflict(vault_id,provider,object_type,external_id) do update
         set session_id=excluded.session_id,
             canonical_url=excluded.canonical_url,
             source_revision=excluded.source_revision,
             title=excluded.title,
             authority=excluded.authority,
             metadata=excluded.metadata,
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
        input.observedAt ?? new Date(),
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

    const eventResult = await client.query<Record<string, unknown>>(
      `with bumped as (
         update agent_sessions
            set coordination_version=coordination_version+1,
                updated_at=now()
          where id=$1
          returning space_id,vault_id,coordination_version
       )
       insert into workspace_events(
         session_id,space_id,vault_id,actor_id,event_type,payload,session_version
       )
       select $1,bumped.space_id,bumped.vault_id,$2,$3,$4::jsonb,
              bumped.coordination_version
         from bumped
       returning *`,
      [
        sessionId,
        input.actorId,
        String(draft.event_type),
        JSON.stringify(recordObject(draft.payload)),
      ],
    );
    const event = eventResult.rows[0];
    if (!event) throw fabricError("WORKSPACE_EVENT_APPEND_FAILED", 500);
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
    capabilities?: Record<string, unknown>;
    revision?: string | null;
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
         trust_state,capabilities,revision,last_seen_at
       ) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
       on conflict(organization_id,peer_key) do update
         set space_id=excluded.space_id,
             display_name=excluded.display_name,
             endpoint=excluded.endpoint,
             discovery_mode=excluded.discovery_mode,
             trust_state=excluded.trust_state,
             capabilities=excluded.capabilities,
             revision=excluded.revision,
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
        JSON.stringify(input.capabilities ?? {}),
        input.revision?.trim() || null,
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
