from pathlib import Path

path = Path(".github/scripts/p2-principal-vault-hardening.py")
text = path.read_text()
old = '''text = replace_once(
    text,
    ''' + "'''" + '''          ...(parsed.data.vaultId ? { vaultId: parsed.data.vaultId } : {}),
          vaultIds: parsed.data.vaultIds,
          federated: parsed.data.federated,
''' + "'''" + ''',
    ''' + "'''" + '''          ...(principalVaultId
            ? { vaultId: principalVaultId }
            : parsed.data.vaultId
              ? { vaultId: parsed.data.vaultId }
              : {}),
          vaultIds: principalVaultId ? [principalVaultId] : parsed.data.vaultIds,
          federated: principalVaultId ? false : parsed.data.federated,
''' + "'''" + ''',
    "search resolver principal vault",
)
'''
new = '''search_resolver_old = ''' + "'''" + '''          ...(parsed.data.vaultId ? { vaultId: parsed.data.vaultId } : {}),
          vaultIds: parsed.data.vaultIds,
          federated: parsed.data.federated,
''' + "'''" + '''
search_resolver_new = ''' + "'''" + '''          ...(principalVaultId
            ? { vaultId: principalVaultId }
            : parsed.data.vaultId
              ? { vaultId: parsed.data.vaultId }
              : {}),
          vaultIds: principalVaultId ? [principalVaultId] : parsed.data.vaultIds,
          federated: principalVaultId ? false : parsed.data.federated,
''' + "'''" + '''
if text.count(search_resolver_old) != 2:
    raise SystemExit(
        f"search/context resolver anchors changed: {text.count(search_resolver_old)}"
    )
text = text.replace(search_resolver_old, search_resolver_new, 1)
'''
if text.count(old) != 1:
    raise SystemExit(f"vault hardening compatibility anchor changed: {text.count(old)}")
path.write_text(text.replace(old, new, 1))
