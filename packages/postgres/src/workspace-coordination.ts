import type { Postgres, PostgresPoolClient } from "./index.js";
import {
  assertWorkspaceContextRevisionCurrent,
  loadPinnedWorkspaceContextRevisionSet,
  pinWorkspaceContextRevisionSet,
  workspaceContextRevisionState,
  type ContextRevisionSet,
} from "./context-revision-set.js";
import { appendOutboxEvent, type IntegrationEventType } from "./outbox.js";

export type WorkspaceParticipantRole = "OWNER" | "PARTICIPANT";
export type WorkspaceWorkStatus =
  "OPEN" | "BLOCKED" | "COMPLETED" | "ABANDONED";
export const PROMOTABLE_WORKSPACE_EVENT_TYPES = [
  "FINDING",
  "ARTIFACT",
  "DECISION_CANDIDATE",
] as const;
export type PromotableWorkspaceEventType =
  (typeof PROMOTABLE_WORKSPACE_EVENT_TYPES)[number];
export type WorkspaceEventType =
  | "SESSION_CREATED"
  | "WORK_CONTEXT_UPDATED"
  | "PARTICIPANT_JOINED"
  | "CLAIM_ACQUIRED"
  | "CLAIM_HEARTBEAT"
  | "CLAIM_RELEASED"
  | "CLAIM_HANDOFF"
  | "HANDOFF_IMPORTED"
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
  | "WORK_CONTEXT_UPDATED"
  | "PARTICIPANT_JOINED"
  | "CLAIM_ACQUIRED"
  | "CLAIM_HEARTBEAT"
  | "CLAIM_RELEASED"
  | "CLAIM_HANDOFF"
  | "HANDOFF_IMPORTED"
>;

function workspaceIntegrationEventType(
  eventType: WorkspaceEventType,
): IntegrationEventType | null {
  switch (eventType) {
    case "SESSION_CREATED":
      return "WorkspaceSessionCreated";
    case "WORK_CONTEXT_UPDATED":
      return "WorkspaceSessionUpdated";
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
  workStatus: WorkspaceWorkStatus;
  outcome: string | null;
  followUps: string[];
  touchedResources: string[];
  state: Record<string, unknown>;
  contextRevisionSet: ContextRevisionSet | null;
  contextRevisionSetHash: string | null;
  role: WorkspaceParticipantRole;
}

export interface WorkspaceClaim {
  id: string;
  sessionId: string;
  workKey: string;
  objectRefId: string | null;
  ownerId: string;
  ownerPrincipalId: string;
  status: "ACTIVE" | "RELEASED" | "COMPLETED";
  fencingToken: number;
  leaseExpiresAt: Date;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface StructuredWorkspaceHandoff {
  summary: string;
  completed: string[];
  remaining: string[];
  blockers: string[];
  changedResourceRefs: string[];
  evidenceRefs: string[];
  questions: string[];
}

export interface WorkspaceHandoffInboxItem {
  handoffEventId: string;
  sourceSessionId: string;
  spaceId: string;
  vaultId: string;
  workKey: string;
  goal: string;
  fromPrincipalId: string | null;
  toPrincipalId: string | null;
  summary: string;
  completed: string[];
  remaining: string[];
  blockers: string[];
  changedResourceRefs: string[];
  evidenceRefs: string[];
  questions: string[];
  contextRevision: ContextRevisionSet | null;
  contextRevisionSetHash: string | null;
  createdAt: Date;
}

function recordPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
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
    workStatus:
      row.state &&
      typeof row.state === "object" &&
      ["OPEN", "BLOCKED", "COMPLETED", "ABANDONED"].includes(
        String((row.state as Record<string, unknown>).workStatus ?? ""),
      )
        ? (String(
            (row.state as Record<string, unknown>).workStatus,
          ) as WorkspaceWorkStatus)
        : "OPEN",
    outcome:
      row.state &&
      typeof row.state === "object" &&
      typeof (row.state as Record<string, unknown>).outcome === "string"
        ? String((row.state as Record<string, unknown>).outcome)
        : null,
    followUps:
      row.state &&
      typeof row.state === "object" &&
      Array.isArray((row.state as Record<string, unknown>).followUps)
        ? ((row.state as Record<string, unknown>).followUps as unknown[]).map(
            String,
          )
        : [],
    touchedResources:
      row.state &&
      typeof row.state === "object" &&
      Array.isArray((row.state as Record<string, unknown>).touchedResources)
        ? (
            (row.state as Record<string, unknown>).touchedResources as unknown[]
          ).map(String)
        : [],
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
    objectRefId:
      row.object_ref_id === null || row.object_ref_id === undefined
        ? null
        : String(row.object_ref_id),
    ownerId: String(row.owner_id),
    ownerPrincipalId: String(row.owner_principal_id),
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
  if (
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.includes("//")
  ) {
    return null;
  }
  const prefix = PREFIX_WORK_KEY_PATTERN.exec(value);
  const key = prefix ? prefix[1] : value;
  if (
    !key ||
    (prefix ? key.length > 197 : key.length > 200) ||
    !EXACT_WORK_KEY_PATTERN.test(key)
  ) {
    return null;
  }
  const segments = key.split("/");
  if (
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return prefix ? { mode: "PREFIX", key } : { mode: "EXACT", key };
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

async function resolveWorkspacePrincipalId(
  client: PostgresPoolClient,
  input: {
    sessionId: string;
    userId: string;
    principalId?: string | null | undefined;
  },
): Promise<string> {
  if (input.principalId) {
    const explicit = await client.query<{ id: string }>(
      `select id
         from principals
        where id=$1 and user_id=$2 and state='ACTIVE'
          and (
            kind='HUMAN'
            or (kind='AGENT_PROCESS' and session_id=$3)
          )
        limit 1`,
      [input.principalId, input.userId, input.sessionId],
    );
    const id = explicit.rows[0]?.id;
    if (!id) throw workspaceError("WORKSPACE_PRINCIPAL_SCOPE_DENIED", 403);
    return id;
  }
  const human = await client.query<{ id: string }>(
    `select id
       from principals
      where kind='HUMAN' and user_id=$1 and state='ACTIVE'
      limit 1`,
    [input.userId],
  );
  const id = human.rows[0]?.id;
  if (!id) throw workspaceError("WORKSPACE_PRINCIPAL_NOT_FOUND", 409);
  return id;
}

async function appendCoordinationEvent(
  client: PostgresPoolClient,
  input: {
    sessionId: string;
    actorId: string | null;
    actorPrincipalId?: string | null | undefined;
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
  const actorPrincipalId = input.actorId
    ? await resolveWorkspacePrincipalId(client, {
        sessionId: input.sessionId,
        userId: input.actorId,
        principalId: input.actorPrincipalId,
      })
    : null;
  const inserted = await client.query<Record<string, unknown>>(
    `insert into workspace_events(
       session_id,space_id,vault_id,actor_id,actor_principal_id,claim_id,
       event_type,payload,session_version
     ) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     returning *`,
    [
      input.sessionId,
      session.space_id,
      session.vault_id,
      input.actorId,
      actorPrincipalId,
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
        actorPrincipalId,
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
        JSON.stringify({
          status: "ACTIVE",
          workStatus: "OPEN",
          outcome: null,
          followUps: [],
          touchedResources: [],
          createdBy: "api",
        }),
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

const WORK_STATUS_TRANSITIONS: Record<
  WorkspaceWorkStatus,
  readonly WorkspaceWorkStatus[]
> = {
  OPEN: ["OPEN", "BLOCKED", "COMPLETED", "ABANDONED"],
  BLOCKED: ["BLOCKED", "OPEN", "COMPLETED", "ABANDONED"],
  COMPLETED: ["COMPLETED"],
  ABANDONED: ["ABANDONED"],
};

export async function updateWorkspaceWorkContext(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    actorPrincipalId?: string | null;
    status: WorkspaceWorkStatus;
    outcome?: string | null;
    followUps: string[];
    touchedResources: string[];
  },
): Promise<WorkspaceSessionAccess> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const sessionResult = await client.query<Record<string, unknown>>(
      `select s.*,c.revision_set context_revision_set,
              c.revision_set_hash context_revision_set_hash,
              p.role participant_role
         from agent_sessions s
         left join workspace_context_revision_sets c on c.session_id=s.id
         join workspace_session_participants p
           on p.session_id=s.id and p.user_id=$2 and p.left_at is null
        where s.id=$1
        for update of s`,
      [input.sessionId, input.actorId],
    );
    const currentRow = sessionResult.rows[0];
    if (!currentRow) throw workspaceError("SESSION_NOT_FOUND", 404);
    await assertWorkspaceContextRevisionCurrent(
      client,
      input.sessionId,
      String(currentRow.space_id),
      String(currentRow.vault_id),
    );
    const current = normalizeSession(currentRow);
    if (!WORK_STATUS_TRANSITIONS[current.workStatus].includes(input.status)) {
      throw workspaceError("WORK_CONTEXT_STATUS_TRANSITION_DENIED", 409);
    }
    if (input.status === "COMPLETED" && !input.outcome?.trim()) {
      throw workspaceError("WORK_CONTEXT_OUTCOME_REQUIRED", 422);
    }
    const state = {
      ...current.state,
      workStatus: input.status,
      outcome: input.outcome?.trim() || null,
      followUps: input.followUps,
      touchedResources: input.touchedResources,
    };
    const updated = await client.query<Record<string, unknown>>(
      `update agent_sessions
          set state=$2::jsonb,updated_at=now()
        where id=$1
        returning *`,
      [input.sessionId, JSON.stringify(state)],
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) throw workspaceError("WORK_CONTEXT_UPDATE_FAILED", 500);
    const event = await appendCoordinationEvent(client, {
      sessionId: input.sessionId,
      actorId: input.actorId,
      actorPrincipalId: input.actorPrincipalId,
      eventType: "WORK_CONTEXT_UPDATED",
      payload: {
        previousStatus: current.workStatus,
        status: input.status,
        outcome: state.outcome,
        followUps: input.followUps,
        touchedResources: input.touchedResources,
      },
    });
    await client.query("commit");
    return normalizeSession({
      ...updatedRow,
      context_revision_set: currentRow.context_revision_set,
      context_revision_set_hash: currentRow.context_revision_set_hash,
      participant_role: currentRow.participant_role,
      coordination_version: event.session_version,
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
    actorPrincipalId?: string | null;
    workKey: string;
    objectRefId?: string | null;
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
      purpose: string;
    }>("select space_id,vault_id,purpose from agent_sessions where id=$1", [
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
    if (input.objectRefId) {
      const workObject = await client.query<{ id: string }>(
        `select id
           from external_object_refs
          where id=$1 and vault_id=$2 and session_id=$3
          limit 1`,
        [input.objectRefId, scope.vault_id, input.sessionId],
      );
      if (!workObject.rowCount) {
        throw workspaceError("EXTERNAL_OBJECT_REF_NOT_FOUND", 404);
      }
      const existing = await client.query<{ object_ref_id: string | null }>(
        `select object_ref_id
           from workspace_claims
          where session_id=$1 and work_key=$2
          limit 1`,
        [input.sessionId, input.workKey],
      );
      const existingObjectRefId = existing.rows[0]?.object_ref_id ?? null;
      if (existingObjectRefId && existingObjectRefId !== input.objectRefId) {
        throw workspaceError("WORK_CLAIM_OBJECT_CONFLICT", 409);
      }
    }
    const actorPrincipalId = await resolveWorkspacePrincipalId(client, {
      sessionId: input.sessionId,
      userId: input.actorId,
      principalId: input.actorPrincipalId,
    });

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
         session_id,work_key,object_ref_id,owner_id,owner_principal_id,status,
         fencing_token,lease_expires_at,version
       ) values(
         $1,$2,$3,$4,$5,'ACTIVE',1,now()+make_interval(secs => $6),1
       )
       on conflict(session_id,work_key) do update set
         object_ref_id=coalesce(
           workspace_claims.object_ref_id,
           excluded.object_ref_id
         ),
         owner_id=excluded.owner_id,
         owner_principal_id=excluded.owner_principal_id,
         status='ACTIVE',
         fencing_token=workspace_claims.fencing_token+1,
         lease_expires_at=excluded.lease_expires_at,
         version=workspace_claims.version+1,
         updated_at=now()
       where (
              workspace_claims.status<>'ACTIVE'
              or workspace_claims.lease_expires_at<=now()
             )
         and (
              workspace_claims.object_ref_id is null
              or excluded.object_ref_id is null
              or workspace_claims.object_ref_id=excluded.object_ref_id
             )
       returning *`,
      [
        input.sessionId,
        input.workKey,
        input.objectRefId ?? null,
        input.actorId,
        actorPrincipalId,
        input.leaseSeconds,
      ],
    );
    const row = claimed.rows[0];
    if (!row) throw workspaceError("WORK_CLAIM_HELD", 409);
    await appendCoordinationEvent(client, {
      sessionId: input.sessionId,
      actorId: input.actorId,
      actorPrincipalId,
      claimId: String(row.id),
      eventType: "CLAIM_ACQUIRED",
      payload: {
        workKey: input.workKey,
        objectRefId: input.objectRefId ?? null,
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
    actorPrincipalId?: string | null;
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
      purpose: string | null;
    }>("select space_id,vault_id,purpose from agent_sessions where id=$1", [
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
    const actorPrincipalId = await resolveWorkspacePrincipalId(client, {
      sessionId: input.sessionId,
      userId: input.actorId,
      principalId: input.actorPrincipalId,
    });
    const updated = await client.query<Record<string, unknown>>(
      `update workspace_claims
          set lease_expires_at=now()+make_interval(secs => $6),
              version=version+1,
              updated_at=now()
        where session_id=$1
          and work_key=$2
          and owner_id=$3
          and owner_principal_id=$4
          and fencing_token=$5
          and status='ACTIVE'
          and lease_expires_at>now()
        returning *`,
      [
        input.sessionId,
        input.workKey,
        input.actorId,
        actorPrincipalId,
        input.fencingToken,
        input.leaseSeconds,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw workspaceError("WORK_CLAIM_FENCE_STALE", 409);
    await appendCoordinationEvent(client, {
      sessionId: input.sessionId,
      actorId: input.actorId,
      actorPrincipalId,
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
    actorPrincipalId?: string | null;
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
    const actorPrincipalId = await resolveWorkspacePrincipalId(client, {
      sessionId: input.sessionId,
      userId: input.actorId,
      principalId: input.actorPrincipalId,
    });
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
          and owner_principal_id=$4
          and fencing_token=$5
          and status='ACTIVE'
          and lease_expires_at>now()
        returning *`,
      [
        input.sessionId,
        input.workKey,
        input.actorId,
        actorPrincipalId,
        input.fencingToken,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw workspaceError("WORK_CLAIM_FENCE_STALE", 409);
    await appendCoordinationEvent(client, {
      sessionId: input.sessionId,
      actorId: input.actorId,
      actorPrincipalId,
      claimId: String(row.id),
      eventType: "CLAIM_RELEASED",
      payload: {
        workKey: input.workKey,
        previousFencingToken: input.fencingToken,
        fencingToken: Number(row.fencing_token),
        releasedBy: input.actorId,
        releasedByPrincipalId: actorPrincipalId,
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
    toPrincipalId?: string | null;
    fencingToken: number;
    leaseSeconds: number;
    actorPrincipalId?: string | null;
    handoff?: StructuredWorkspaceHandoff;
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
    const pinnedContext = input.handoff
      ? await loadPinnedWorkspaceContextRevisionSet(client, input.sessionId)
      : null;
    if (input.handoff && !pinnedContext) {
      throw workspaceError("CONTEXT_REVISION_PIN_REQUIRED", 409);
    }
    const actorPrincipalId = await resolveWorkspacePrincipalId(client, {
      sessionId: input.sessionId,
      userId: input.actorId,
      principalId: input.actorPrincipalId,
    });
    const targetPrincipalId = await resolveWorkspacePrincipalId(client, {
      sessionId: input.sessionId,
      userId: input.toUserId,
      principalId: input.toPrincipalId,
    });
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
      String(currentRow.owner_principal_id) !== actorPrincipalId ||
      Number(currentRow.fencing_token) !== input.fencingToken
    ) {
      throw workspaceError("WORK_CLAIM_FENCE_STALE", 409);
    }
    const previousFencingToken = Number(currentRow.fencing_token);
    const updated = await client.query<Record<string, unknown>>(
      `update workspace_claims
          set owner_id=$4,
              owner_principal_id=$5,
              fencing_token=fencing_token+1,
              lease_expires_at=now()+make_interval(secs => $6),
              version=version+1,
              updated_at=now()
        where session_id=$1
          and work_key=$2
          and owner_id=$3
          and owner_principal_id=$7
          and fencing_token=$8
          and status='ACTIVE'
          and lease_expires_at>now()
        returning *`,
      [
        input.sessionId,
        input.workKey,
        input.actorId,
        input.toUserId,
        targetPrincipalId,
        input.leaseSeconds,
        actorPrincipalId,
        input.fencingToken,
      ],
    );
    const row = updated.rows[0];
    if (!row) throw workspaceError("WORK_CLAIM_FENCE_STALE", 409);
    await appendCoordinationEvent(client, {
      sessionId: input.sessionId,
      actorId: input.actorId,
      actorPrincipalId,
      claimId: String(row.id),
      eventType: "CLAIM_HANDOFF",
      payload: {
        workKey: input.workKey,
        fromUserId: input.actorId,
        toUserId: input.toUserId,
        previousFencingToken,
        fencingToken: Number(row.fencing_token),
        ...(input.handoff && pinnedContext
          ? {
              fromPrincipalId: actorPrincipalId,
              toPrincipalId: targetPrincipalId,
              workContextId: input.sessionId,
              goal: String(scope.purpose),
              summary: input.handoff.summary,
              completed: input.handoff.completed,
              remaining: input.handoff.remaining,
              blockers: input.handoff.blockers,
              changedResourceRefs: input.handoff.changedResourceRefs,
              contextRevision: pinnedContext.revisionSet,
              contextRevisionSetHash: pinnedContext.revisionSetHash,
              evidenceRefs: input.handoff.evidenceRefs,
              questions: input.handoff.questions,
            }
          : {}),
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

export async function listWorkspaceHandoffsForRecipient(
  db: Postgres,
  input: {
    actorId: string;
    spaceId: string;
    vaultId: string;
    limit?: number;
  },
): Promise<WorkspaceHandoffInboxItem[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
  const result = await db.pool.query<Record<string, unknown>>(
    `select e.id::text handoff_event_id,e.session_id source_session_id,
            e.payload,e.created_at,s.space_id,s.vault_id,s.purpose
       from workspace_events e
       join agent_sessions s on s.id=e.session_id
      where e.event_type='CLAIM_HANDOFF'
        and e.payload->>'toUserId'=$1
        and s.space_id=$2
        and s.vault_id=$3
      order by e.created_at desc,e.id desc
      limit $4`,
    [input.actorId, input.spaceId, input.vaultId, limit],
  );
  return result.rows.map((row) => {
    const payload = recordPayload(row.payload);
    return {
      handoffEventId: String(row.handoff_event_id),
      sourceSessionId: String(row.source_session_id),
      spaceId: String(row.space_id),
      vaultId: String(row.vault_id),
      workKey: String(payload.workKey ?? ""),
      goal: String(payload.goal ?? row.purpose ?? ""),
      fromPrincipalId:
        typeof payload.fromPrincipalId === "string"
          ? payload.fromPrincipalId
          : null,
      toPrincipalId:
        typeof payload.toPrincipalId === "string"
          ? payload.toPrincipalId
          : null,
      summary: String(payload.summary ?? ""),
      completed: stringList(payload.completed),
      remaining: stringList(payload.remaining),
      blockers: stringList(payload.blockers),
      changedResourceRefs: stringList(payload.changedResourceRefs),
      evidenceRefs: stringList(payload.evidenceRefs),
      questions: stringList(payload.questions),
      contextRevision:
        payload.contextRevision &&
        typeof payload.contextRevision === "object" &&
        !Array.isArray(payload.contextRevision)
          ? (payload.contextRevision as ContextRevisionSet)
          : null,
      contextRevisionSetHash:
        typeof payload.contextRevisionSetHash === "string"
          ? payload.contextRevisionSetHash
          : null,
      createdAt: new Date(String(row.created_at)),
    };
  });
}

export async function importWorkspaceHandoffToSession(
  db: Postgres,
  input: {
    targetSessionId: string;
    actorId: string;
    handoffEventId: string;
    actorPrincipalId?: string | null;
  },
): Promise<Record<string, unknown>> {
  if (!/^[1-9][0-9]*$/.test(input.handoffEventId)) {
    throw workspaceError("INVALID_HANDOFF_EVENT_ID", 400);
  }
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const targetResult = await client.query<{
      space_id: string;
      vault_id: string;
    }>(
      `select s.space_id,s.vault_id
         from agent_sessions s
         join workspace_session_participants p
           on p.session_id=s.id and p.user_id=$2 and p.left_at is null
        where s.id=$1`,
      [input.targetSessionId, input.actorId],
    );
    const target = targetResult.rows[0];
    if (!target?.vault_id) throw workspaceError("SESSION_NOT_FOUND", 404);

    const sourceResult = await client.query<Record<string, unknown>>(
      `select e.id::text handoff_event_id,e.session_id source_session_id,
              e.payload,e.created_at,s.purpose source_purpose,
              s.space_id,s.vault_id
         from workspace_events e
         join agent_sessions s on s.id=e.session_id
        where e.id=$1::bigint
          and e.event_type='CLAIM_HANDOFF'
          and e.payload->>'toUserId'=$2
        limit 1`,
      [input.handoffEventId, input.actorId],
    );
    const source = sourceResult.rows[0];
    if (!source) throw workspaceError("WORKSPACE_HANDOFF_NOT_FOUND", 404);
    if (String(source.source_session_id) === input.targetSessionId) {
      throw workspaceError("WORKSPACE_HANDOFF_NEW_SESSION_REQUIRED", 409);
    }
    if (
      String(source.space_id) !== target.space_id ||
      String(source.vault_id) !== target.vault_id
    ) {
      throw workspaceError("WORKSPACE_HANDOFF_SCOPE_MISMATCH", 403);
    }

    await assertWorkspaceContextRevisionCurrent(
      client,
      input.targetSessionId,
      target.space_id,
      target.vault_id,
    );
    const receiverPinned = await loadPinnedWorkspaceContextRevisionSet(
      client,
      input.targetSessionId,
    );
    if (!receiverPinned) {
      throw workspaceError("CONTEXT_REVISION_PIN_REQUIRED", 409);
    }

    const existing = await client.query<Record<string, unknown>>(
      `select *
         from workspace_events
        where session_id=$1
          and event_type='HANDOFF_IMPORTED'
          and payload->>'sourceHandoffEventId'=$2
        order by id desc
        limit 1`,
      [input.targetSessionId, input.handoffEventId],
    );
    if (existing.rows[0]) {
      await client.query("commit");
      return existing.rows[0];
    }

    const sourcePayload = recordPayload(source.payload);
    const sourceRevisionHash =
      typeof sourcePayload.contextRevisionSetHash === "string"
        ? sourcePayload.contextRevisionSetHash
        : null;
    const event = await appendCoordinationEvent(client, {
      sessionId: input.targetSessionId,
      actorId: input.actorId,
      actorPrincipalId: input.actorPrincipalId,
      eventType: "HANDOFF_IMPORTED",
      payload: {
        sourceHandoffEventId: input.handoffEventId,
        sourceSessionId: String(source.source_session_id),
        workKey: String(sourcePayload.workKey ?? ""),
        goal: String(sourcePayload.goal ?? source.source_purpose ?? ""),
        fromPrincipalId:
          typeof sourcePayload.fromPrincipalId === "string"
            ? sourcePayload.fromPrincipalId
            : null,
        toPrincipalId:
          typeof sourcePayload.toPrincipalId === "string"
            ? sourcePayload.toPrincipalId
            : null,
        summary: String(sourcePayload.summary ?? ""),
        completed: stringList(sourcePayload.completed),
        remaining: stringList(sourcePayload.remaining),
        blockers: stringList(sourcePayload.blockers),
        changedResourceRefs: stringList(sourcePayload.changedResourceRefs),
        evidenceRefs: stringList(sourcePayload.evidenceRefs),
        questions: stringList(sourcePayload.questions),
        sourceContextRevision:
          sourcePayload.contextRevision &&
          typeof sourcePayload.contextRevision === "object" &&
          !Array.isArray(sourcePayload.contextRevision)
            ? sourcePayload.contextRevision
            : null,
        sourceContextRevisionSetHash: sourceRevisionHash,
        receiverContextRevisionSetHash: receiverPinned.revisionSetHash,
        revisionMismatch:
          sourceRevisionHash !== null &&
          sourceRevisionHash !== receiverPinned.revisionSetHash,
        sourceCreatedAt: new Date(String(source.created_at)).toISOString(),
      },
    });
    await client.query("commit");
    return event;
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
    actorPrincipalId?: string | null;
    claimId?: string | null;
    fencingToken?: number | null;
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
  if (
    (input.claimId && input.fencingToken === undefined) ||
    (!input.claimId && input.fencingToken !== undefined)
  ) {
    throw workspaceError("WORKSPACE_EVENT_CLAIM_FENCE_REQUIRED", 400);
  }
  if (input.claimId) {
    if (
      !Number.isSafeInteger(input.fencingToken) ||
      Number(input.fencingToken) < 1
    ) {
      throw workspaceError("INVALID_FENCING_TOKEN", 400);
    }
    const actorPrincipalId = await resolveWorkspacePrincipalId(client, {
      sessionId: input.sessionId,
      userId: input.actorId,
      principalId: input.actorPrincipalId,
    });
    const claim = await client.query<{ id: string }>(
      `select id
         from workspace_claims
        where id=$1 and session_id=$2
          and owner_id=$3 and owner_principal_id=$4
          and fencing_token=$5 and status='ACTIVE'
          and lease_expires_at>now()
        for update`,
      [
        input.claimId,
        input.sessionId,
        input.actorId,
        actorPrincipalId,
        input.fencingToken,
      ],
    );
    if (!claim.rowCount) {
      throw workspaceError("WORK_CLAIM_FENCE_STALE", 409);
    }
  }
  return appendCoordinationEvent(client, input);
}

export async function appendWorkspaceEvent(
  db: Postgres,
  input: {
    sessionId: string;
    actorId: string;
    actorPrincipalId?: string | null;
    claimId?: string | null;
    fencingToken?: number | null;
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
  principals: Record<string, unknown>[];
  assignedPrincipals: string[];
  claims: WorkspaceClaim[];
  contextPackets: Array<{
    id: string;
    objectRefId: string | null;
    packetHash: string;
    corpusRevision: string;
    createdAt: Date;
    expiresAt: Date | null;
  }>;
  events: Record<string, unknown>[];
  snapshotVersion: number;
  eventWindow: {
    total: number;
    returned: number;
    truncated: boolean;