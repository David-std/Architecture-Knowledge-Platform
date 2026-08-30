export interface VaultOption {
  id: string;
  space_id: string;
  name: string;
  vault_key: string;
}

export type VaultSelection =
  | { status: "SELECTED"; vault: VaultOption }
  | {
      status:
        | "NO_AUTHORIZED_VAULT"
        | "VAULT_SELECTION_REQUIRED"
        | "VAULT_NOT_VISIBLE";
      vault: null;
    };

export function selectVault(
  vaults: readonly VaultOption[],
  requestedVaultId?: string,
): VaultSelection {
  if (requestedVaultId) {
    const selected = vaults.find((vault) => vault.id === requestedVaultId);
    return selected
      ? { status: "SELECTED", vault: selected }
      : { status: "VAULT_NOT_VISIBLE", vault: null };
  }
  if (vaults.length === 1) {
    return { status: "SELECTED", vault: vaults[0]! };
  }
  return vaults.length === 0
    ? { status: "NO_AUTHORIZED_VAULT", vault: null }
    : { status: "VAULT_SELECTION_REQUIRED", vault: null };
}

export function scopedSearchRequest(
  query: string,
  vault: VaultOption,
  options: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    query,
    spaceId: vault.space_id,
    vaultId: vault.id,
    vaultIds: [],
    federated: false,
    ...options,
  };
}
