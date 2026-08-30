import { describe, expect, it } from "vitest";
import {
  scopedSearchRequest,
  selectVault,
  type VaultOption,
} from "./vault-scope";

const vaults: VaultOption[] = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    space_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    name: "Handbook",
    vault_key: "handbook",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    space_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    name: "Architecture",
    vault_key: "architecture",
  },
];

describe("selectVault", () => {
  it("requires an explicit choice when multiple vaults are visible", () => {
    expect(selectVault(vaults)).toEqual({
      status: "VAULT_SELECTION_REQUIRED",
      vault: null,
    });
  });

  it("does not accept a vault outside the visible registry", () => {
    expect(selectVault(vaults, "33333333-3333-4333-8333-333333333333")).toEqual(
      { status: "VAULT_NOT_VISIBLE", vault: null },
    );
  });

  it("auto-selects only an unambiguous single vault", () => {
    expect(selectVault([vaults[0]!])).toEqual({
      status: "SELECTED",
      vault: vaults[0],
    });
  });
});

describe("scopedSearchRequest", () => {
  it("carries an explicit non-federated space and vault scope", () => {
    expect(scopedSearchRequest("retention policy", vaults[0]!)).toMatchObject({
      query: "retention policy",
      spaceId: vaults[0]!.space_id,
      vaultId: vaults[0]!.id,
      vaultIds: [],
      federated: false,
    });
  });
});
