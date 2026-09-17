import type { Postgres, PostgresPoolClient } from "./index.js";
import {
  assertWorkspaceContextRevisionCurrent,
  pinWorkspaceContextRevisionSet,
  workspaceContextRevisionState,
  type ContextRevisionSet,
} from "./context-revision-set.js";
import { appendOutboxEvent, type IntegrationEventType } from "./outbox.js";

export type WorkspaceParticipantRole = "OWNER" | "PARTICIPANT";
export const PROMOTABLE_WORKSPACE_EVENT_TYPES = [
  "FINDING",
  "ARTIFACT",
  "DECISION_CANDIDATE",
] as const;
export type PromotableWorkspaceEventType =
  (typeof PROMOTABLE_WORKSPACE_EVENT_TYPES)[number];
export type WorkspaceEventType =
  | "SESSION_CREATED"
  | "PARTICIPANT_JOINED"
  | "CLAIM_ACQUIRED"
  | "CLAIM_HEARTBEAT"
  | "CLAIM_RELEASED"
  | "CLAIM_HANDOFF"
  | "FINDING"
  | "BLOCKER"
  | "QUESTION"
  | "ARTIFACT"
  | "DECISION_CANDIDATE"
  | "PROMOTION_REQUESTED"
  | "NOTE";

export type WorkspaceUserEventType = Exclude<
  WorkspaceEventType,
  | "SESSION_CREATED"
  | "PARTICIPANT_JOINED"
  | "CLAIM_ACQUIRED"
  | "CLAIM_HEARTBEAT"
  | "CLAIM_RELEASED"
  | "CLAIM_HANDOFF"
>;

function workspaceIntegrationEventType(
  eventType: WorkspaceEventType,
): IntegrationEventType | null {
  switch (eventType) {
    case "SESSION_CREATED":
      return "WorkspaceSessionCreated";
    case "CLAIM_ACQUIRED":
    case "CLAIM_HEARTBEAT":
    case "CLAIM_RELEASED":
      return "WorkspaceClaimUpdated";
    case "CLAIM_HANDOFF":
      return "WorkspaceHandoffCreated";
    case "PROMOTION_REQUESTED":
      return "WorkspacePromotionRequested";
    default:
      return null;
  }
}

export interface WorkspaceSessionAccess {
  id: string;
  spaceId: string;
  vaultId: string;
  actorId: string | null;
  projectId: string | null;
  purpose: string;
  contextBudget: number;
  coordinationVersion: number;
  state: Record<string, unknown>;
  contextRevisionSet: ContextRevisionSet | null;
  contextRevisionSetHash: string | null;
  role: WorkspaceParticipantRole;
}

export interface WorkspaceClaim {
  id: string;
  sessionId: string;
  workKey: string;
  ownerId: string;
  status: "ACTIVE" | "RELEASED" | "COMPLETED";
  fencingToken: number;
  leaseExpiresAt: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

function workspaceError(code: string, statusCode: number): Error {
  const error = new Error(code) as Error & {
    code?: string;
    statusCode?: number;
  };
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizeSession(
  row: Record<string, unknown>,
): WorkspaceSessionAccess {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    vaultId: String(row.vault_id),
    actorId: row.actor_id ? String(row.actor_id) : null,
    projectId: row.project_id ? String(row.project_id) : null,
    purpose: String(row.purpose),
    contextBudget: Number(row.context_budget),
    coordinationVersion: Number(row.coordination_version ?? 0),
    state:
      row.state && typeof row.state === "object"
        ? (row.state as Record<string, unknown>)
        : {},
    contextRevisionSet:
      row.context_revision_set && typeof row.context_revision_set === "object"
        ? (row.context_revision_set as ContextRevisionSet)
        : null,
    contextRevisionSetHash: row.context_revision_set_hash
      ? String(row.context_revision_set_hash)
      : null,
    role: String(row.participant_role) as WorkspaceParticipantRole,
  };
}

function normalizeClaim(row: Record<string, unknown>): WorkspaceClaim {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    workKey: String(row.work_key),
    ownerId: String(row.owner_id),
    status: String(row.status) as WorkspaceClaim["status"],
    fencingToken: Number(row.fencing_token),
    leaseExpiresAt: new Date(String(row.lease_expires_at)),
    version: Number(row.version),
    createdAt: new Date(String(row.created_at)),
    updatedAt: new Date(String(row.updated_at)),
  };
}

function assertLeaseSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 15 || value > 900) {
    throw workspaceError("INVALID_CLAIM_LEASE", 400);
  }
}

type WorkspaceWorkScope =
  { mode: "EXACT"; key: string } | { mode: "PREFIX"; key: string };

const EXACT_WORK_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const PREFIX_WORK_KEY_PATTERN = /^(.+)\/\*\*$/;

export function workspaceWorkScope(value: string): WorkspaceWorkScope | null {
  if (value.length < 1 || value.length > 200) return null;
  const prefix = PREFIX_WORK_KEY_PATTERN.exec(value);
  if (prefix) {
    const key = prefix[1];
    if (!key || key.length > 197 || !EXACT_WORK_KEY_PATTERN.test(key))
      return null;
    const segments = key.split("/");
    if (
      segments.some(
        (segment) => !segment || segment === "." || segment === "..",
      )
    ) {
      return null;
    }
    return { mode: "PREFIX", key };
  }
  return EXACT_WORK_KEY_PATTERN.test(value)
    ? { mode: "EXACT", key: value }
    : null;
}

export function isWorkspaceWorkKey(value: string): boolean {
  return workspaceWorkScope(value) !== null;
}

function requiredWorkScope(value: string): WorkspaceWorkScope {
  const scope = workspaceWorkScope(value);
  if (!scope) throw workspaceError("INVALID_WORK_KEY", 400);
  return scope;
}

function workspaceScopesOverlap(
  left: WorkspaceWorkScope,
  right: WorkspaceWorkScope,
): boolean {
  if (left.mode === "EXACT" && right.mode === "EXACT") {
    return left.key === right.key;
  }
  if (left.mode === "PREFIX") {
    if (right.key === left.key || right.key.startsWith(`${left.key}/`))
      return true;
  }
  if (right.mode === "PREFIX") {
    if (left.key === right.key || left.key.startsWith(`${right.key}/`))
      return true;
  }
  return false;
}

async function appendCoordinationEvent(
  client: PostgresPoolClient,
  input: {
    sessionId: string;
    actorId: string | null;
    eventType: WorkspaceEventType;
    payload: Record<string, unknown>;
    claimId?: string | null;
  },
): Promise<Record<string, unknown>> {
  const bumped = await client.query<Record<string, unknown>>(
    `update agent_sessions
        set coordination_version=coordination_version+1,
            updated_at=now()
      where id=$1
      returning space_id,vault_id,coordination_version`,
    [input.sessionId],
  );
  const session = bumped.rows[0];
  if (!session || !session.vault_id) {
    throw workspaceError("SESSION_NOT_FOUND", 404);
  }
  const inserted = await client.query<Record<string, unknown>>(
    `insert into workspace_events(
       session_id,space_id,vault_id,actor_id,claim_id,event_type,payload,session_version
     ) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     returning *`,
    [
      input.sessionId,
      session.space_id,
      session.vault_id,
      input.actorId,
      input.claimId ?? null,
      input.eventType,
      JSON.stringify(input.payload),
      session.coordination_version,
    ],
  );
  const row = inserted.rows[0];
  if (!row) throw workspaceError("WORKSPACE_EVENT_APPEND_FAILED", 500);
  const integrationEventType = workspaceIntegrationEventType(input.eventType);
  if (integrationEventType) {
    const organization = await client.query<{ organization_id: string }>(
      "select organization_id from spaces where id=$1",
      [String(session.space_id)],
    );
    const organizationId = organization.rows[0]?.organization_id;
    if (!organizationId) {
      throw workspaceError("WORKSPACE_EVENT_ORGANIZATION_NOT_FOUND", 500);
    }
    await appendOutboxEvent(client, {
      eventType: integrationEventType,
      resourceId: `workspace-event:${String(row.id)}`,
      organizationId,
      spaceId: String(session.space_id),
      vaultId: String(session.vault_id),
      correlationId: input.sessionId,
      causationId: input.claimId ?? null,
      payload: {
        sessionId: input.sessionId,
        workspaceEventId: String(row.id),
        sessionVersion: Number(row.session_version),
        workspaceEventType: input.eventType,
        actorId: input.actorId,
        claimId: input.claimId ?? null,
        data: input.payload,
      },
    });
  }
  return row;
}

export async function createWorkspaceSession(
  db: Postgres,
  input: {
    spaceId: string;
    vaultId: string;
    actorId: string;
    projectId?: string | null;
    purpose: string;
    contextBudget: number;
  },
): Promise<WorkspaceSessionAccess> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const created = await client.query<Record<string, unknown>>(
      `insert into agent_sessions(
         space_id,vault_id,actor_id,project_id,purpose,context_budget,state
       ) values($1,$2,$3,$4,$5,$6,$7::jsonb)
       returning *`,
      [
        input.spaceId,
        input.vaultId,
        input.actorId,
        input.projectId ?? null,
        input.purpose,
        input.contextBudget,
        JSON.stringify({ status: "ACTIVE", createdBy: "api" }),
      ],
    );
    const row = created.rows[0];
    if (!row) throw workspaceError("WORKSPACE_SESSION_CREATE_FAILED", 500);
    const pinnedContext = await pinWorkspaceContextRevisionSet(
      client,
      String(row.id),
      input.spaceId,
      input.vaultId,
    );
    await client.query(
      `insert into workspace_session_participants(session_id,user_id,role)
       values($1,$2,'OWNER')`,
      [row.id, input.actorId],
    );
    const event = await appendCoordinationEvent(client, {
      sessionId: String(row.id),
      actorId: input.actorId,
      eventType: "SESSION_CREATED",
      payload: {
        purpose: input.purpose,
        contextRevisionSetHash: pinnedContext.revisionSetHash,
      },
    });
    await client.query("commit");
    return normalizeSession({
      ...row,
      coordination_version: event.session_version,
      context_revision_set: pinnedContext.revisionSet,
      context_revision_set_hash: pinnedContext.revisionSetHash,
      participant_role: "OWNER",
    });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getWorkspaceSessionForParticipant(
  db: Postgres,
  sessionId: string,
  userId: string,
): Promise<WorkspaceSessionAccess | null> {
  const result = await db.pool.query<Record<string, unknown>>(
    `select s.*,c.revision_set context_revision_set,
            c.revision_set_hash context_revision_set_hash,
            p.role participant_role
       from agent_sessions s
       left join workspace_context_revision_sets c on c.session_id=s.id
       join workspace_session_participants p
         on p.session_id=s.id and p.user_id=$2 and p.left_at is null
      where s.id=$1`,
    [sessionId, userId],
  );
  return result.rows[0] ? normalizeSession(result.rows[0]) : null;
}

export async function listWorkspaceSessionsForParticipant(
  db: Postgres,
  userId: string,
  spaceIds: readonly string[],
  vaultIds: readonly string[],
): Promise<WorkspaceSessionAccess[]> {
  if (!spaceIds.length || !vaultIds.length) return [];
  const result = await db.pool.query<Record<string, unknown>>(
    `select s.*,c.revision_set context_revision_set,
            c.revision_set_hash context_revision_set_hash,
            p.role participant_role
       from agent_sessions s
       left join workspace_context_revision_sets c on c.session_id=s.id
       join workspace_session_participants p
         on p.session_id=s.id and p.user_id=$1 and p.left_at is null
      where s.space_id=any($2::uuid[])
        and s.vault_id=any($3::uuid[])
      order by s.updated_at desc
      limit 100`,
    [userId, spaceIds, vaultIds],
  );
  return result.rows.map(normalizeSession);
}

export async function addWorkspaceParticipant(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    userId: string;
  },
): Promise<{ joined: boolean; role: WorkspaceParticipantRole }> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const session = await client.query<Record<string, unknown>>(
      `select p.role
         from agent_sessions s
         join workspace_session_participants p
           on p.session_id=s.id and p.user_id=$2 and p.left_at is null
        where s.id=$1
        for update of s`,
      [input.sessionId, input.actorId],
    );
    const actor = session.rows[0];
    if (!actor) throw workspaceError("SESSION_NOT_FOUND", 404);
    if (actor.role !== "OWNER") {
      throw workspaceError("WORKSPACE_SESSION_OWNER_REQUIRED", 403);
    }
    const existing = await client.query<Record<string, unknown>>(
      `select role,left_at
         from workspace_session_participants
        where session_id=$1 and user_id=$2
        for update`,
      [input.sessionId, input.userId],
    );
    const current = existing.rows[0];
    if (current && current.left_at === null) {
      await client.query("commit");
      return {
        joined: false,
        role: String(current.role) as WorkspaceParticipantRole,
      };
    }
    let role: WorkspaceParticipantRole = "PARTICIPANT";
    if (current) {
      const rejoined = await client.query<Record<string, unknown>>(
        `update workspace_session_participants
            set left_at=null,
                joined_at=now(),
                role=case when role='OWNER' then 'OWNER' else 'PARTICIPANT' end
          where session_id=$1 and user_id=$2
          returning role`,
        [input.sessionId, input.userId],
      );
      role = String(
        rejoined.rows[0]?.role ?? "PARTICIPANT",
      ) as WorkspaceParticipantRole;
    } else {
      await client.query(
        `insert into workspace_session_participants(session_id,user_id,role,left_at)
         values($1,$2,'PARTICIPANT',null)`,
        [input.sessionId, input.userId],
      );
    }
    await appendCoordinationEvent(client, {
      sessionId: input.sessionId,
      actorId: input.actorId,
      eventType: "PARTICIPANT_JOINED",
      payload: { userId: input.userId, role },
    });
    await client.query("commit");
    return { joined: true, role };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function claimWorkspaceWork(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    workKey: string;
    leaseSeconds: number;
  },
): Promise<WorkspaceClaim> {
  assertLeaseSeconds(input.leaseSeconds);
  const requestedScope = requiredWorkScope(input.workKey);
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const session = await client.query(
      `select 1
         from agent_sessions s
         join workspace_session_participants p
           on p.session_id=s.id and p.user_id=$2 and p.left_at is null
        where s.id=$1
        for update of s`,
      [input.sessionId, input.actorId],
    );
    if (!session.rowCount) throw workspaceError("SESSION_NOT_FOUND", 404);
    const sessionScope = await client.query<{
      space_id: string;
      vault_id: string;
    }>("select space_id,vault_id from agent_sessions where id=$1", [
      input.sessionId,
    ]);
    const scope = sessionScope.rows[0];
    if (!scope?.vault_id) throw workspaceError("SESSION_NOT_FOUND", 404);
    await assertWorkspaceContextRevisionCurrent(
      client,
      input.sessionId,
      scope.space_id,
      scope.vault_id,
    );

    // The session row lock serializes claim acquisition in this workspace. Without
    // it, two overlapping prefixes could both observe an empty set and commit.
    const liveClaims = await client.query<{ work_key: string }>(
      `select work_key
         from workspace_claims
        where session_id=$1
          and status='ACTIVE'
          and lease_expires_at>now()`,
      [input.sessionId],
    );
    const conflict = liveClaims.rows.find((candidate) =>
      workspaceScopesOverlap(
        requestedScope,
        requiredWorkScope(candidate.work_key),
      ),
    );
    if (conflict) {
      throw workspaceError(
        conflict.work_key === input.workKey
          ? "WORK_CLAIM_HELD"
          : "WORK_CLAIM_OVERLAP",
        409,
      );
    }

    const claimed = await client.query<Record<string, unknown>>(
      `insert into workspace_claims(
         session_id,work_key,owner_id,status,fencing_token,lease_expires_at,version
       ) values(
         $1,$2,$3,'ACTIVE',1,now()+make_interval(secs => $4),1
       )
       on conflict(session_id,work_key) do update set
         owner_id=excluded.owner_id,
         status='ACTIVE',
         fencing_token=workspace_claims.fencing_token+1,
         lease_expires_at=excluded.lease_expires_at,
         version=workspace_claims.version+1,
         updated_at=now()
       where workspace_claims.status<>'ACTIVE'
          or workspace_claims.lease_expires_at<=now()
       returning *`,
      [input.sessionId, input.workKey, input.actorId, input.leaseSeconds],
    );
    const row = claimed.rows[0];
    if (!row) throw workspaceError("WORK_CLAIM_HELD", 409);
    await appendCoordinationEvent(client, {
      sessionId: input.sessionId,
      actorId: input.actorId,
      claimId: String(row.id),
      eventType: "CLAIM_ACQUIRED",
      payload: {
        workKey: input.workKey,
        scopeMode: requestedScope.mode,
        scopeKey: requestedScope.key,
        fencingToken: Number(row.fencing_token),
        leaseExpiresAt: row.lease_expires_at,
      },
    });
    await client.query("commit");
    return normalizeClaim(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function heartbeatWorkspaceWork(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    workKey: string;
    fencingToken: number;
    leaseSeconds: number;
  },
): Promise<WorkspaceClaim> {
  assertLeaseSeconds(input.leaseSeconds);
  requiredWorkScope(input.workKey);
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const participant = await client.query(
      `select 1
         from workspace_session_participants
        where session_id=$1 and user_id=$2 and left_at is null`,
      [input.sessionId, input.actorId],
    );
    if (!participant.rowCount) throw workspaceError("SESSION_NOT_FOUND", 404);
    const sessionScope = await client.query<{
      space_id: string;
      vault_id: string;
    }>("select space_id,vault_id from agent_sessions where id=$1", [
      input.sessionId,
    ]);
    const scope = sessionScope.rows[0];
    if (!scope?.vault_id) throw workspaceError("SESSION_NOT_FOUND", 404);
    await assertWorkspaceContextRevisionCurrent(
      client,
      input.sessionId,
      scope.space_id,
      scope.vault_id,
    );
    const updated = await client.query<Record<string, unknown>>(
      `update workspace_claims
          set lease_expires_at=now()+make_interval(secs => $5),
              version=version+1,
              updated_at=now()
        where session_id=$1
          and work_key=$2
          and owner_id=$3
          and fencing_token=$4
          and status='ACTIVE'
          and lease_expires_at>now()
        returning *`,
      [
        input.sessionId,
        input.workKey,
        input.actorId,
        input.fencingToken,
        input.leaseSeconds,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw workspaceError("WORK_CLAIM_FENCE_STALE", 409);
    await appendCoordinationEvent(client, {
      sessionId: input.sessionId,
      actorId: input.actorId,
      claimId: String(row.id),
      eventType: "CLAIM_HEARTBEAT",
      payload: {
        workKey: input.workKey,
        fencingToken: Number(row.fencing_token),
        leaseExpiresAt: row.lease_expires_at,
      },
    });
    await client.query("commit");
    return normalizeClaim(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseWorkspaceWork(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    workKey: string;
    fencingToken: number;
  },
): Promise<WorkspaceClaim> {
  requiredWorkScope(input.workKey);
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const participant = await client.query(
      `select 1
         from workspace_session_participants
        where session_id=$1 and user_id=$2 and left_at is null`,
      [input.sessionId, input.actorId],
    );
    if (!participant.rowCount) throw workspaceError("SESSION_NOT_FOUND", 404);
    const sessionScope = await client.query<{
      space_id: string;
      vault_id: string;
    }>("select space_id,vault_id from agent_sessions where id=$1", [
      input.sessionId,
    ]);
    const scope = sessionScope.rows[0];
    if (!scope?.vault_id) throw workspaceError("SESSION_NOT_FOUND", 404);
    await assertWorkspaceContextRevisionCurrent(
      client,
      input.sessionId,
      scope.space_id,
      scope.vault_id,
    );
    const updated = await client.query<Record<string, unknown>>(
      `update workspace_claims
          set status='RELEASED',
              fencing_token=fencing_token+1,
              lease_expires_at=now(),
              version=version+1,
              updated_at=now()
        where session_id=$1
          and work_key=$2
          and owner_id=$3
          and fencing_token=$4
          and status='ACTIVE'
          and lease_expires_at>now()
        returning *`,
      [input.sessionId, input.workKey, input.actorId, input.fencingToken],
    );
    const row = updated.rows[0];
    if (!row) throw workspaceError("WORK_CLAIM_FENCE_STALE", 409);
    await appendCoordinationEvent(client, {
      sessionId: input.sessionId,
      actorId: input.actorId,
      claimId: String(row.id),
      eventType: "CLAIM_RELEASED",
      payload: {
        workKey: input.workKey,
        previousFencingToken: input.fencingToken,
        fencingToken: Number(row.fencing_token),
        releasedBy: input.actorId,
      },
    });
    await client.query("commit");
    return normalizeClaim(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function handoffWorkspaceWork(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    workKey: string;
    toUserId: string;
    fencingToken: number;
    leaseSeconds: number;
    note?: string;
  },
): Promise<WorkspaceClaim> {
  assertLeaseSeconds(input.leaseSeconds);
  requiredWorkScope(input.workKey);
  if (input.toUserId === input.actorId) {
    throw workspaceError("WORKSPACE_HANDOFF_SELF", 400);
  }
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const session = await client.query(
      `select 1
         from agent_sessions s
         join workspace_session_participants actor
           on actor.session_id=s.id
          and actor.user_id=$2
          and actor.left_at is null
         join workspace_session_participants target
           on target.session_id=s.id
          and target.user_id=$3
          and target.left_at is null
        where s.id=$1`,
      [input.sessionId, input.actorId, input.toUserId],
    );
    if (!session.rowCount) {
      throw workspaceError("WORKSPACE_HANDOFF_PARTICIPANT_REQUIRED", 422);
    }
    const sessionScope = await client.query<{
      space_id: string;
      vault_id: string;
    }>("select space_id,vault_id from agent_sessions where id=$1", [
      input.sessionId,
    ]);
    const scope = sessionScope.rows[0];
    if (!scope?.vault_id) throw workspaceError("SESSION_NOT_FOUND", 404);
    await assertWorkspaceContextRevisionCurrent(
      client,
      input.sessionId,
      scope.space_id,
      scope.vault_id,
    );
    const current = await client.query<Record<string, unknown>>(
      `select *
         from workspace_claims
        where session_id=$1 and work_key=$2
        for update`,
      [input.sessionId, input.workKey],
    );
    const currentRow = current.rows[0];
    if (
      !currentRow ||
      currentRow.status !== "ACTIVE" ||
      String(currentRow.owner_id) !== input.actorId ||
      Number(currentRow.fencing_token) !== input.fencingToken
    ) {
      throw workspaceError("WORK_CLAIM_FENCE_STALE", 409);
    }
    const previousFencingToken = Number(currentRow.fencing_token);
    const updated = await client.query<Record<string, unknown>>(
      `update workspace_claims
          set owner_id=$4,
              fencing_token=fencing_token+1,
              lease_expires_at=now()+make_interval(secs => $5),
              version=version+1,
              updated_at=now()
        where session_id=$1
          and work_key=$2
          and owner_id=$3
          and fencing_token=$6
          and status='ACTIVE'
          and lease_expires_at>now()
        returning *`,
      [
        input.sessionId,
        input.workKey,
        input.actorId,
        input.toUserId,
        input.leaseSeconds,
        input.fencingToken,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw workspaceError("WORK_CLAIM_FENCE_STALE", 409);
    await appendCoordinationEvent(client, {
      sessionId: input.sessionId,
      actorId: input.actorId,
      claimId: String(row.id),
      eventType: "CLAIM_HANDOFF",
      payload: {
        workKey: input.workKey,
        fromUserId: input.actorId,
        toUserId: input.toUserId,
        previousFencingToken,
        fencingToken: Number(row.fencing_token),
        ...(input.note ? { note: input.note } : {}),
      },
    });
    await client.query("commit");
    return normalizeClaim(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function appendWorkspaceEventInTransaction(
  client: PostgresPoolClient,
  input: {
    sessionId: string;
    actorId: string;
    eventType: WorkspaceUserEventType;
    payload: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const participant = await client.query(
    `select 1
       from workspace_session_participants
      where session_id=$1 and user_id=$2 and left_at is null`,
    [input.sessionId, input.actorId],
  );
  if (!participant.rowCount) throw workspaceError("SESSION_NOT_FOUND", 404);
  const sessionScope = await client.query<{
    space_id: string;
    vault_id: string;
  }>("select space_id,vault_id from agent_sessions where id=$1", [
    input.sessionId,
  ]);
  const scope = sessionScope.rows[0];
  if (!scope?.vault_id) throw workspaceError("SESSION_NOT_FOUND", 404);
  await assertWorkspaceContextRevisionCurrent(
    client,
    input.sessionId,
    scope.space_id,
    scope.vault_id,
  );
  return appendCoordinationEvent(client, input);
}

export async function appendWorkspaceEvent(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    eventType: WorkspaceUserEventType;
    payload: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const row = await appendWorkspaceEventInTransaction(client, input);
    await client.query("commit");
    return row;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function workspacePromotionEvidence(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    eventIds: string[];
  },
): Promise<{
  session: WorkspaceSessionAccess;
  events: Record<string, unknown>[];
}> {
  const uniqueIds = [...new Set(input.eventIds)];
  if (uniqueIds.length > 100) {
    throw workspaceError("PROMOTION_EVIDENCE_LIMIT_EXCEEDED", 413);
  }
  if (!uniqueIds.length || uniqueIds.length !== input.eventIds.length) {
    throw workspaceError(
      uniqueIds.length
        ? "PROMOTION_EVIDENCE_DUPLICATE"
        : "PROMOTION_EVIDENCE_REQUIRED",
      400,
    );
  }
  const client = await db.pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const sessionResult = await client.query<Record<string, unknown>>(
      `select s.*,p.role participant_role
         from agent_sessions s
         join workspace_session_participants p
           on p.session_id=s.id and p.user_id=$2 and p.left_at is null
        where s.id=$1`,
      [input.sessionId, input.actorId],
    );
    const sessionRow = sessionResult.rows[0];
    if (!sessionRow) throw workspaceError("SESSION_NOT_FOUND", 404);
    await assertWorkspaceContextRevisionCurrent(
      client,
      input.sessionId,
      String(sessionRow.space_id),
      String(sessionRow.vault_id),
    );
    const malformedId = uniqueIds.some((id) => !/^[1-9][0-9]*$/.test(id));
    if (malformedId) throw workspaceError("PROMOTION_EVIDENCE_INVALID", 400);
    const events = await client.query<Record<string, unknown>>(
      `select *
         from workspace_events
        where session_id=$1
          and id=any($2::bigint[])
          and event_type=any($3::text[])
        order by session_version`,
      [input.sessionId, uniqueIds, PROMOTABLE_WORKSPACE_EVENT_TYPES],
    );
    if (events.rowCount !== uniqueIds.length) {
      throw workspaceError("PROMOTION_EVIDENCE_NOT_FOUND", 404);
    }
    await client.query("commit");
    return {
      session: normalizeSession(sessionRow),
      events: events.rows,
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function workspaceSessionSnapshot(
  db: Postgres,
  sessionId: string,
  userId: string,
): Promise<{
  session: WorkspaceSessionAccess;
  participants: Record<string, unknown>[];
  claims: WorkspaceClaim[];
  events: Record<string, unknown>[];
  snapshotVersion: number;
  eventWindow: {
    total: number;
    returned: number;
    truncated: boolean;
    oldestVersion: number | null;
    latestVersion: number | null;
  };
  contextRevision: Awaited<ReturnType<typeof workspaceContextRevisionState>>;
} | null> {
  const client = await db.pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const sessionResult = await client.query<Record<string, unknown>>(
      `select s.*,p.role participant_role
         from agent_sessions s
         join workspace_session_participants p
           on p.session_id=s.id and p.user_id=$2 and p.left_at is null
        where s.id=$1`,
      [sessionId, userId],
    );
    const sessionRow = sessionResult.rows[0];
    if (!sessionRow) {
      await client.query("rollback");
      return null;
    }
    const participants = await client.query<Record<string, unknown>>(
      `select user_id,role,joined_at
         from workspace_session_participants
        where session_id=$1 and left_at is null
        order by joined_at,user_id`,
      [sessionId],
    );
    const claims = await client.query<Record<string, unknown>>(
      `select *
         from workspace_claims
        where session_id=$1
        order by work_key`,
      [sessionId],
    );
    const contextRevision = await workspaceContextRevisionState(
      client,
      sessionId,
      String(sessionRow.space_id),
      String(sessionRow.vault_id),
    );
    const events = await client.query<Record<string, unknown>>(
      `select *,count(*) over() total_count
         from workspace_events
        where session_id=$1
        order by session_version desc
        limit 500`,
      [sessionId],
    );
    await client.query("commit");
    const orderedEvents = [...events.rows].reverse();
    const total = Number(events.rows[0]?.total_count ?? 0);
    const cleanEvents = orderedEvents.map((event) => {
      const { total_count: _totalCount, ...rest } = event;
      return rest;
    });
    const oldestVersion = cleanEvents.length
      ? Number(cleanEvents[0]?.session_version)
      : null;
    const latestVersion = cleanEvents.length
      ? Number(cleanEvents[cleanEvents.length - 1]?.session_version)
      : null;
    const session = normalizeSession(sessionRow);
    return {
      session,
      participants: participants.rows,
      claims: claims.rows.map(normalizeClaim),
      events: cleanEvents,
      snapshotVersion: session.coordinationVersion,
      contextRevision,
      eventWindow: {
        total,
        returned: cleanEvents.length,
        truncated: total > cleanEvents.length,
        oldestVersion,
        latestVersion,
      },
    };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
