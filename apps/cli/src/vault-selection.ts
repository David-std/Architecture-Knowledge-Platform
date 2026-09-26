type VaultRecord = Record<string, unknown>;

function stringField(
  value: VaultRecord,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return undefined;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export async function resolveCliVaultSelection(input: {
  spaceId?: string | undefined;
  vaultIds?: string[] | undefined;
  vaultSelectors?: string[] | undefined;
  listVisibleVaults: () => Promise<unknown[]>;
}): Promise<{ spaceId: string; vaultIds: string[] }> {
  const directIds = [...new Set((input.vaultIds ?? []).filter(Boolean))];
  if (directIds.length > 0) {
    if (!input.spaceId?.trim()) {
      throw new Error("--space-id is required when --vault-id is used.");
    }
    return { spaceId: input.spaceId, vaultIds: directIds };
  }

  const rawVaults = await input.listVisibleVaults();
  const visible = rawVaults
    .filter(
      (value): value is VaultRecord =>
        Boolean(value) && typeof value === "object" && !Array.isArray(value),
    )
    .map((value) => ({
      raw: value,
      id: stringField(value, "id"),
      spaceId: stringField(value, "space_id", "spaceId"),
      key: stringField(value, "vault_key", "vaultKey"),
      name: stringField(value, "name"),
    }))
    .filter((value): value is typeof value & { id: string; spaceId: string } =>
      Boolean(value.id && value.spaceId),
    )
    .filter((value) => !input.spaceId || value.spaceId === input.spaceId);

  const selectors = (input.vaultSelectors ?? [])
    .map((value) => value.trim())
    .filter(Boolean);

  let selected = visible;
  if (selectors.length > 0) {
    selected = selectors.map((selector) => {
      const needle = normalized(selector);
      const matches = visible.filter((vault) =>
        [vault.id, vault.key, vault.name]
          .filter((value): value is string => Boolean(value))
          .some((value) => normalized(value) === needle),
      );
      if (matches.length === 0) {
        throw new Error(
          `Authorized vault not found for ${JSON.stringify(selector)}. Run 'akp vaults' to inspect visible vaults.`,
        );
      }
      if (matches.length > 1) {
        throw new Error(
          `Vault selector ${JSON.stringify(selector)} is ambiguous; use --vault-id or --space-id.`,
        );
      }
      return matches[0]!;
    });
  } else if (visible.length !== 1) {
    throw new Error(
      visible.length === 0
        ? "No authorized vault is visible to this API credential."
        : "More than one authorized vault is visible; use --vault <name-or-key> or --vault-id.",
    );
  }

  const unique = [
    ...new Map(selected.map((vault) => [vault.id, vault])).values(),
  ];
  const spaces = [...new Set(unique.map((vault) => vault.spaceId))];
  if (spaces.length !== 1) {
    throw new Error(
      "Selected vaults belong to different spaces; issue separate queries per space.",
    );
  }
  return {
    spaceId: spaces[0]!,
    vaultIds: unique.map((vault) => vault.id),
  };
}
