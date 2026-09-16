import type { Postgres } from "./index.js";

export type WorkspaceParticipantRole = "OWNER" | "PARTICIPANT";
export type WorkspaceEventType =
  | "SESSION_CREATED"
  | "PARTICIPANT_JOINED"
  | "CLAIM_ACQUIRED"
  | "CLAIM_HANDOFF"
  | "FINDING"
  | "BLOCKER"
  | "QUESTION"
  | "ARTIFACT"
  | "DECISION_CANDIDATE"
  | "NOTE";

export interface WorkspaceSessionAccess {
  id: string;
  spaceId: string;
  vaultId: string;
  actorId: string | null;
  projectId: string | null;
  purpose: string;
  contextBudget: number;
  state: Record<string, unknown>;
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

function normalizeSession(row: Record<string, unknown>): WorkspaceSessionAccess {
  return {
    id: String(row.id),
    spaceId: String(row.space_id),
    vaultId: String(row.vault_id),
    actorId: row.actor_id ? String(row.actor_id) : null,
    projectId: row.project_id ? String(row.project_id) : null,
    purpose: String(row.purpose),
    contextBudget: Number(row.context_budget),
    state:
      row.state && typeof row.state === "object"
        ? (row.state as Record<string, unknown>)
        : {},
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
    await client.query(
      `insert into workspace_session_participants(session_id,user_id,role)
       values($1,$2,'OWNER')`,
      [row.id, input.actorId],
    );
    await client.query(
      `insert into workspace_events(
         session_id,space_id,vault_id,actor_id,event_type,payload
       ) values($1,$2,$3,$4,'SESSION_CREATED',$5::jsonb)`,
      [
        row.id,
        input.spaceId,
        input.vaultId,
        input.actorId,
        JSON.stringify({ purpose: input.purpose }),
      ],
    );
    await client.query("commit");
    return normalizeSession({ ...row, participant_role: "OWNER" });
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
    `select s.*,p.role participant_role
       from agent_sessions s
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
    `select s.*,p.role participant_role
       from agent_sessions s
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
): Promise<void> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const session = await client.query<Record<string, unknown>>(
      `select s.space_id,s.vault_id,p.role
         from agent_sessions s
         join workspace_session_participants p
           on p.session_id=s.id and p.user_id=$2 and p.left_at is null
        where s.id=$1
        for update of s`,
      [input.sessionId, input.actorId],
    );
    const row = session.rows[0];
    if (!row) throw workspaceError("SESSION_NOT_FOUND", 404);
    if (row.role !== "OWNER") {
      throw workspaceError("WORKSPACE_SESSION_OWNER_REQUIRED", 403);
    }
    await client.query(
      `insert into workspace_session_participants(session_id,user_id,role,left_at)
       values($1,$2,'PARTICIPANT',null)
       on conflict(session_id,user_id) do update
         set role='PARTICIPANT',left_at=null,joined_at=now()`,
      [input.sessionId, input.userId],
    );
    await client.query(
      `insert into workspace_events(
         session_id,space_id,vault_id,actor_id,event_type,payload
       ) values($1,$2,$3,$4,'PARTICIPANT_JOINED',$5::jsonb)`,
      [
        input.sessionId,
        row.space_id,
        row.vault_id,
        input.actorId,
        JSON.stringify({ userId: input.userId }),
      ],
    );
    await client.query(
      "update agent_sessions set updated_at=now() where id=$1",
      [input.sessionId],
    );
    await client.query("commit");
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
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const session = await client.query<Record<string, unknown>>(
      `select s.space_id,s.vault_id
         from agent_sessions s
         join workspace_session_participants p
           on p.session_id=s.id and p.user_id=$2 and p.left_at is null
        where s.id=$1`,
      [input.sessionId, input.actorId],
    );
    const sessionRow = session.rows[0];
    if (!sessionRow) throw workspaceError("SESSION_NOT_FOUND", 404);
    const claimed = await client.query<Record<string, unknown>>(
      `insert into workspace_claims(
         session_id,work_key,owner_id,status,fencing_token,lease_expires_at,version
       ) values(
         $1,$2,$3,'ACTIVE',1,now()+make_interval(secs => $4),1
       )
       on conflict(session_id,work_key) do update set
         owner_id=excluded.owner_id,
         status='ACTIVE',
         fencing_token=case
           when workspace_claims.owner_id=excluded.owner_id
             and workspace_claims.status='ACTIVE'
             and workspace_claims.lease_expires_at>now()
           then workspace_claims.fencing_token
           else workspace_claims.fencing_token+1
         end,
         lease_expires_at=excluded.lease_expires_at,
         version=workspace_claims.version+1,
         updated_at=now()
       where workspace_claims.owner_id=excluded.owner_id
          or workspace_claims.status<>'ACTIVE'
          or workspace_claims.lease_expires_at<=now()
       returning *`,
      [input.sessionId, input.workKey, input.actorId, input.leaseSeconds],
    );
    const row = claimed.rows[0];
    if (!row) throw workspaceError("WORK_CLAIM_HELD", 409);
    await client.query(
      `insert into workspace_events(
         session_id,space_id,vault_id,actor_id,claim_id,event_type,payload
       ) values($1,$2,$3,$4,$5,'CLAIM_ACQUIRED',$6::jsonb)`,
      [
        input.sessionId,
        sessionRow.space_id,
        sessionRow.vault_id,
        input.actorId,
        row.id,
        JSON.stringify({
          workKey: input.workKey,
          fencingToken: Number(row.fencing_token),
          leaseExpiresAt: row.lease_expires_at,
        }),
      ],
    );
    await client.query(
      "update agent_sessions set updated_at=now() where id=$1",
      [input.sessionId],
    );
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
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const session = await client.query<Record<string, unknown>>(
      `select s.space_id,s.vault_id
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
    const sessionRow = session.rows[0];
    if (!sessionRow) {
      throw workspaceError("WORKSPACE_HANDOFF_PARTICIPANT_REQUIRED", 422);
    }
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
      Number(currentRow.fencing_token) !== input.fencingToken ||
      new Date(String(currentRow.lease_expires_at)).getTime() <= Date.now()
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
    await client.query(
      `insert into workspace_events(
         session_id,space_id,vault_id,actor_id,claim_id,event_type,payload
       ) values($1,$2,$3,$4,$5,'CLAIM_HANDOFF',$6::jsonb)`,
      [
        input.sessionId,
        sessionRow.space_id,
        sessionRow.vault_id,
        input.actorId,
        row.id,
        JSON.stringify({
          workKey: input.workKey,
          fromUserId: input.actorId,
          toUserId: input.toUserId,
          previousFencingToken,
          fencingToken: Number(row.fencing_token),
          ...(input.note ? { note: input.note } : {}),
        }),
      ],
    );
    await client.query(
      "update agent_sessions set updated_at=now() where id=$1",
      [input.sessionId],
    );
    await client.query("commit");
    return normalizeClaim(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function appendWorkspaceEvent(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    eventType: Exclude<
      WorkspaceEventType,
      "SESSION_CREATED" | "PARTICIPANT_JOINED" | "CLAIM_ACQUIRED" | "CLAIM_HANDOFF"
    >;
    payload: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  const result = await db.pool.query<Record<string, unknown>>(
    `insert into workspace_events(
       session_id,space_id,vault_id,actor_id,event_type,payload
     )
     select s.id,s.space_id,s.vault_id,$2,$3,$4::jsonb
       from agent_sessions s
       join workspace_session_participants p
         on p.session_id=s.id and p.user_id=$2 and p.left_at is null
      where s.id=$1
     returning *`,
    [
      input.sessionId,
      input.actorId,
      input.eventType,
      JSON.stringify(input.payload),
    ],
  );
  const row = result.rows[0];
  if (!row) throw workspaceError("SESSION_NOT_FOUND", 404);
  await db.pool.query(
    "update agent_sessions set updated_at=now() where id=$1",
    [input.sessionId],
  );
  return row;
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
} | null> {
  const session = await getWorkspaceSessionForParticipant(db, sessionId, userId);
  if (!session) return null;
  const [participants, claims, events] = await Promise.all([
    db.pool.query<Record<string, unknown>>(
      `select user_id,role,joined_at
         from workspace_session_participants
        where session_id=$1 and left_at is null
        order by joined_at,user_id`,
      [sessionId],
    ),
    db.pool.query<Record<string, unknown>>(
      `select *
         from workspace_claims
        where session_id=$1
        order by work_key`,
      [sessionId],
    ),
    db.pool.query<Record<string, unknown>>(
      `select *
         from workspace_events
        where session_id=$1
        order by id
        limit 500`,
      [sessionId],
    ),
  ]);
  return {
    session,
    participants: participants.rows,
    claims: claims.rows.map(normalizeClaim),
    events: events.rows,
  };
}
