from pathlib import Path

path = Path("apps/api/src/routes/search.ts")
text = path.read_text()
old = "  const expansionScopeJson = JSON.stringify(expansionScopes);"
new = """  const expansionScopeJson = JSON.stringify(
    expansionScopes.map((scope) => ({
      vault_id: scope.vaultId,
      path_prefix: scope.pathPrefix,
    })),
  );"""
if "vault_id: scope.vaultId," not in text:
    if old not in text:
        raise SystemExit("search.ts expansion scope serialization shape changed")
    text = text.replace(old, new, 1)
path.write_text(text)
