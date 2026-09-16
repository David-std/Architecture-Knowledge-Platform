from pathlib import Path

postgres_path = Path("packages/postgres/src/team-context-fabric.ts")
postgres = postgres_path.read_text()
old = '''export async function applyWorkspaceOfflineDraft(
  db: Postgres,
  input: { draftId: string; actorId: string },
): Promise<WorkspaceOfflineDraftRecord> {
  const client = await db.pool.connect();'''
new = '''export async function applyWorkspaceOfflineDraft(
  db: Postgres,
  input: { draftId: string; sessionId: string; actorId: string },
): Promise<WorkspaceOfflineDraftRecord> {
  const client = await db.pool.connect();'''
if "sessionId: string; actorId: string" not in postgres:
    if old not in postgres:
        raise SystemExit("applyWorkspaceOfflineDraft signature changed")
    postgres = postgres.replace(old, new, 1)
old = '''      `select id,client_draft_id,session_id,space_id,vault_id,actor_id,
              base_revision_set_hash,event_type,payload,status,queued_at,
              reconciled_at,applied_event_id
         from workspace_offline_drafts
        where id=$1 and actor_id=$2
        for update`,
      [input.draftId, input.actorId],'''
new = '''      `select id,client_draft_id,session_id,space_id,vault_id,actor_id,
              base_revision_set_hash,event_type,payload,status,queued_at,
              reconciled_at,applied_event_id
         from workspace_offline_drafts
        where id=$1 and session_id=$2 and actor_id=$3
        for update`,
      [input.draftId, input.sessionId, input.actorId],'''
if "where id=$1 and session_id=$2 and actor_id=$3" not in postgres:
    if old not in postgres:
        raise SystemExit("offline draft select shape changed")
    postgres = postgres.replace(old, new, 1)
postgres_path.write_text(postgres)

routes_path = Path("apps/api/src/routes/context-fabric.ts")
routes = routes_path.read_text()
old = '''      const draft = await applyWorkspaceOfflineDraft(db, {
        draftId: request.params.draftId,
        actorId: actor.id,
      });
      if (draft.sessionId !== session.id) {
        return reply.code(404).send({ code: "OFFLINE_DRAFT_NOT_FOUND" });
      }'''
new = '''      let draft;
      try {
        draft = await applyWorkspaceOfflineDraft(db, {
          draftId: request.params.draftId,
          sessionId: session.id,
          actorId: actor.id,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "OFFLINE_DRAFT_NOT_FOUND"
        ) {
          return reply.code(404).send({ code: "OFFLINE_DRAFT_NOT_FOUND" });
        }
        throw error;
      }'''
if "sessionId: session.id," not in routes:
    if old not in routes:
        raise SystemExit("offline draft apply route shape changed")
    routes = routes.replace(old, new, 1)
routes_path.write_text(routes)

test_path = Path("apps/api/test/context-fabric.integration.test.ts")
test = test_path.read_text()
old = 'let sessionId = "";'
new = 'let sessionId = "";\nlet secondSessionId = "";'
if "let secondSessionId" not in test:
    if old not in test:
        raise SystemExit("context fabric test session state changed")
    test = test.replace(old, new, 1)
old = '''    if (sessionId) {
      await db.pool.query(
        "delete from audit_events where resource_id=$1 or metadata->>'sessionId'=$1",
        [sessionId],
      );
      await db.pool.query("delete from agent_sessions where id=$1", [
        sessionId,
      ]);
    }'''
new = '''    for (const id of [sessionId, secondSessionId].filter(Boolean)) {
      await db.pool.query(
        "delete from audit_events where resource_id=$1 or metadata->>'sessionId'=$1",
        [id],
      );
      await db.pool.query("delete from agent_sessions where id=$1", [id]);
    }'''
if "[sessionId, secondSessionId].filter(Boolean)" not in test:
    if old not in test:
        raise SystemExit("context fabric test cleanup shape changed")
    test = test.replace(old, new, 1)
anchor = '''    const applied = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts/${queuedDraft.id}/apply`,
      headers,
    });'''
insert = '''    const secondSession = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        spaceId,
        vaultId,
        purpose: "Cross-session offline draft scope fixture",
        contextBudget: 2048,
      },
    });
    expect(secondSession.statusCode).toBe(201);
    secondSessionId = String(secondSession.json().id);

    const crossSessionApply = await app.inject({
      method: "POST",
      url: `/v1/sessions/${secondSessionId}/offline-drafts/${queuedDraft.id}/apply`,
      headers,
    });
    expect(crossSessionApply.statusCode).toBe(404);
    expect(crossSessionApply.json()).toMatchObject({
      code: "OFFLINE_DRAFT_NOT_FOUND",
    });
    const afterCrossSessionAttempt = await db.pool.query<{
      status: string;
      applied_event_id: string | null;
    }>(
      `select status,applied_event_id
         from workspace_offline_drafts
        where id=$1`,
      [queuedDraft.id],
    );
    expect(afterCrossSessionAttempt.rows[0]).toMatchObject({
      status: "QUEUED",
      applied_event_id: null,
    });

''' + anchor
if "const crossSessionApply = await app.inject" not in test:
    if anchor not in test:
        raise SystemExit("context fabric apply test anchor changed")
    test = test.replace(anchor, insert, 1)
test_path.write_text(test)
