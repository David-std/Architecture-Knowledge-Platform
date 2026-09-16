from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if text.count(old) != 1:
        raise SystemExit(f"{label} anchor changed: {text.count(old)}")
    return text.replace(old, new, 1)


Path("db/migrations/034_principal_identity.sql").write_text(
    """-- P2 first-class principal identity. User identity remains the compatibility
-- anchor for existing RBAC; scoped process credentials add a distinct audit and
-- policy identity without granting broader authority than the parent user.
create table principals (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (
    kind in ('HUMAN','AGENT_PROCESS','SERVICE_ACCOUNT','CONNECTOR','MAINTENANCE_JOB')
  ),
  user_id uuid references users(id),
  parent_principal_id uuid references principals(id),
  session_id uuid references agent_sessions(id),
  display_name text not null check (char_length(display_name) between 1 and 200),
  allowed_actions text[] not null default '{}',
  policy_revision bigint not null default 1 check (policy_revision >= 1),
  state text not null default 'ACTIVE' check (state in ('ACTIVE','REVOKED')),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (
    (kind='HUMAN' and user_id is not null and parent_principal_id is null and session_id is null)
    or
    (kind='AGENT_PROCESS' and user_id is not null and parent_principal_id is not null and session_id is not null)
    or
    kind in ('SERVICE_ACCOUNT','CONNECTOR','MAINTENANCE_JOB')
  )
);

create unique index principals_human_user_idx
  on principals(user_id)
  where kind='HUMAN';
create index principals_parent_idx on principals(parent_principal_id,state);
create index principals_session_idx on principals(session_id,state);

insert into principals(kind,user_id,display_name,allowed_actions)
select 'HUMAN',id,display_name,array['*']::text[]
  from users
on conflict do nothing;

create or replace function ensure_human_principal_for_user()
returns trigger language plpgsql as $$
begin
  insert into principals(kind,user_id,display_name,allowed_actions)
  values('HUMAN',new.id,new.display_name,array['*']::text[])
  on conflict do nothing;
  return new;
end;
$$;

create trigger users_create_human_principal
  after insert on users
  for each row execute function ensure_human_principal_for_user();

create table principal_credentials (
  id uuid primary key default gen_random_uuid(),
  principal_id uuid not null references principals(id),
  user_id uuid not null references users(id),
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  label text not null check (char_length(label) between 1 and 200),
  scopes jsonb not null default '{"spaces":[]}'::jsonb,
  allowed_actions text[] not null default '{}',
  policy_revision bigint not null check (policy_revision >= 1),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index principal_credentials_principal_idx
  on principal_credentials(principal_id,revoked_at,expires_at);

alter table audit_events
  add column principal_id uuid references principals(id);
update audit_events target
   set principal_id=principal.id
  from principals principal
 where principal.kind='HUMAN'
   and principal.user_id=target.actor_id
   and target.principal_id is null;
create index audit_events_principal_idx
  on audit_events(principal_id,created_at desc);
"""
)

Path("packages/postgres/src/principals.ts").write_text(
    '''import type { Postgres } from "./index.js";

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
  displayName: string;
  allowedActions: string[];
  policyRevision: number;
  state: "ACTIVE" | "REVOKED";
  revokedAt: Date | null;
}

function principalError(code: string, statusCode: number): Error {
  const error = new Error(code) as Error & { code?: string; statusCode?: number };
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
      `select p.*
         from principals p
         join workspace_session_participants participant
           on participant.session_id=$3
          and participant.user_id=$2
          and participant.left_at is null
        where p.id=$1
          and p.user_id=$2
          and p.kind='HUMAN'
          and p.state='ACTIVE'
        for update of p`,
      [input.parentPrincipalId, input.userId, input.sessionId],
    );
    if (!parent.rowCount) throw principalError("PRINCIPAL_PARENT_NOT_AUTHORIZED", 403);
    const created = await client.query<Record<string, unknown>>(
      `insert into principals(
         kind,user_id,parent_principal_id,session_id,display_name,allowed_actions
       ) values('AGENT_PROCESS',$1,$2,$3,$4,$5::text[])
       returning *`,
      [
        input.userId,
        input.parentPrincipalId,
        input.sessionId,
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
    await client.query("commit");
    return normalizePrincipal(row);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
'''
)

index = Path("packages/postgres/src/index.ts")
text = index.read_text()
anchor = 'export * from "./workspace-coordination.js";\n'
if anchor not in text:
    raise SystemExit("postgres export anchor changed")
text = text.replace(anchor, anchor + 'export * from "./principals.js";\n', 1)
index.write_text(text)

auth = Path("apps/api/src/auth.ts")
text = auth.read_text()
text = replace_once(
    text,
    '  authenticationKind: "API_TOKEN" | "WEB_SESSION";\n',
    '  authenticationKind: "API_TOKEN" | "WEB_SESSION" | "PRINCIPAL_TOKEN";\n  principalId: string;\n  principalKind: "HUMAN" | "AGENT_PROCESS" | "SERVICE_ACCOUNT" | "CONNECTOR" | "MAINTENANCE_JOB";\n  parentPrincipalId: string | null;\n  principalSessionId: string | null;\n  principalAllowedActions: string[];\n  principalPolicyRevision: number;\n',
    "actor principal fields",
)
text = replace_once(
    text,
    '  token_scopes: unknown;\n  id: string;\n',
    '  token_scopes: unknown;\n  principal_id: string | null;\n  credential_policy_revision: number | null;\n  credential_allowed_actions: string[] | null;\n  id: string;\n',
    "auth row principal fields",
)

old_credential = '''        select id token_id,user_id,token_hash credential_hash,null::text csrf_hash,
               null::uuid session_id,'API_TOKEN'::text authentication_kind,scopes token_scopes
          from api_tokens
         where revoked_at is null
           and (expires_at is null or expires_at > now())
           and token_hash=$1
        union all
        select null::uuid token_id,user_id,token_hash,csrf_hash,id,'WEB_SESSION'::text,
               scopes token_scopes
          from web_sessions
         where revoked_at is null and expires_at > now() and token_hash=$1
'''
new_credential = '''        select id token_id,user_id,token_hash credential_hash,null::text csrf_hash,
               null::uuid session_id,'API_TOKEN'::text authentication_kind,scopes token_scopes,
               null::uuid principal_id,null::bigint credential_policy_revision,
               array['*']::text[] credential_allowed_actions
          from api_tokens
         where revoked_at is null
           and (expires_at is null or expires_at > now())
           and token_hash=$1
        union all
        select null::uuid token_id,user_id,token_hash,csrf_hash,id,'WEB_SESSION'::text,
               scopes token_scopes,null::uuid,null::bigint,array['*']::text[]
          from web_sessions
         where revoked_at is null and expires_at > now() and token_hash=$1
        union all
        select id token_id,user_id,token_hash,null::text,null::uuid,
               'PRINCIPAL_TOKEN'::text,scopes,principal_id,policy_revision,allowed_actions
          from principal_credentials
         where revoked_at is null and expires_at > now() and token_hash=$1
'''
text = replace_once(text, old_credential, new_credential, "credential union")
text = replace_once(
    text,
    '''      select c.credential_hash,c.csrf_hash,c.session_id,c.authentication_kind,c.token_id,c.token_scopes,
             u.id, u.email,
''',
    '''      select c.credential_hash,c.csrf_hash,c.session_id,c.authentication_kind,c.token_id,c.token_scopes,
             c.principal_id,c.credential_policy_revision,c.credential_allowed_actions,
             u.id, u.email,
''',
    "credential select",
)
text = replace_once(
    text,
    '''       group by c.credential_hash,c.csrf_hash,c.session_id,c.authentication_kind,c.token_id,c.token_scopes,u.id,u.email
''',
    '''       group by c.credential_hash,c.csrf_hash,c.session_id,c.authentication_kind,c.token_id,c.token_scopes,
                c.principal_id,c.credential_policy_revision,c.credential_allowed_actions,u.id,u.email
''',
    "credential group",
)

fingerprint_old = '''function idempotencyScopeFingerprint(
  authenticationKind: Actor["authenticationKind"],
  credentialId: string,
  memberships: Actor["memberships"],
  tokenScopes: unknown,
  vaultAuthorizationState: readonly Record<string, unknown>[],
): string {'''
fingerprint_new = '''function idempotencyScopeFingerprint(
  authenticationKind: Actor["authenticationKind"],
  credentialId: string,
  memberships: Actor["memberships"],
  tokenScopes: unknown,
  vaultAuthorizationState: readonly Record<string, unknown>[],
  principal: {
    id: string;
    kind: string;
    policyRevision: number;
    allowedActions: string[];
  },
): string {'''
text = replace_once(text, fingerprint_old, fingerprint_new, "fingerprint signature")
text = replace_once(
    text,
    '''        tokenScopes,
        vaultAuthorizationState: vaultAuthorizationState
''',
    '''        tokenScopes,
        principal: {
          ...principal,
          allowedActions: [...principal.allowedActions].sort(),
        },
        vaultAuthorizationState: vaultAuthorizationState
''',
    "fingerprint body",
)

principal_resolution_anchor = '''    const databaseMemberships = (row.memberships ?? []).flatMap(
'''
principal_resolution = '''    const principalResult = await db.pool.query<Record<string, unknown>>(
      `select p.id,p.kind,p.parent_principal_id,p.session_id,p.allowed_actions,
              p.policy_revision,p.state
         from principals p
        where p.id=coalesce(
          $1::uuid,
          (select id from principals where kind='HUMAN' and user_id=$2 limit 1)
        )
        limit 1`,
      [row.principal_id, row.id],
    );
    const principal = principalResult.rows[0];
    if (!principal || principal.state !== "ACTIVE") {
      await reply.code(401).send({ code: "INVALID_TOKEN" });
      return;
    }
    if (
      String(row.authentication_kind) === "PRINCIPAL_TOKEN" &&
      Number(row.credential_policy_revision) !== Number(principal.policy_revision)
    ) {
      await reply.code(401).send({ code: "PRINCIPAL_POLICY_CHANGED" });
      return;
    }
    const principalActions = Array.isArray(principal.allowed_actions)
      ? principal.allowed_actions.map(String)
      : [];
    const credentialActions = Array.isArray(row.credential_allowed_actions)
      ? row.credential_allowed_actions.map(String)
      : [];
    const principalAllowedActions = principalActions.includes("*")
      ? credentialActions
      : credentialActions.filter((action) => principalActions.includes(action));

'''
if text.count(principal_resolution_anchor) != 1:
    raise SystemExit("principal resolution anchor changed")
text = text.replace(principal_resolution_anchor, principal_resolution + principal_resolution_anchor, 1)

actor_old = '''      authenticationKind,
      idempotencyScopeFingerprint: idempotencyScopeFingerprint(
        authenticationKind,
        credentialId,
        memberships,
        row.token_scopes,
        vaultAuthorizationState.rows as Array<Record<string, unknown>>,
      ),
'''
actor_new = '''      authenticationKind,
      principalId: String(principal.id),
      principalKind: String(principal.kind) as Actor["principalKind"],
      parentPrincipalId: principal.parent_principal_id
        ? String(principal.parent_principal_id)
        : null,
      principalSessionId: principal.session_id ? String(principal.session_id) : null,
      principalAllowedActions,
      principalPolicyRevision: Number(principal.policy_revision),
      idempotencyScopeFingerprint: idempotencyScopeFingerprint(
        authenticationKind,
        credentialId,
        memberships,
        row.token_scopes,
        vaultAuthorizationState.rows as Array<Record<string, unknown>>,
        {
          id: String(principal.id),
          kind: String(principal.kind),
          policyRevision: Number(principal.policy_revision),
          allowedActions: principalAllowedActions,
        },
      ),
'''
text = replace_once(text, actor_old, actor_new, "actor construction")

helper_anchor = '''export function requirePermission(
  permission: Permission,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {'''
principal_helpers = '''export function hasPrincipalAction(
  actor: Actor | null,
  action: string,
): boolean {
  return Boolean(
    actor &&
      (actor.principalAllowedActions.includes("*") ||
        actor.principalAllowedActions.includes(action)),
  );
}

export function requirePrincipalAction(
  action: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const actor = actorOf(request);
    if (!actor) {
      await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      return;
    }
    if (!hasPrincipalAction(actor, action)) {
      await reply.code(403).send({ code: "PRINCIPAL_ACTION_DENIED", action });
    }
  };
}

'''
if text.count(helper_anchor) != 1:
    raise SystemExit("permission helper anchor changed")
text = text.replace(helper_anchor, principal_helpers + helper_anchor, 1)

audit_old = '''    insert into audit_events(organization_id, space_id, actor_id, action, resource_type,
                             resource_id, metadata, trace_id, vault_id)
    select organization_id,$1,$2,$3,$4,$5,$6::jsonb,$7,
'''
audit_new = '''    insert into audit_events(organization_id, space_id, actor_id, principal_id, action, resource_type,
                             resource_id, metadata, trace_id, vault_id)
    select organization_id,$1,$2,$3,$4,$5,$6,$7::jsonb,$8,
'''
text = replace_once(text, audit_old, audit_new, "audit insert")
audit_case_old = '''           case when exists(
             select 1 from vaults where id=$8::uuid and space_id=$1
           ) then $8::uuid else null end
'''
audit_case_new = '''           case when exists(
             select 1 from vaults where id=$9::uuid and space_id=$1
           ) then $9::uuid else null end
'''
text = replace_once(text, audit_case_old, audit_case_new, "audit vault case")
audit_params_old = '''      actor?.id ?? null,
      action,
      resourceType,
      resourceId ?? null,
      JSON.stringify(sanitizedMetadata),
      request.id,
      candidateVaultId,
'''
audit_params_new = '''      actor?.id ?? null,
      actor?.principalId ?? null,
      action,
      resourceType,
      resourceId ?? null,
      JSON.stringify(sanitizedMetadata),
      request.id,
      candidateVaultId,
'''
text = replace_once(text, audit_params_old, audit_params_new, "audit params")
auth.write_text(text)

idempotency = Path("apps/api/src/idempotency.ts")
text = idempotency.read_text()
old = '''    if (request.url.split("?")[0] === "/v1/auth/session") return;
'''
new = '''    const requestPath = request.url.split("?")[0] ?? request.url;
    if (requestPath === "/v1/auth/session") return;
    // Agent-process issuance returns a one-time bearer secret. Persisting that
    // response in the generic idempotency journal would turn the journal into a
    // credential store, so this endpoint is deliberately excluded as well.
    if (/^\/v1\/sessions\/[^/]+\/agent-processes$/.test(requestPath)) return;
'''
text = replace_once(text, old, new, "idempotency credential exclusion")
idempotency.write_text(text)

web = Path("apps/api/src/routes/web-auth.ts")
text = web.read_text()
old = '''      if (actor.authenticationKind !== "API_TOKEN") {
        return reply.code(409).send({ code: "SESSION_ALREADY_ACTIVE" });
      }
'''
new = '''      if (actor.principalKind !== "HUMAN") {
        return reply.code(403).send({ code: "PRINCIPAL_WEB_SESSION_DENIED" });
      }
      if (actor.authenticationKind !== "API_TOKEN") {
        return reply.code(409).send({ code: "SESSION_ALREADY_ACTIVE" });
      }
'''
text = replace_once(text, old, new, "web session principal guard")
old = '''            authenticationKind: actor.authenticationKind,
'''
new = '''            authenticationKind: actor.authenticationKind,
            principalId: actor.principalId,
            principalKind: actor.principalKind,
            parentPrincipalId: actor.parentPrincipalId,
            principalSessionId: actor.principalSessionId,
            principalAllowedActions: actor.principalAllowedActions,
            principalPolicyRevision: actor.principalPolicyRevision,
'''
text = replace_once(text, old, new, "auth session principal output")
web.write_text(text)

sessions = Path("apps/api/src/routes/sessions.ts")
text = sessions.read_text()
text = text.replace(
    'import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";\n',
    'import { createHash, randomBytes } from "node:crypto";\nimport type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";\n',
    1,
)
text = text.replace(
    '''  addWorkspaceParticipant,
  appendWorkspaceEvent,
''',
    '''  AGENT_PROCESS_ALLOWED_ACTIONS,
  DEFAULT_AGENT_PROCESS_ACTIONS,
  addWorkspaceParticipant,
  appendWorkspaceEvent,
  createAgentProcessPrincipalCredential,
''',
    1,
)
text = text.replace(
    '''  resolveAuthorizedVaultScope,
  workspaceSessionSnapshot,
''',
    '''  resolveAuthorizedVaultScope,
  revokeAgentProcessPrincipal,
  workspaceSessionSnapshot,
''',
    1,
)
text = text.replace(
    '''  audit,
  requirePermission,
  unrestrictedSpaceIdsForPermission,
''',
    '''  audit,
  requirePermission,
  requirePrincipalAction,
  serializeEffectiveScopes,
  unrestrictedSpaceIdsForPermission,
''',
    1,
)
# Agent processes are hard-bound to the workspace session used at issuance.
old = '''  if (!session) {
    await reply.code(404).send({ code: "SESSION_NOT_FOUND" });
    return null;
  }
'''
new = '''  if (!session) {
    await reply.code(404).send({ code: "SESSION_NOT_FOUND" });
    return null;
  }
  if (
    actor.principalKind === "AGENT_PROCESS" &&
    actor.principalSessionId !== session.id
  ) {
    await reply.code(404).send({ code: "SESSION_NOT_FOUND" });
    return null;
  }
'''
text = replace_once(text, old, new, "bound session guard")
# List is also bound for agent processes.
old = '''      const sessions = await listWorkspaceSessionsForParticipant(
        db,
        actor.id,
        unrestrictedSpaces,
        fullVaultIds,
      );
      return { sessions };
'''
new = '''      const sessions = await listWorkspaceSessionsForParticipant(
        db,
        actor.id,
        unrestrictedSpaces,
        fullVaultIds,
      );
      return {
        sessions:
          actor.principalKind === "AGENT_PROCESS"
            ? sessions.filter((session) => session.id === actor.principalSessionId)
            : sessions,
      };
'''
text = replace_once(text, old, new, "bound session list")
# Add principal action gates to existing route preHandlers.
replacements = {
    '{ preHandler: requirePermission("knowledge:read") },\n    async (request, reply) => {\n      const actor = actorOf(request);': '{ preHandler: [requirePermission("knowledge:read"), requirePrincipalAction("workspace:read")] },\n    async (request, reply) => {\n      const actor = actorOf(request);',
}
# First occurrence is GET list only.
old_gate = list(replacements.keys())[0]
new_gate = list(replacements.values())[0]
if text.count(old_gate) < 1:
    raise SystemExit("session list prehandler anchor changed")
text = text.replace(old_gate, new_gate, 1)
# POST create: identify its generic prehandler by the Body declaration that follows list route.
create_marker = '"/v1/sessions",\n    { preHandler: requirePermission("knowledge:read") },'
if create_marker not in text:
    raise SystemExit("session create route anchor changed")
text = text.replace(
    create_marker,
    '"/v1/sessions",\n    { preHandler: [requirePermission("knowledge:read"), requirePrincipalAction("workspace:create")] },',
    1,
)
# State and mutation routes are unambiguous by path.
for path, action in [
    ('/v1/sessions/:id/state', 'workspace:read'),
    ('/v1/sessions/:id/participants', 'workspace:manage-participants'),
    ('/v1/sessions/:id/claims', 'workspace:claim'),
    ('/v1/sessions/:id/claims/heartbeat', 'workspace:claim'),
    ('/v1/sessions/:id/claims/handoff', 'workspace:handoff'),
    ('/v1/sessions/:id/events', 'workspace:event:append'),
]:
    path_anchor = f'"{path}",\n    {{ preHandler: requirePermission("knowledge:read") }},'
    if path_anchor not in text:
        raise SystemExit(f"route prehandler anchor changed: {path}")
    text = text.replace(
        path_anchor,
        f'"{path}",\n    {{ preHandler: [requirePermission("knowledge:read"), requirePrincipalAction("{action}")] }},',
        1,
    )

# Insert agent process issuance/revocation immediately before the generic events route.
event_route_anchor = '''  app.post<{
    Params: { id: string };
    Body: { eventType: string; payload: Record<string, unknown> };
  }>(
    "/v1/sessions/:id/events",
'''
agent_routes = '''  app.post<{
    Params: { id: string };
    Body: { label?: string; durationMinutes?: number; allowedActions?: string[] };
  }>(
    "/v1/sessions/:id/agent-processes",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:manage-agents"),
      ],
    },
    async (request, reply) => {
      const session = await authorizedSession(db, request, reply, request.params.id);
      if (!session) return;
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (actor.principalKind !== "HUMAN" || session.role !== "OWNER") {
        return reply.code(403).send({ code: "AGENT_PROCESS_ISSUER_DENIED" });
      }
      const label = request.body?.label?.trim() || "Workspace agent";
      if (label.length > 200) {
        return reply.code(400).send({ code: "INVALID_AGENT_LABEL" });
      }
      const requestedActions = request.body?.allowedActions ?? [
        ...DEFAULT_AGENT_PROCESS_ACTIONS,
      ];
      if (
        !requestedActions.length ||
        requestedActions.some(
          (action) =>
            typeof action !== "string" ||
            !(AGENT_PROCESS_ALLOWED_ACTIONS as readonly string[]).includes(action),
        )
      ) {
        return reply.code(400).send({ code: "INVALID_AGENT_ALLOWED_ACTIONS" });
      }
      const allowedActions = [...new Set(requestedActions)] as Array<
        (typeof AGENT_PROCESS_ALLOWED_ACTIONS)[number]
      >;
      const durationMinutes = Math.max(
        5,
        Math.min(Number(request.body?.durationMinutes ?? 60), 720),
      );
      if (!Number.isFinite(durationMinutes)) {
        return reply.code(400).send({ code: "INVALID_AGENT_DURATION" });
      }
      const effectiveScopes = serializeEffectiveScopes(actor);
      const scopes = {
        spaces: effectiveScopes.spaces
          .map((scope) => ({
            ...scope,
            permissions: scope.permissions.filter((permission) =>
              ["knowledge:read", "knowledge:propose"].includes(permission),
            ),
          }))
          .filter((scope) => scope.permissions.length > 0),
      };
      const token = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(token).digest("hex");
      const principal = await createAgentProcessPrincipalCredential(db, {
        parentPrincipalId: actor.principalId,
        userId: actor.id,
        sessionId: session.id,
        displayName: label,
        allowedActions,
        tokenHash,
        scopes,
        expiresAt: new Date(Date.now() + durationMinutes * 60_000),
      });
      await audit(
        db,
        request,
        "agent_process.create",
        "principal",
        principal.id,
        { vaultId: session.vaultId, sessionId: session.id },
        session.spaceId,
      );
      return reply.code(201).send({
        principal,
        token,
        authenticationKind: "PRINCIPAL_TOKEN",
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/v1/agent-processes/:id/revoke",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("workspace:manage-agents"),
      ],
    },
    async (request, reply) => {
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      if (actor.principalKind !== "HUMAN") {
        return reply.code(403).send({ code: "AGENT_PROCESS_ISSUER_DENIED" });
      }
      const principal = await revokeAgentProcessPrincipal(db, {
        principalId: request.params.id,
        parentPrincipalId: actor.principalId,
      });
      await audit(db, request, "agent_process.revoke", "principal", principal.id);
      return { principal };
    },
  );

'''
if text.count(event_route_anchor) != 1:
    raise SystemExit("event route insertion anchor changed")
text = text.replace(event_route_anchor, agent_routes + event_route_anchor, 1)
sessions.write_text(text)

# Human principals have wildcard actions; agent action guards must not reject existing traffic.
# The issuance route itself needs an action only humans possess via '*'.

# Add principal fields to auth/session and deny process-to-web-session escalation already above.

# Integration fixture for scoped process identity and revocation.
Path("apps/api/test/principal-auth.integration.test.ts").write_text(
    '''import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Postgres, grantVaultMembership } from "@akp/postgres";
import { buildServer } from "../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");

run("P2 principal identity", () => {
  const db = new Postgres(databaseUrl!);
  const app = buildServer();
  const humanToken = `principal-human-${randomUUID()}`;
  const humanHeaders = { authorization: `Bearer ${humanToken}` };
  const orgId = randomUUID();
  const userId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();
  let sessionId = "";

  beforeAll(async () => {
    await app.ready();
    await db.pool.query(
      `insert into organizations(id,slug,name) values($1,$2,$3)`,
      [orgId, `principal-${orgId}`, "Principal fixture"],
    );
    await db.pool.query(
      `insert into users(id,email,display_name) values($1,$2,$3)`,
      [userId, `principal-${userId}@example.test`, "Principal Human"],
    );
    await db.pool.query(
      `insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
       values($1,$2,$3,$4,'TEAM','')`,
      [spaceId, orgId, `principal-${spaceId}`, "Principal space"],
    );
    await db.pool.query(
      `insert into memberships(user_id,space_id,role) values($1,$2,'ADMIN')`,
      [userId, spaceId],
    );
    await db.pool.query(
      `insert into vaults(id,space_id,canonical_path,name,read_only,visibility,enabled)
       values($1,$2,$3,$4,true,'TEAM',true)`,
      [vaultId, spaceId, `/tmp/principal-${vaultId}`, "Principal vault"],
    );
    await grantVaultMembership(db, {
      userId,
      vaultId,
      role: "ADMIN",
      pathPrefix: null,
      permissions: [
        "knowledge:read",
        "source:read",
        "source:write",
        "knowledge:propose",
        "knowledge:review",
        "eval:run",
        "admin",
      ],
    });
    await db.pool.query(
      `insert into api_tokens(user_id,token_hash,label,scopes)
       values($1,$2,$3,$4::jsonb)`,
      [
        userId,
        tokenHash(humanToken),
        "principal human",
        JSON.stringify({
          spaces: [
            {
              spaceId,
              pathPrefix: null,
              permissions: [
                "knowledge:read",
                "source:read",
                "source:write",
                "knowledge:propose",
                "knowledge:review",
                "eval:run",
                "admin",
              ],
            },
          ],
        }),
      ],
    );
  });

  afterAll(async () => {
    await app.close();
    await db.pool.query("delete from organizations where id=$1", [orgId]);
    await db.close();
  });

  it("issues a session-bound agent principal with narrowed authority and revocable identity", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: humanHeaders,
      payload: {
        purpose: "Principal-bound workspace",
        contextBudget: 2048,
        spaceId,
        vaultId,
      },
    });
    expect(created.statusCode).toBe(201);
    sessionId = String(created.json().id);

    const other = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: humanHeaders,
      payload: {
        purpose: "Other parent workspace",
        contextBudget: 2048,
        spaceId,
        vaultId,
      },
    });
    expect(other.statusCode).toBe(201);
    const otherSessionId = String(other.json().id);

    const issued = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/agent-processes`,
      headers: {
        ...humanHeaders,
        "idempotency-key": "agent-secret-must-not-be-journaled",
      },
      payload: { label: "Compiler worker" },
    });
    expect(issued.statusCode).toBe(201);
    const issuance = issued.json() as {
      token: string;
      principal: {
        id: string;
        kind: string;
        parentPrincipalId: string;
        sessionId: string;
        policyRevision: number;
        allowedActions: string[];
      };
    };
    expect(issuance.token.length).toBeGreaterThan(30);
    expect(issuance.principal).toMatchObject({
      kind: "AGENT_PROCESS",
      sessionId,
      policyRevision: 1,
    });
    expect(issuance.principal.allowedActions).not.toContain("workspace:create");
    expect(issuance.principal.allowedActions).not.toContain("workspace:manage-participants");

    const humanPrincipal = await db.pool.query<{ id: string }>(
      "select id from principals where kind='HUMAN' and user_id=$1",
      [userId],
    );
    expect(issuance.principal.parentPrincipalId).toBe(humanPrincipal.rows[0]?.id);

    const durableCredential = await db.pool.query<{
      token_hash: string;
      scopes: { spaces?: Array<{ permissions?: string[] }> };
    }>(
      "select token_hash,scopes from principal_credentials where principal_id=$1",
      [issuance.principal.id],
    );
    expect(durableCredential.rows[0]?.token_hash).toBe(tokenHash(issuance.token));
    expect(durableCredential.rows[0]?.token_hash).not.toBe(issuance.token);
    expect(
      durableCredential.rows[0]?.scopes.spaces?.flatMap(
        (scope) => scope.permissions ?? [],
      ),
    ).not.toEqual(expect.arrayContaining(["knowledge:review", "admin"]));
    const idempotencyLeak = await db.pool.query(
      `select 1 from idempotency_records
        where operation like '%/agent-processes%'`,
    );
    expect(idempotencyLeak.rowCount).toBe(0);

    const agentHeaders = { authorization: `Bearer ${issuance.token}` };
    const identity = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: agentHeaders,
    });
    expect(identity.statusCode).toBe(200);
    expect(identity.json()).toMatchObject({
      actor: {
        id: userId,
        authenticationKind: "PRINCIPAL_TOKEN",
        principalId: issuance.principal.id,
        principalKind: "AGENT_PROCESS",
        parentPrincipalId: issuance.principal.parentPrincipalId,
        principalSessionId: sessionId,
      },
    });

    const ownState = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: agentHeaders,
    });
    expect(ownState.statusCode).toBe(200);
    const otherState = await app.inject({
      method: "GET",
      url: `/v1/sessions/${otherSessionId}/state`,
      headers: agentHeaders,
    });
    expect(otherState.statusCode).toBe(404);

    const createDenied = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: agentHeaders,
      payload: {
        purpose: "Escaped agent workspace",
        contextBudget: 1024,
        spaceId,
        vaultId,
      },
    });
    expect(createDenied.statusCode).toBe(403);
    expect(createDenied.json()).toMatchObject({ code: "PRINCIPAL_ACTION_DENIED" });

    const participantsDenied = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/participants`,
      headers: agentHeaders,
      payload: { userId },
    });
    expect(participantsDenied.statusCode).toBe(403);
    expect(participantsDenied.json()).toMatchObject({
      code: "PRINCIPAL_ACTION_DENIED",
    });

    const webEscalation = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      headers: agentHeaders,
      payload: {},
    });
    expect(webEscalation.statusCode).toBe(403);
    expect(webEscalation.json()).toMatchObject({
      code: "PRINCIPAL_WEB_SESSION_DENIED",
    });

    const claim = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: agentHeaders,
      payload: { workKey: "agent:compiler", leaseSeconds: 120 },
    });
    expect(claim.statusCode).toBe(201);
    const audit = await db.pool.query<{ actor_id: string; principal_id: string }>(
      `select actor_id,principal_id from audit_events
        where action='workspace.claim.acquire'
        order by id desc limit 1`,
    );
    expect(audit.rows[0]).toMatchObject({
      actor_id: userId,
      principal_id: issuance.principal.id,
    });

    const revoked = await app.inject({
      method: "POST",
      url: `/v1/agent-processes/${issuance.principal.id}/revoke`,
      headers: humanHeaders,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({
      principal: { id: issuance.principal.id, state: "REVOKED", policyRevision: 2 },
    });

    const afterRevocation = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/state`,
      headers: agentHeaders,
    });
    expect(afterRevocation.statusCode).toBe(401);
    expect(afterRevocation.json()).toMatchObject({ code: "INVALID_TOKEN" });
  });
});
'''
)
