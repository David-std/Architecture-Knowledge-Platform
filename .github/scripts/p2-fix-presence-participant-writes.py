from pathlib import Path

source_path = Path("packages/postgres/src/workspace-coordination.ts")
source = source_path.read_text()

old = '''    await client.query(
      `insert into workspace_session_participants(session_id,user_id,role)
       values($1,$2,'OWNER')`,
      [row.id, input.actorId],
    );'''
new = '''    await client.query(
      `insert into workspace_session_participants(
         session_id,user_id,role,last_seen_at
       ) values($1,$2,'OWNER',now())`,
      [row.id, input.actorId],
    );'''
if old in source:
    source = source.replace(old, new, 1)
elif "session_id,user_id,role,last_seen_at" not in source:
    raise SystemExit("owner participant insert shape changed")

old = '''        `update workspace_session_participants
            set left_at=null,
                joined_at=now(),
                role=case when role='OWNER' then 'OWNER' else 'PARTICIPANT' end
          where session_id=$1 and user_id=$2
          returning role`,'''
new = '''        `update workspace_session_participants
            set left_at=null,
                joined_at=now(),
                last_seen_at=now(),
                presence_expires_at=null,
                role=case when role='OWNER' then 'OWNER' else 'PARTICIPANT' end
          where session_id=$1 and user_id=$2
          returning role`,'''
if old in source:
    source = source.replace(old, new, 1)
elif "presence_expires_at=null" not in source:
    raise SystemExit("participant rejoin shape changed")

old = '''      await client.query(
        `insert into workspace_session_participants(session_id,user_id,role,left_at)
         values($1,$2,'PARTICIPANT',null)`,
        [input.sessionId, input.userId],
      );'''
new = '''      await client.query(
        `insert into workspace_session_participants(
           session_id,user_id,role,left_at,last_seen_at
         ) values($1,$2,'PARTICIPANT',null,now())`,
        [input.sessionId, input.userId],
      );'''
if old in source:
    source = source.replace(old, new, 1)
elif "role,left_at,last_seen_at" not in source:
    raise SystemExit("participant insert shape changed")

source_path.write_text(source)

test_path = Path("apps/api/test/workspace-presence.integration.test.ts")
test = test_path.read_text()
anchor = '''    const invalid = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/presence/heartbeat`,'''
insert = '''    const initialPresence = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/presence`,
      headers,
    });
    expect(initialPresence.statusCode).toBe(200);
    expect(
      (
        initialPresence.json() as {
          participants: Array<{
            userId: string;
            lastSeenAt: string;
            online: boolean;
          }>;
        }
      ).participants,
    ).toContainEqual(
      expect.objectContaining({
        userId: actorId,
        lastSeenAt: expect.any(String),
        online: false,
      }),
    );

''' + anchor
if "const initialPresence = await app.inject" not in test:
    if anchor not in test:
        raise SystemExit("workspace presence test anchor changed")
    test = test.replace(anchor, insert, 1)
test_path.write_text(test)
