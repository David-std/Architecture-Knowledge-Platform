from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{label} anchor changed: {count}")
    return text.replace(old, new, 1)


# A principal is a dependent identity projection, not an independent owner of
# its user/session/vault. Removing one of those authorities must not leave a
# credential that blocks normal lifecycle cleanup or survives its scope.
migration = Path("db/migrations/034_principal_identity.sql")
text = migration.read_text()
for old, new, label in [
    (
        "  user_id uuid references users(id),\n",
        "  user_id uuid references users(id) on delete cascade,\n",
        "principal user lifecycle",
    ),
    (
        "  parent_principal_id uuid references principals(id),\n",
        "  parent_principal_id uuid references principals(id) on delete cascade,\n",
        "principal parent lifecycle",
    ),
    (
        "  session_id uuid references agent_sessions(id),\n",
        "  session_id uuid references agent_sessions(id) on delete cascade,\n",
        "principal session lifecycle",
    ),
    (
        "  vault_id uuid references vaults(id),\n",
        "  vault_id uuid references vaults(id) on delete cascade,\n",
        "principal vault lifecycle",
    ),
    (
        "  principal_id uuid not null references principals(id),\n",
        "  principal_id uuid not null references principals(id) on delete cascade,\n",
        "principal credential principal lifecycle",
    ),
    (
        "  user_id uuid not null references users(id),\n",
        "  user_id uuid not null references users(id) on delete cascade,\n",
        "principal credential user lifecycle",
    ),
]:
    text = replace_once(text, old, new, label)
migration.write_text(text)

# The generated integration fixture must satisfy the post-v0.3 vault registry
# contract. Give both vaults explicit stable keys instead of relying on legacy
# migration backfill that only runs before these test rows exist.
test = Path("apps/api/test/principal-auth.integration.test.ts")
text = test.read_text()
vault_insert = """`insert into vaults(id,space_id,canonical_path,name,read_only,visibility,enabled)
       values($1,$2,$3,$4,true,'TEAM',true)`"""
vault_insert_with_key = """`insert into vaults(id,space_id,canonical_path,name,vault_key,read_only,visibility,enabled)
       values($1,$2,$3,$4,$5,true,'TEAM',true)`"""
if text.count(vault_insert) != 2:
    raise SystemExit(f"principal fixture vault insert anchors changed: {text.count(vault_insert)}")
text = text.replace(vault_insert, vault_insert_with_key)
text = replace_once(
    text,
    '[vaultId, spaceId, `/tmp/principal-${vaultId}`, "Principal vault"],',
    '''[
        vaultId,
        spaceId,
        `/tmp/principal-${vaultId}`,
        "Principal vault",
        `principal-${vaultId.slice(0, 8)}`,
      ],''',
    "principal fixture main vault key",
)
text = replace_once(
    text,
    '''        `/tmp/principal-sibling-${siblingVaultId}`,
        "Principal sibling vault",
      ],''',
    '''        `/tmp/principal-sibling-${siblingVaultId}`,
        "Principal sibling vault",
        `principal-sibling-${siblingVaultId.slice(0, 8)}`,
      ],''',
    "principal fixture sibling vault key",
)

# This fixture creates two sessions and audit rows. Remove scoped dependants in
# explicit order so the test proves the new principal lifecycle without relying
# on the disposable database hiding teardown bugs.
old_cleanup = '''  afterAll(async () => {
    await app.close();
    await db.pool.query("delete from organizations where id=$1", [orgId]);
    await db.close();
  });
'''
new_cleanup = '''  afterAll(async () => {
    await app.close();
    await db.pool.query(
      "delete from audit_events where actor_id=$1 or principal_id in (select id from principals where user_id=$1)",
      [userId],
    );
    await db.pool.query(
      "delete from principals where user_id=$1 and kind='AGENT_PROCESS'",
      [userId],
    );
    await db.pool.query("delete from principals where user_id=$1", [userId]);
    await db.pool.query("delete from agent_sessions where actor_id=$1", [userId]);
    await db.pool.query("delete from api_tokens where user_id=$1", [userId]);
    await db.pool.query("delete from vault_memberships where user_id=$1", [userId]);
    await db.pool.query("delete from memberships where user_id=$1", [userId]);
    await db.pool.query("delete from users where id=$1", [userId]);
    await db.pool.query("delete from vaults where id=any($1::uuid[])", [
      [vaultId, siblingVaultId],
    ]);
    await db.pool.query("delete from spaces where id=$1", [spaceId]);
    await db.pool.query("delete from organizations where id=$1", [orgId]);
    await db.close();
  });
'''
text = replace_once(text, old_cleanup, new_cleanup, "principal fixture cleanup")
test.write_text(text)
