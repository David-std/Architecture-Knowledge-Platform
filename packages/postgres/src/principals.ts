import type { Postgres } from "./index.js";
import { appendOutboxEvent } from "./outbox.js";

export type PrincipalKind =
  | "HUMAN"
  | "AGENT_PROCESS"
  | "SERVICE_ACCOUNT"
  | "CONNECTOR"
  | "MAINTENANCE_JOB";

export type PrincipalAction =
  | "workspace:read"
  | "workspace:create"
  | "workspace:manage-participants"
  | "workspace:manage-agents"
  | "workspace:claim"
  | "workspace:handoff"
  | "workspace:event:append"
  | "knowledge:read"
  | "knowledge:propose";

export const AGENT_PROCESS_ALLOWED_ACTIONS: readonly PrincipalAction[] = [
  "workspace:read",
  "workspace:claim",
  "workspace:handoff",
  "workspace:event:append",
  "knowledge:read",
  "knowledge:propose",
] as const;

export const DEFAULT_AGENT_PROCESS_ACTIONS: readonly PrincipalAction[] = [
  "workspace:read",
  "workspace:claim",
  "workspace:handoff",
  "workspace:event:append",
  "knowledge:read",
] as const;

export interface PrincipalRecord {
  id: string;
  kind: PrincipalKind;
  userId: string | null;
  parentPrincipalId: string | null;
  sessionId: string | null;
  vaultId: string | null;
  displayName: string;
  allowedActions: string[];
  policyRevision: number;
  state: "ACTIVE" | "REVOKED";
  revokedAt: Date | null;
}

function principalError(code: string, statusCode: number): Error {
  const error = new Error(code) as Error & {
    code?: string;
    statusCode?: number;
  };
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function normalizePrincipal(row: Record<string, unknown>): PrincipalRecord {
  return {
    id: String(row.id),
    kind: String(row.kind) as PrincipalKind,
    userId: row.user_id ? String(row.user_id) : null,
    parentPrincipalId: row.parent_principal_id
      ? String(row.parent_principal_id)
      : null,
    sessionId: row.session_id ? String(row.session_id) : null,
    vaultId: row.vault_id ? String(row.vault_id) : null,
    displayName: String(row.display_name),
    allowedActions: Array.isArray(row.allowed_actions)
      ? row.allowed_actions.map(String)
      : [],
    policyRevision: Number(row.policy_revision),
    state: String(row.state) as PrincipalRecord["state"],
    revokedAt: row.revoked_at ? new Date(String(row.revoked_at)) : null,
  };
}

export function isAgentProcessAction(value: string): value is PrincipalAction {
  return (AGENT_PROCESS_ALLOWED_ACTIONS as readonly string[]).includes(value);
}

export async function createAgentProcessPrincipalCredential(
  db: Postgres,
  input: {
    parentPrincipalId: string;
    userId: string;
    sessionId: string;
    displayName: string;
    allowedActions: PrincipalAction[];
    tokenHash: string;
    scopes: Record<string, unknown>;
    expiresAt: Date;
  },
): Promise<PrincipalRecord> {
  if (
    !input.allowedActions.length ||
    input.allowedActions.some((action) => !isAgentProcessAction(action))
  ) {
    throw principalError("INVALID_AGENT_ALLOWED_ACTIONS", 400);
  }
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const parent = await client.query<Record<string, unknown>>(
      `select p.*,session.vault_id
         from principals p
         join agent_sessions session
           on session.id=$3
          and session.vault_id is not null
         join vaults vault
           on vault.id=session.vault_id
          and vault.space_id=session.space_id
          and vault.enabled
         join workspace_session_participants participant
           on participant.session_id=session.id
          and participant.user_id=$2
          and participant.left_at is null
        where p.id=$1
          and p.user_id=$2
          and p.kind='HUMAN'
          and p.state='ACTIVE'
        for update of p`,
      [input.parentPrincipalId, input.userId, input.sessionId],
    );
    if (!parent.rowCount)
      throw principalError("PRINCIPAL_PARENT_NOT_AUTHORIZED", 403);
    const vaultId = parent.rows[0]?.vault_id
      ? String(parent.rows[0].vault_id)
      : "";
    if (!vaultId)
      throw principalError("AGENT_PROCESS_VAULT_SCOPE_REQUIRED", 409);
    const created = await client.query<Record<string, unknown>>(
      `insert into principals(
         kind,user_id,parent_principal_id,session_id,vault_id,display_name,allowed_actions
       ) values('AGENT_PROCESS',$1,$2,$3,$4,$5,$6::text[])
       returning *`,
      [
        input.userId,
        input.parentPrincipalId,
        input.sessionId,
        vaultId,
        input.displayName,
        input.allowedActions,
      ],
    );
    const row = created.rows[0];
    if (!row) throw principalError("AGENT_PROCESS_CREATE_FAILED", 500);
    await client.query(
      `insert into principal_credentials(
         principal_id,user_id,token_hash,label,scopes,allowed_actions,
         policy_revision,expires_at
       ) values($1,$2,$3,$4,$5::jsonb,$6::text[],$7,$8)`,
      [
        row.id,
        input.userId,
        input.tokenHash,
        input.displayName,
        JSON.stringify(input.scopes),
        input.allowedActions,
        row.policy_revision,
        input.expiresAt,
      ],
    );
    await client.query("commit");
    return normalizePrincipal(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeAgentProcessPrincipalInVaultScope(
  db: Postgres,
  input: { principalId: string; vaultIds: string[] },
): Promise<PrincipalRecord> {
  if (!input.vaultIds.length) {
    throw principalError("AGENT_PROCESS_NOT_FOUND", 404);
  }
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const existing = await client.query<Record<string, unknown>>(
      `select *
         from principals
        where id=$1
          and kind='AGENT_PROCESS'
          and vault_id=any($2::uuid[])
        for update`,
      [input.principalId, input.vaultIds],
    );
    const current = existing.rows[0];
    if (!current) throw principalError("AGENT_PROCESS_NOT_FOUND", 404);
    if (String(current.state) === "REVOKED") {
      await client.query("commit");
      return normalizePrincipal(current);
    }
    const revoked = await client.query<Record<string, unknown>>(
      `update principals
          set state='REVOKED',revoked_at=now(),policy_revision=policy_revision+1
        where id=$1
        returning *`,
      [input.principalId],
    );
    const row = revoked.rows[0];
    if (!row) throw principalError("AGENT_PROCESS_NOT_FOUND", 404);
    await client.query(
      `update principal_credentials
          set revoked_at=coalesce(revoked_at,now())
        where principal_id=$1`,
      [input.principalId],
    );
    const scope = await client.query<{
      space_id: string;
      vault_id: string;
    }>(
      `select space_id,vault_id
         from agent_sessions
        where id=$1 and vault_id=$2`,
      [row.session_id, row.vault_id],
    );
    const sessionScope = scope.rows[0];
    if (!sessionScope) {
      throw principalError("AGENT_PROCESS_SESSION_SCOPE_MISSING", 409);
    }
    await appendOutboxEvent(client, {
      eventType: "PrincipalRevoked",
      resourceId: String(row.id),
      spaceId: sessionScope.space_id,
      vaultId: sessionScope.vault_id,
      correlationId: row.session_id ? String(row.session_id) : null,
      payload: {
        principalId: String(row.id),
        parentPrincipalId: String(row.parent_principal_id),
        sessionId: String(row.session_id),
        kind: "AGENT_PROCESS",
        policyRevision: Number(row.policy_revision),
        revokedAt: row.revoked_at
          ? new Date(String(row.revoked_at)).toISOString()
          : new Date().toISOString(),
        authority: "ADMIN_VAULT_SCOPE",
      },
    });
    await client.query("commit");
    return normalizePrincipal(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeAgentProcessPrincipal(
  db: Postgres,
  input: { principalId: string; parentPrincipalId: string },
): Promise<PrincipalRecord> {
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const revoked = await client.query<Record<string, unknown>>(
      `update principals
          set state='REVOKED',revoked_at=now(),policy_revision=policy_revision+1
        where id=$1
          and parent_principal_id=$2
          and kind='AGENT_PROCESS'
          and state='ACTIVE'
        returning *`,
      [input.principalId, input.parentPrincipalId],
    );
    const row = revoked.rows[0];
    if (!row) throw principalError("AGENT_PROCESS_NOT_FOUND", 404);
    await client.query(
      `update principal_credentials
          set revoked_at=now()
        where principal_id=$1 and revoked_at is null`,
      [input.principalId],
    );
    const scope = await client.query<{
      space_id: string;
      vault_id: string;
    }>(
      `select space_id,vault_id
         from agent_sessions
        where id=$1 and vault_id=$2`,
      [row.session_id, row.vault_id],
    );
    const sessionScope = scope.rows[0];
    if (!sessionScope) {
      throw principalError("AGENT_PROCESS_SESSION_SCOPE_MISSING", 409);
    }
    await appendOutboxEvent(client, {
      eventType: "PrincipalRevoked",
      resourceId: String(row.id),
      spaceId: sessionScope.space_id,
      vaultId: sessionScope.vault_id,
      correlationId: row.session_id ? String(row.session_id) : null,
      payload: {
        principalId: String(row.id),
        parentPrincipalId: String(row.parent_principal_id),
        sessionId: String(row.session_id),
        kind: "AGENT_PROCESS",
        policyRevision: Number(row.policy_revision),
        revokedAt: row.revoked_at
          ? new Date(String(row.revoked_at)).toISOString()
          : new Date().toISOString(),
      },
    });
    await client.query("commit");
    return normalizePrincipal(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
