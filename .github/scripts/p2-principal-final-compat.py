from pathlib import Path


def replace_count(text: str, old: str, new: str, expected: int, label: str) -> str:
    count = text.count(old)
    if count != expected:
        raise SystemExit(f"{label} anchor changed: {count}")
    return text.replace(old, new)


def replace_once(text: str, old: str, new: str, label: str) -> str:
    return replace_count(text, old, new, 1, label)


# p2-principal-integration-fix.py already makes runtime identities subordinate
# to user/parent/session/vault lifecycle. Preserve audit history while allowing
# those identities to disappear, and verify the expected cascades are present.
migration = Path("db/migrations/034_principal_identity.sql")
text = migration.read_text()
for expected in [
    "  user_id uuid references users(id) on delete cascade,\n",
    "  parent_principal_id uuid references principals(id) on delete cascade,\n",
    "  session_id uuid references agent_sessions(id) on delete cascade,\n",
    "  vault_id uuid references vaults(id) on delete cascade,\n",
    "  principal_id uuid not null references principals(id) on delete cascade,\n",
    "  user_id uuid not null references users(id) on delete cascade,\n",
]:
    if expected not in text:
        raise SystemExit(f"missing lifecycle FK: {expected.strip()}")
text = replace_once(
    text,
    "  add column principal_id uuid references principals(id);\n",
    "  add column principal_id uuid references principals(id) on delete set null;\n",
    "audit principal retention",
)
migration.write_text(text)


# Vault registry rows created after migration 013 must supply both stable
# vault_key and local_path. The prior compatibility script added vault_key;
# complete the contract without weakening either NOT NULL invariant.
test = Path("apps/api/test/principal-auth.integration.test.ts")
text = test.read_text()
text = replace_count(
    text,
    "`insert into vaults(id,space_id,canonical_path,name,vault_key,read_only,visibility,enabled)\n       values($1,$2,$3,$4,$5,true,'TEAM',true)`",
    "`insert into vaults(id,space_id,canonical_path,name,vault_key,local_path,read_only,visibility,enabled)\n       values($1,$2,$3,$4,$5,$3,true,'TEAM',true)`",
    2,
    "principal fixture local path",
)

# The default agent intentionally cannot propose. This fixture needs an
# explicitly proposal-capable, still narrowly scoped agent so the cross-vault
# proposal assertion reaches the immutable vault boundary instead of being
# rejected earlier by the central deny-by-default route allowlist.
text = replace_once(
    text,
    '      payload: { label: "Compiler worker" },\n',
    '''      payload: {
        label: "Compiler worker",
        allowedActions: [
          "workspace:read",
          "workspace:claim",
          "workspace:handoff",
          "workspace:event:append",
          "knowledge:read",
          "knowledge:propose",
        ],
      },
''',
    "proposal-capable principal fixture",
)
test.write_text(text)
