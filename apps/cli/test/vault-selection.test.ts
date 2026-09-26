import { describe, expect, it } from "vitest";
import { resolveCliVaultSelection } from "../src/vault-selection.js";

const visible = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    space_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    vault_key: "architecture",
    name: "Architecture Notes",
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    space_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    vault_key: "operations",
    name: "Operations",
  },
];

describe("CLI vault selection", () => {
  it("resolves an authorized vault by human-readable name", async () => {
    await expect(
      resolveCliVaultSelection({
        vaultSelectors: ["Architecture Notes"],
        listVisibleVaults: async () => visible,
      }),
    ).resolves.toEqual({
      spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      vaultIds: ["11111111-1111-4111-8111-111111111111"],
    });
  });

  it("resolves multiple vault keys inside one space", async () => {
    await expect(
      resolveCliVaultSelection({
        vaultSelectors: ["architecture", "operations"],
        listVisibleVaults: async () => visible,
      }),
    ).resolves.toEqual({
      spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      vaultIds: [
        "11111111-1111-4111-8111-111111111111",
        "22222222-2222-4222-8222-222222222222",
      ],
    });
  });

  it("auto-selects only when exactly one authorized vault is visible", async () => {
    await expect(
      resolveCliVaultSelection({
        listVisibleVaults: async () => visible.slice(0, 1),
      }),
    ).resolves.toMatchObject({
      vaultIds: ["11111111-1111-4111-8111-111111111111"],
    });
    await expect(
      resolveCliVaultSelection({
        listVisibleVaults: async () => visible,
      }),
    ).rejects.toThrow(/More than one authorized vault/);
  });

  it("keeps UUID selection for scripts and requires its explicit space", async () => {
    await expect(
      resolveCliVaultSelection({
        vaultIds: ["11111111-1111-4111-8111-111111111111"],
        listVisibleVaults: async () => {
          throw new Error("must not query registry");
        },
      }),
    ).rejects.toThrow(/--space-id/);
  });

  it("rejects ambiguous names instead of selecting silently", async () => {
    await expect(
      resolveCliVaultSelection({
        vaultSelectors: ["Shared"],
        listVisibleVaults: async () => [
          ...visible,
          {
            id: "33333333-3333-4333-8333-333333333333",
            space_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            vault_key: "shared-a",
            name: "Shared",
          },
          {
            id: "44444444-4444-4444-8444-444444444444",
            space_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            vault_key: "shared-b",
            name: "Shared",
          },
        ],
      }),
    ).rejects.toThrow(/ambiguous/);
  });
});
