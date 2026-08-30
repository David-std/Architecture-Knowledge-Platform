import { describe, expect, it, vi } from "vitest";
import {
  canAccessVault,
  intersectVaultPathPrefixes,
  pathMatchesVaultPrefix,
  resolveAuthorizedVaultScope,
} from "../src/vault-registry.js";

describe("vault membership isolation", () => {
  it("intersects space and vault path scopes and permissions", () => {
    expect(
      canAccessVault(
        "PRIVATE",
        { role: "ADMIN", pathPrefix: "handbook" },
        {
          role: "VIEWER",
          pathPrefix: "handbook/architecture",
          permissions: ["knowledge:read"],
        },
        "knowledge:read",
      ),
    ).toMatchObject({
      allowed: true,
      pathPrefix: "handbook/architecture",
      permissions: ["knowledge:read"],
    });
    expect(
      canAccessVault(
        "PRIVATE",
        { role: "VIEWER", pathPrefix: "handbook" },
        {
          role: "VIEWER",
          pathPrefix: "other",
          permissions: ["knowledge:read"],
        },
        "knowledge:read",
      ).allowed,
    ).toBe(false);
  });

  it("does not inherit a private vault when the user has no vault grant", () => {
    expect(
      canAccessVault(
        "PRIVATE",
        { role: "ADMIN", pathPrefix: null },
        null,
        "knowledge:read",
      ).allowed,
    ).toBe(false);
  });

  it("allows a team/central vault to inherit the space membership", () => {
    expect(
      canAccessVault(
        "TEAM",
        { role: "VIEWER", pathPrefix: "shared" },
        null,
        "knowledge:read",
      ),
    ).toMatchObject({ allowed: true, pathPrefix: "shared" });
  });

  it("does not inherit a team vault when an explicit grant is disabled", () => {
    expect(
      canAccessVault(
        "TEAM",
        { role: "VIEWER", pathPrefix: null },
        {
          role: "VIEWER",
          pathPrefix: null,
          permissions: ["knowledge:read"],
          enabled: false,
        },
        "knowledge:read",
      ).allowed,
    ).toBe(false);
  });

  it("normalizes and intersects relative path prefixes", () => {
    expect(intersectVaultPathPrefixes("docs/", "docs/architecture")).toBe(
      "docs/architecture",
    );
    expect(intersectVaultPathPrefixes("docs", "private")).toBeUndefined();
    expect(
      pathMatchesVaultPrefix("docs/architecture/hexagonal.md", "docs"),
    ).toBe(true);
    expect(pathMatchesVaultPrefix("docs-other/file.md", "docs")).toBe(false);
    expect(intersectVaultPathPrefixes("/docs", null)).toBeUndefined();
    expect(intersectVaultPathPrefixes("C:/docs", null)).toBeUndefined();
    expect(
      intersectVaultPathPrefixes("\\\\server\\share", null),
    ).toBeUndefined();
    expect(intersectVaultPathPrefixes("docs//private", null)).toBeUndefined();
  });

  it("keeps same paths and IDs isolated to explicitly authorized vaults", async () => {
    const rows = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        vault_key: "private-one",
        name: "One",
        space_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        git_repository: null,
        default_branch: "main",
        local_path: "same/path",
        content_roots: ["."],
        source_roots: [],
        schema_profile: {},
        eval_pack: {},
        retrieval_config: {},
        permissions: {},
        visibility: "PRIVATE" as const,
        enabled: true,
        current_revision: null,
        last_imported_at: null,
        membership_role: "VIEWER",
        membership_path_prefix: null,
        membership_permissions: ["knowledge:read"],
        space_role: "VIEWER",
        space_path_prefix: null,
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        vault_key: "private-two",
        name: "Two",
        space_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        git_repository: null,
        default_branch: "main",
        local_path: "same/path",
        content_roots: ["."],
        source_roots: [],
        schema_profile: {},
        eval_pack: {},
        retrieval_config: {},
        permissions: {},
        visibility: "PRIVATE" as const,
        enabled: true,
        current_revision: null,
        last_imported_at: null,
        membership_role: null,
        membership_path_prefix: null,
        membership_permissions: [],
        space_role: "VIEWER",
        space_path_prefix: null,
      },
    ];
    const db = {
      pool: { query: vi.fn().mockResolvedValue({ rowCount: 2, rows }) },
    };
    await expect(
      resolveAuthorizedVaultScope(db as never, {
        userId: "33333333-3333-4333-8333-333333333333",
        spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        vaultIds: rows.map((row) => row.id),
        federated: true,
        permission: "knowledge:read",
      }),
    ).rejects.toThrow("VAULT_ACCESS_DENIED");

    const result = await resolveAuthorizedVaultScope(db as never, {
      userId: "33333333-3333-4333-8333-333333333333",
      spaceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      vaultId: rows[0]!.id,
      permission: "knowledge:read",
    });
    expect(result.vaultIds).toEqual([rows[0]!.id]);
    expect(result.accessByVault[rows[0]!.id]).toEqual({
      pathPrefix: null,
      permissions: ["knowledge:read"],
    });
  });
});
