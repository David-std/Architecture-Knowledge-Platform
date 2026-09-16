import type { Postgres } from "./index.js";

export interface WorkspacePresenceRecord {
  sessionId: string;
  userId: string;
  role: string;
  lastSeenAt: Date;
  presenceExpiresAt: Date | null;
  online: boolean;
}

function presenceError(code: string, statusCode: number): Error {
  const error = new Error(code) as Error & {
    code?: string;
    statusCode?: number;
  };
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizePresence(
  row: Record<string, unknown>,
): WorkspacePresenceRecord {
  const expires = row.presence_expires_at
    ? new Date(String(row.presence_expires_at))
    : null;
  return {
    sessionId: String(row.session_id),
    userId: String(row.user_id),
    role: String(row.role),
    lastSeenAt: new Date(String(row.last_seen_at)),
    presenceExpiresAt: expires,
    online: Boolean(expires && expires.getTime() > Date.now()),
  };
}

export async function heartbeatWorkspacePresence(
  db: Postgres,
  input: { sessionId: string; actorId: string; ttlSeconds?: number },
): Promise<WorkspacePresenceRecord> {
  const ttlSeconds = input.ttlSeconds ?? 60;
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 15 ||
    ttlSeconds > 300
  ) {
    throw presenceError("INVALID_PRESENCE_TTL", 400);
  }
  const result = await db.pool.query<Record<string, unknown>>(
    `update workspace_session_participants
        set last_seen_at=now(),
            presence_expires_at=now()+make_interval(secs => $3)
      where session_id=$1 and user_id=$2 and left_at is null
      returning session_id,user_id,role,last_seen_at,presence_expires_at`,
    [input.sessionId, input.actorId, ttlSeconds],
  );
  const row = result.rows[0];
  if (!row) throw presenceError("SESSION_NOT_FOUND", 404);
  return normalizePresence(row);
}

export async function listWorkspacePresence(
  db: Postgres,
  sessionId: string,
  actorId: string,
): Promise<WorkspacePresenceRecord[]> {
  const participant = await db.pool.query(
    `select 1 from workspace_session_participants
      where session_id=$1 and user_id=$2 and left_at is null`,
    [sessionId, actorId],
  );
  if (!participant.rowCount) throw presenceError("SESSION_NOT_FOUND", 404);
  const result = await db.pool.query<Record<string, unknown>>(
    `select session_id,user_id,role,last_seen_at,presence_expires_at
       from workspace_session_participants
      where session_id=$1 and left_at is null
      order by role,user_id`,
    [sessionId],
  );
  return result.rows.map(normalizePresence);
}
