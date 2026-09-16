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
if old in text:
    text = text.replace(old, new, 1)
elif "const expansionScopeJson = JSON.stringify(\n    expansionScopes.map" not in text:
    raise SystemExit("search.ts expansion scope serialization shape changed")
path.write_text(text)
