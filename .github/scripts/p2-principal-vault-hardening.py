from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} anchor changed: {count}")
    return text.replace(old, new, 1)


# The process principal is not merely session-bound. Persist the vault derived
# from that session as part of the immutable principal identity so ambient
# user membership in sibling vaults can never become process authority.
migration = Path("db/migrations/034_principal_identity.sql")
text = migration.read_text()
text = replace_once(
    text,
    "  session_id uuid references agent_sessions(id),\n",
    "  session_id uuid references agent_sessions(id),\n  vault_id uuid references vaults(id),\n",
    "principal vault column",
)
text = replace_once(
    text,
    "    (kind='HUMAN' and user_id is not null and parent_principal_id is null and session_id is null)\n",
    "    (kind='HUMAN' and user_id is not null and parent_principal_id is null and session_id is null and vault_id is null)\n",
    "human vault shape",
)
text = replace_once(
    text,
    "    (kind='AGENT_PROCESS' and user_id is not null and parent_principal_id is not null and session_id is not null)\n",
    "    (kind='AGENT_PROCESS' and user_id is not null and parent_principal_id is not null and session_id is not null and vault_id is not null)\n",
    "agent vault shape",
)
text = replace_once(
    text,
    "create index principals_session_idx on principals(session_id,state);\n",
    "create index principals_session_idx on principals(session_id,state);\ncreate index principals_vault_idx on principals(vault_id,state);\n",
    "principal vault index",
)
text += """

-- Process scope is immutable after issuance. Revocation may change only the
-- lifecycle/policy fence; it cannot retarget the parent, workspace, vault or
-- allowed action set in place.
create or replace function akp_guard_principal_scope_identity()
returns trigger language plpgsql as $$
begin
  if row(
    new.kind,new.user_id,new.parent_principal_id,new.session_id,new.vault_id,
    new.display_name,new.allowed_actions,new.created_at
  ) is distinct from row(
    old.kind,old.user_id,old.parent_principal_id,old.session_id,old.vault_id,
    old.display_name,old.allowed_actions,old.created_at
  ) then
    raise exception 'PRINCIPAL_SCOPE_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger principals_guard_scope_identity
  before update on principals
  for each row execute function akp_guard_principal_scope_identity();

create or replace function akp_guard_principal_credential_scope()
returns trigger language plpgsql as $$
begin
  if row(
    new.principal_id,new.user_id,new.token_hash,new.label,new.scopes,
    new.allowed_actions,new.policy_revision,new.expires_at,new.created_at
  ) is distinct from row(
    old.principal_id,old.user_id,old.token_hash,old.label,old.scopes,
    old.allowed_actions,old.policy_revision,old.expires_at,old.created_at
  ) then
    raise exception 'PRINCIPAL_CREDENTIAL_SCOPE_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger principal_credentials_guard_scope
  before update on principal_credentials
  for each row execute function akp_guard_principal_credential_scope();
"""
migration.write_text(text)

principals = Path("packages/postgres/src/principals.ts")
text = principals.read_text()
text = replace_once(
    text,
    "  sessionId: string | null;\n  displayName: string;\n",
    "  sessionId: string | null;\n  vaultId: string | null;\n  displayName: string;\n",
    "principal record vault",
)
text = replace_once(
    text,
    "    sessionId: row.session_id ? String(row.session_id) : null,\n    displayName: String(row.display_name),\n",
    "    sessionId: row.session_id ? String(row.session_id) : null,\n    vaultId: row.vault_id ? String(row.vault_id) : null,\n    displayName: String(row.display_name),\n",
    "normalize principal vault",
)
old_parent = '''      `select p.*
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
'''
new_parent = '''      `select p.*,session.vault_id
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
'''
text = replace_once(text, old_parent, new_parent, "derive agent vault from session")
text = replace_once(
    text,
    "    if (!parent.rowCount) throw principalError(\"PRINCIPAL_PARENT_NOT_AUTHORIZED\", 403);\n    const created = await client.query<Record<string, unknown>>(\n",
    "    if (!parent.rowCount) throw principalError(\"PRINCIPAL_PARENT_NOT_AUTHORIZED\", 403);\n    const vaultId = parent.rows[0]?.vault_id ? String(parent.rows[0].vault_id) : \"\";\n    if (!vaultId) throw principalError(\"AGENT_PROCESS_VAULT_SCOPE_REQUIRED\", 409);\n    const created = await client.query<Record<string, unknown>>(\n",
    "agent vault extraction",
)
text = replace_once(
    text,
    '''      `insert into principals(
         kind,user_id,parent_principal_id,session_id,display_name,allowed_actions
       ) values('AGENT_PROCESS',$1,$2,$3,$4,$5::text[])
       returning *`,
''',
    '''      `insert into principals(
         kind,user_id,parent_principal_id,session_id,vault_id,display_name,allowed_actions
       ) values('AGENT_PROCESS',$1,$2,$3,$4,$5,$6::text[])
       returning *`,
''',
    "agent insert vault column",
)
text = replace_once(
    text,
    '''        input.sessionId,
        input.displayName,
        input.allowedActions,
''',
    '''        input.sessionId,
        vaultId,
        input.displayName,
        input.allowedActions,
''',
    "agent insert vault value",
)
principals.write_text(text)

auth = Path("apps/api/src/auth.ts")
text = auth.read_text()
text = replace_once(
    text,
    "  principalSessionId: string | null;\n  principalAllowedActions: string[];\n",
    "  principalSessionId: string | null;\n  principalVaultId: string | null;\n  principalAllowedActions: string[];\n",
    "actor principal vault",
)
text = replace_once(
    text,
    "      `select p.id,p.kind,p.parent_principal_id,p.session_id,p.allowed_actions,\n              p.policy_revision,p.state\n",
    "      `select p.id,p.kind,p.parent_principal_id,p.session_id,p.vault_id,p.allowed_actions,\n              p.policy_revision,p.state\n",
    "auth principal vault select",
)
text = replace_once(
    text,
    '''  principal: {
    id: string;
    kind: string;
    policyRevision: number;
    allowedActions: string[];
  },
''',
    '''  principal: {
    id: string;
    kind: string;
    vaultId: string | null;
    policyRevision: number;
    allowedActions: string[];
  },
''',
    "fingerprint principal vault type",
)
text = replace_once(
    text,
    '''      principalSessionId: principal.session_id ? String(principal.session_id) : null,
      principalAllowedActions,
''',
    '''      principalSessionId: principal.session_id ? String(principal.session_id) : null,
      principalVaultId: principal.vault_id ? String(principal.vault_id) : null,
      principalAllowedActions,
''',
    "actor principal vault value",
)
text = replace_once(
    text,
    '''          kind: String(principal.kind),
          policyRevision: Number(principal.policy_revision),
''',
    '''          kind: String(principal.kind),
          vaultId: principal.vault_id ? String(principal.vault_id) : null,
          policyRevision: Number(principal.policy_revision),
''',
    "fingerprint principal vault value",
)

register_anchor = '''export function registerAuthentication(
  app: FastifyInstance,
  db: Postgres,
): void {'''
allowlist = '''function agentProcessRouteAction(
  method: string,
  requestPath: string,
): string | null {
  if (requestPath === "/v1/auth/session" && ["GET", "POST"].includes(method)) {
    return "workspace:read";
  }
  if (requestPath === "/v1/sessions" && method === "GET") {
    return "workspace:read";
  }
  if (/^\/v1\/sessions\/[^/]+\/state$/.test(requestPath) && method === "GET") {
    return "workspace:read";
  }
  if (/^\/v1\/sessions\/[^/]+\/claims$/.test(requestPath) && method === "POST") {
    return "workspace:claim";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/claims\/heartbeat$/.test(requestPath) &&
    method === "POST"
  ) {
    return "workspace:claim";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/claims\/handoff$/.test(requestPath) &&
    method === "POST"
  ) {
    return "workspace:handoff";
  }
  if (/^\/v1\/sessions\/[^/]+\/events$/.test(requestPath) && method === "POST") {
    return "workspace:event:append";
  }
  if (["/v1/search", "/v1/context"].includes(requestPath) && method === "POST") {
    return "knowledge:read";
  }
  if (requestPath === "/v1/proposals" && method === "POST") {
    return "knowledge:propose";
  }
  return null;
}

'''
text = replace_once(text, register_anchor, allowlist + register_anchor, "agent route allowlist")
assignment = '''    (request as FastifyRequest & { actor: Actor }).actor = actor;
    if (actor.sessionId) {
'''
assignment_new = '''    (request as FastifyRequest & { actor: Actor }).actor = actor;
    if (actor.principalKind === "AGENT_PROCESS") {
      if (!actor.principalSessionId || !actor.principalVaultId) {
        await reply.code(401).send({ code: "PRINCIPAL_SCOPE_INVALID" });
        return;
      }
      const requestPath = request.url.split("?")[0] ?? request.url;
      const requiredAction = agentProcessRouteAction(request.method, requestPath);
      if (!requiredAction || !hasPrincipalAction(actor, requiredAction)) {
        await reply.code(403).send({
          code: "PRINCIPAL_ROUTE_DENIED",
          ...(requiredAction ? { action: requiredAction } : {}),
        });
        return;
      }
    }
    if (actor.sessionId) {
'''
text = replace_once(text, assignment, assignment_new, "central agent route allowlist enforcement")
auth.write_text(text)

# Identity response exposes the immutable vault boundary so operators can
# inspect exactly what a process credential is allowed to act within.
web = Path("apps/api/src/routes/web-auth.ts")
text = web.read_text()
text = replace_once(
    text,
    "            principalSessionId: actor.principalSessionId,\n            principalAllowedActions: actor.principalAllowedActions,\n",
    "            principalSessionId: actor.principalSessionId,\n            principalVaultId: actor.principalVaultId,\n            principalAllowedActions: actor.principalAllowedActions,\n",
    "auth session output vault",
)
web.write_text(text)

search = Path("apps/api/src/routes/search.ts")
text = search.read_text()
text = replace_once(
    text,
    '''  pathPrefixesForPermission,
  requirePermission,
} from "../auth.js";
''',
    '''  pathPrefixesForPermission,
  requirePermission,
  requirePrincipalAction,
} from "../auth.js";
''',
    "search principal action import",
)
text = replace_once(
    text,
    '''    "/v1/search",
    { preHandler: requirePermission("knowledge:read") },
''',
    '''    "/v1/search",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("knowledge:read"),
      ],
    },
''',
    "search principal action gate",
)
text = replace_once(
    text,
    '''      if (!hasSpaceAccess(actor, requestedSpace, "knowledge:read")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      let vaultIds: string[];
''',
    '''      if (!hasSpaceAccess(actor, requestedSpace, "knowledge:read")) {
        return reply.code(403).send({ code: "SPACE_ACCESS_DENIED" });
      }
      const principalVaultId =
        actor.principalKind === "AGENT_PROCESS" ? actor.principalVaultId : null;
      const explicitlyRequestedVaults = [
        ...(parsed.data.vaultId ? [parsed.data.vaultId] : []),
        ...parsed.data.vaultIds,
      ];
      if (
        principalVaultId &&
        (parsed.data.federated ||
          explicitlyRequestedVaults.some((vaultId) => vaultId !== principalVaultId))
      ) {
        return reply.code(403).send({ code: "PRINCIPAL_VAULT_SCOPE_DENIED" });
      }
      let vaultIds: string[];
''',
    "search principal vault guard",
)
text = replace_once(
    text,
    '''          ...(parsed.data.vaultId ? { vaultId: parsed.data.vaultId } : {}),
          vaultIds: parsed.data.vaultIds,
          federated: parsed.data.federated,
''',
    '''          ...(principalVaultId
            ? { vaultId: principalVaultId }
            : parsed.data.vaultId
              ? { vaultId: parsed.data.vaultId }
              : {}),
          vaultIds: principalVaultId ? [principalVaultId] : parsed.data.vaultIds,
          federated: principalVaultId ? false : parsed.data.federated,
''',
    "search resolver principal vault",
)
text = replace_once(
    text,
    '''    "/v1/context",
    { preHandler: requirePermission("knowledge:read") },
''',
    '''    "/v1/context",
    {
      preHandler: [
        requirePermission("knowledge:read"),
        requirePrincipalAction("knowledge:read"),
      ],
    },
''',
    "context principal action gate",
)
context_anchor = '''      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      let vaultIds: string[];
'''
context_new = '''      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const principalVaultId =
        actor.principalKind === "AGENT_PROCESS" ? actor.principalVaultId : null;
      const explicitlyRequestedVaults = [
        ...(parsed.data.vaultId ? [parsed.data.vaultId] : []),
        ...parsed.data.vaultIds,
      ];
      if (
        principalVaultId &&
        (parsed.data.federated ||
          explicitlyRequestedVaults.some((vaultId) => vaultId !== principalVaultId))
      ) {
        return reply.code(403).send({ code: "PRINCIPAL_VAULT_SCOPE_DENIED" });
      }
      let vaultIds: string[];
'''
text = replace_once(text, context_anchor, context_new, "context principal vault guard")
# The resolver stanza occurs a second time for /v1/context after the /v1/search
# replacement above; replace the remaining exact legacy form.
text = replace_once(
    text,
    '''          ...(parsed.data.vaultId ? { vaultId: parsed.data.vaultId } : {}),
          vaultIds: parsed.data.vaultIds,
          federated: parsed.data.federated,
''',
    '''          ...(principalVaultId
            ? { vaultId: principalVaultId }
            : parsed.data.vaultId
              ? { vaultId: parsed.data.vaultId }
              : {}),
          vaultIds: principalVaultId ? [principalVaultId] : parsed.data.vaultIds,
          federated: principalVaultId ? false : parsed.data.federated,
''',
    "context resolver principal vault",
)
search.write_text(text)

reviews = Path("apps/api/src/routes/reviews.ts")
text = reviews.read_text()
text = replace_once(
    text,
    '''  requirePermission,
  spaceIdsForPermission,
} from "../auth.js";
''',
    '''  requirePermission,
  requirePrincipalAction,
  spaceIdsForPermission,
} from "../auth.js";
''',
    "reviews principal action import",
)
text = replace_once(
    text,
    '''    "/v1/proposals",
    { preHandler: requirePermission("knowledge:propose") },
''',
    '''    "/v1/proposals",
    {
      preHandler: [
        requirePermission("knowledge:propose"),
        requirePrincipalAction("knowledge:propose"),
      ],
    },
''',
    "proposal principal action gate",
)
proposal_anchor = '''      const actor = actorOf(request);
      let vaultAccess: ReviewVaultAccess | null = null;
'''
proposal_new = '''      const actor = actorOf(request);
      if (
        actor?.principalKind === "AGENT_PROCESS" &&
        actor.principalVaultId !== vaultId
      ) {
        return reply.code(403).send({ code: "PRINCIPAL_VAULT_SCOPE_DENIED" });
      }
      let vaultAccess: ReviewVaultAccess | null = null;
'''
text = replace_once(text, proposal_anchor, proposal_new, "proposal principal vault guard")
reviews.write_text(text)

# Extend the integration fixture with a sibling vault. The parent human may
# read both; the issued process still has exactly one immutable vault boundary.
test = Path("apps/api/test/principal-auth.integration.test.ts")
text = test.read_text()
text = replace_once(
    text,
    "  const vaultId = randomUUID();\n  let sessionId = \"\";\n",
    "  const vaultId = randomUUID();\n  const siblingVaultId = randomUUID();\n  let sessionId = \"\";\n",
    "principal test sibling vault id",
)
text = replace_once(
    text,
    '''    await grantVaultMembership(db, {
      userId,
      vaultId,
      role: "ADMIN",
''',
    '''    await db.pool.query(
      `insert into vaults(id,space_id,canonical_path,name,read_only,visibility,enabled)
       values($1,$2,$3,$4,true,'TEAM',true)`,
      [
        siblingVaultId,
        spaceId,
        `/tmp/principal-sibling-${siblingVaultId}`,
        "Principal sibling vault",
      ],
    );
    await grantVaultMembership(db, {
      userId,
      vaultId,
      role: "ADMIN",
''',
    "principal test create sibling vault",
)
# Add a second grant after the first grant closes.
first_grant_end = '''      ],
    });
    await db.pool.query(
      `insert into api_tokens(user_id,token_hash,label,scopes)
'''
second_grant = '''      ],
    });
    await grantVaultMembership(db, {
      userId,
      vaultId: siblingVaultId,
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
'''
text = replace_once(text, first_grant_end, second_grant, "principal test sibling grant")
text = replace_once(
    text,
    '''        sessionId: string;
        policyRevision: number;
''',
    '''        sessionId: string;
        vaultId: string;
        policyRevision: number;
''',
    "principal issuance test vault type",
)
text = replace_once(
    text,
    '''      kind: "AGENT_PROCESS",
      sessionId,
      policyRevision: 1,
''',
    '''      kind: "AGENT_PROCESS",
      sessionId,
      vaultId,
      policyRevision: 1,
''',
    "principal issuance test vault assertion",
)
text = replace_once(
    text,
    '''        principalSessionId: sessionId,
      },
''',
    '''        principalSessionId: sessionId,
        principalVaultId: vaultId,
      },
''',
    "principal identity vault assertion",
)
insert_before_create_denied = '''    const createDenied = await app.inject({
'''
adversarial = '''    const crossVaultSearch = await app.inject({
      method: "POST",
      url: "/v1/search",
      headers: agentHeaders,
      payload: {
        query: "cross vault escape",
        spaceId,
        vaultId: siblingVaultId,
      },
    });
    expect(crossVaultSearch.statusCode).toBe(403);
    expect(crossVaultSearch.json()).toMatchObject({
      code: "PRINCIPAL_VAULT_SCOPE_DENIED",
    });

    const ambientReadDenied = await app.inject({
      method: "GET",
      url: "/v1/indexes",
      headers: agentHeaders,
    });
    expect(ambientReadDenied.statusCode).toBe(403);
    expect(ambientReadDenied.json()).toMatchObject({
      code: "PRINCIPAL_ROUTE_DENIED",
    });

    const crossVaultProposal = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers: agentHeaders,
      payload: {
        spaceId,
        vaultId: siblingVaultId,
        summary: "must remain outside sibling vault",
        changes: [
          {
            path: "agent-scope-proof.md",
            content: "---\\nid: AGENT-SCOPE-PROOF\\ntitle: Agent scope proof\\ntype: note\\n---\\nDenied cross-vault proposal.\\n",
          },
        ],
      },
    });
    expect(crossVaultProposal.statusCode).toBe(403);
    expect(crossVaultProposal.json()).toMatchObject({
      code: "PRINCIPAL_VAULT_SCOPE_DENIED",
    });

'''
text = replace_once(
    text,
    insert_before_create_denied,
    adversarial + insert_before_create_denied,
    "principal adversarial vault tests",
)
test.write_text(text)
