from pathlib import Path


def replace_count(text: str, old: str, new: str, expected: int, label: str) -> str:
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{label} anchor changed: {count}")
    return text.replace(old, new)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    return replace_count(text, old, new, 1, label)


# Principals and their credentials are subordinate runtime identities. User,
# parent principal, session and vault deletion must not leave orphan process
# authority or break existing lifecycle/fixture deletion. Audit history remains
# durable, but its principal pointer becomes null when that principal is gone.
migration = Path("db/migrations/034_principal_identity.sql")
text = migration.read_text()
text = replace_count(
    text,
    "  user_id uuid references users(id),\n",
    "  user_id uuid references users(id) on delete cascade,\n",
    2,
    "principal user cascade",
)
text = replace_once(
    text,
    "  parent_principal_id uuid references principals(id),\n",
    "  parent_principal_id uuid references principals(id) on delete cascade,\n",
    "principal parent cascade",
)
text = replace_once(
    text,
    "  session_id uuid references agent_sessions(id),\n",
    "  session_id uuid references agent_sessions(id) on delete cascade,\n",
    "principal session cascade",
)
text = replace_once(
    text,
    "  vault_id uuid references vaults(id),\n",
    "  vault_id uuid references vaults(id) on delete cascade,\n",
    "principal vault cascade",
)
text = replace_once(
    text,
    "  principal_id uuid not null references principals(id),\n",
    "  principal_id uuid not null references principals(id) on delete cascade,\n",
    "principal credential cascade",
)
text = replace_once(
    text,
    "  add column principal_id uuid references principals(id);\n",
    "  add column principal_id uuid references principals(id) on delete set null;\n",
    "audit principal retention",
)
migration.write_text(text)


test = Path("apps/api/test/principal-auth.integration.test.ts")
text = test.read_text()
text = replace_once(
    text,
    '''    await db.pool.query(
      `insert into vaults(id,space_id,canonical_path,name,read_only,visibility,enabled)
       values($1,$2,$3,$4,true,'TEAM',true)`,
      [vaultId, spaceId, `/tmp/principal-${vaultId}`, "Principal vault"],
    );
''',
    '''    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,vault_key,
         local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,'principal:initial',$5,$3,'TEAM',true)`,
      [
        vaultId,
        spaceId,
        `/tmp/principal-${vaultId}`,
        "Principal vault",
        `principal-${vaultId.slice(0, 8)}`,
      ],
    );
''',
    "primary vault fixture",
)
text = replace_once(
    text,
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
''',
    '''    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,vault_key,
         local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,'principal:sibling',$5,$3,'TEAM',true)`,
      [
        siblingVaultId,
        spaceId,
        `/tmp/principal-sibling-${siblingVaultId}`,
        "Principal sibling vault",
        `principal-sibling-${siblingVaultId.slice(0, 8)}`,
      ],
    );
''',
    "sibling vault fixture",
)
text = replace_once(
    text,
    '''  afterAll(async () => {
    await app.close();
    await db.pool.query("delete from organizations where id=$1", [orgId]);
    await db.close();
  });
''',
    '''  afterAll(async () => {
    await app.close();
    await db.pool.query("delete from audit_events where actor_id=$1", [userId]);
    await db.pool.query("delete from api_tokens where user_id=$1", [userId]);
    await db.pool.query(
      "delete from agent_sessions where actor_id=$1 and space_id=$2",
      [userId, spaceId],
    );
    await db.pool.query(
      "delete from memberships where user_id=$1 and space_id=$2",
      [userId, spaceId],
    );
    await db.pool.query("delete from users where id=$1", [userId]);
    await db.pool.query("delete from vaults where id=any($1::uuid[])", [
      [vaultId, siblingVaultId],
    ]);
    await db.pool.query("delete from spaces where id=$1", [spaceId]);
    await db.pool.query("delete from organizations where id=$1", [orgId]);
    await db.close();
  });
''',
    "principal fixture cleanup",
)
test.write_text(text)
