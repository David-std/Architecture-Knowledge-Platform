from pathlib import Path


def replace_between(text: str, start: str, end: str, replacement: str) -> str:
    if text.count(start) != 1:
        raise SystemExit(f"anchor changed: {start}")
    i = text.index(start)
    j = text.index(end, i)
    return text[:i] + replacement + text[j:]


Path("db/migrations/033_workspace_claim_scopes.sql").write_text(
    """-- P2 work-claim scopes. Keep exact logical keys compatible while allowing one
-- explicit hierarchical form: a terminal /** recursive scope.
alter table workspace_claims
  drop constraint if exists workspace_claims_work_key_check;

alter table workspace_claims
  add constraint workspace_claims_work_key_check
  check (
    char_length(work_key) between 1 and 200
    and (
      work_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      or (
        work_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,196}/\\*\\*$'
        and work_key !~ '//'
        and work_key !~ '(^|/)\\.{1,2}(/|$)'
      )
    )
  );
"""
)

module = Path("packages/postgres/src/workspace-coordination.ts")
text = module.read_text()
anchor = '''function assertLeaseSeconds(value: number): void {
  if (!Number.isSafeInteger(value) || value < 15 || value > 900) {
    throw workspaceError("INVALID_CLAIM_LEASE", 400);
  }
}
'''
helpers = anchor + '''
type WorkspaceWorkScope =
  | { mode: "EXACT"; key: string }
  | { mode: "PREFIX"; key: string };

const EXACT_WORK_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const PREFIX_WORK_KEY_PATTERN = /^(.+)\/\*\*$/;

export function workspaceWorkScope(value: string): WorkspaceWorkScope | null {
  if (value.length < 1 || value.length > 200) return null;
  const prefix = PREFIX_WORK_KEY_PATTERN.exec(value);
  if (prefix) {
    const key = prefix[1];
    if (!key || key.length > 197 || !EXACT_WORK_KEY_PATTERN.test(key)) return null;
    const segments = key.split("/");
    if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
      return null;
    }
    return { mode: "PREFIX", key };
  }
  return EXACT_WORK_KEY_PATTERN.test(value) ? { mode: "EXACT", key: value } : null;
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
    if (right.key === left.key || right.key.startsWith(`${left.key}/`)) return true;
  }
  if (right.mode === "PREFIX") {
    if (left.key === right.key || left.key.startsWith(`${right.key}/`)) return true;
  }
  return false;
}
'''
if text.count(anchor) != 1:
    raise SystemExit("lease helper anchor changed")
text = text.replace(anchor, helpers, 1)

claim_fn = '''export async function claimWorkspaceWork(
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
      workspaceScopesOverlap(requestedScope, requiredWorkScope(candidate.work_key)),
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

'''
text = replace_between(
    text,
    "export async function claimWorkspaceWork(",
    "export async function heartbeatWorkspaceWork(",
    claim_fn,
)
text = text.replace(
    '''  assertLeaseSeconds(input.leaseSeconds);
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const participant = await client.query(
''',
    '''  assertLeaseSeconds(input.leaseSeconds);
  requiredWorkScope(input.workKey);
  const client = await db.pool.connect();
  try {
    await client.query("begin");
    const participant = await client.query(
''',
    1,
)
# The handoff has the same lease preamble later in the file; add work-key validation there too.
handoff_start = text.index("export async function handoffWorkspaceWork(")
handoff_lease = text.index("  assertLeaseSeconds(input.leaseSeconds);", handoff_start)
insert_at = handoff_lease + len("  assertLeaseSeconds(input.leaseSeconds);\n")
text = text[:insert_at] + "  requiredWorkScope(input.workKey);\n" + text[insert_at:]
module.write_text(text)

route = Path("apps/api/src/routes/sessions.ts")
text = route.read_text()
text = text.replace(
    "  heartbeatWorkspaceWork,\n  listWorkspaceSessionsForParticipant,",
    "  heartbeatWorkspaceWork,\n  isWorkspaceWorkKey,\n  listWorkspaceSessionsForParticipant,",
    1,
)
text = text.replace(
    'const WORK_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;\n',
    "",
    1,
)
count = text.count("!WORK_KEY_PATTERN.test(workKey)")
if count < 3:
    raise SystemExit(f"expected work-key validators, found {count}")
text = text.replace("!WORK_KEY_PATTERN.test(workKey)", "!isWorkspaceWorkKey(workKey)")
route.write_text(text)

test = Path("apps/api/test/workspace-coordination.integration.test.ts")
text = test.read_text()
anchor = '''    const claimedByA = await app.inject({
'''
overlap_tests = '''    const compilerScope = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorAHeaders,
      payload: { workKey: "packages/compiler/**", leaseSeconds: 120 },
    });
    expect(compilerScope.statusCode).toBe(201);
    expect(compilerScope.json()).toMatchObject({
      ownerId: actorAId,
      workKey: "packages/compiler/**",
      fencingToken: 1,
    });

    const webScope = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey: "apps/web/**", leaseSeconds: 120 },
    });
    expect(webScope.statusCode).toBe(201);

    const overlap = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: {
        workKey: "packages/compiler/src/parser.ts",
        leaseSeconds: 120,
      },
    });
    expect(overlap.statusCode).toBe(409);
    expect(overlap.json()).toMatchObject({ code: "WORK_CLAIM_OVERLAP" });

    const overlapPrefix = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey: "packages/compiler/src/**", leaseSeconds: 120 },
    });
    expect(overlapPrefix.statusCode).toBe(409);
    expect(overlapPrefix.json()).toMatchObject({ code: "WORK_CLAIM_OVERLAP" });

    const invalidRecursiveScope = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/claims`,
      headers: actorBHeaders,
      payload: { workKey: "packages/**/compiler", leaseSeconds: 120 },
    });
    expect(invalidRecursiveScope.statusCode).toBe(400);
    expect(invalidRecursiveScope.json()).toMatchObject({ code: "INVALID_WORK_KEY" });

    const race = await Promise.all([
      app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/claims`,
        headers: actorAHeaders,
        payload: { workKey: "services/payments/**", leaseSeconds: 120 },
      }),
      app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/claims`,
        headers: actorBHeaders,
        payload: { workKey: "services/payments/api/**", leaseSeconds: 120 },
      }),
    ]);
    expect(race.map((response) => response.statusCode).sort()).toEqual([201, 409]);
    expect(race.find((response) => response.statusCode === 409)?.json()).toMatchObject({
      code: "WORK_CLAIM_OVERLAP",
    });

'''
if text.count(anchor) != 1:
    raise SystemExit("primary claim anchor changed")
text = text.replace(anchor, overlap_tests + anchor, 1)
test.write_text(text)
