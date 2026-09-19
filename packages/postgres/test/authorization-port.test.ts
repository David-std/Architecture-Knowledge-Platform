import { describe, expect, it } from "vitest";
import {
  PostgresAuthorizationPort,
  authorizationDecisionRevision,
  type AuthorizedVaultScope,
  type Postgres,
} from "../src/index.js";

const scoped: AuthorizedVaultScope = {
  vaults: [],
  vaultIds: ["vault-a"],
  accessByVault: {
    "vault-a": {
      pathPrefix: "docs/security",
      permissions: ["knowledge:read"],
    },
  },
  federated: false,
};

describe("PostgresAuthorizationPort", () => {
  it("revisions the effective authorization decision deterministically", () => {
    const request = {
      userId: "user-a",
      spaceId: "space-a",
      permission: "knowledge:read",
      vaultId: "vault-a",
      vaultIds: ["vault-a"],
      federated: false,
    };
    const first = authorizationDecisionRevision(request, scoped);
    const reordered: AuthorizedVaultScope = {
      ...scoped,
      accessByVault: {
        "vault-a": {
          pathPrefix: "docs/security",
          permissions: ["knowledge:read"],
        },
      },
    };
    expect(authorizationDecisionRevision(request, reordered)).toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);

    expect(
      authorizationDecisionRevision(request, {
        ...scoped,
        accessByVault: {
          "vault-a": {
            pathPrefix: "docs",
            permissions: ["knowledge:read"],
          },
        },
      }),
    ).not.toBe(first);
  });

  it("filters unauthorized candidates before expansion", () => {
    const port = new PostgresAuthorizationPort({} as Postgres);
    const candidates = [
      { vaultId: "vault-a", path: "docs/security/rule.md", id: "allowed" },
      { vaultId: "vault-a", path: "docs/public/readme.md", id: "wrong-path" },
      { vaultId: "vault-a", path: null, id: "pathless" },
      { vaultId: "vault-b", path: "docs/security/rule.md", id: "wrong-vault" },
    ];

    expect(port.filterExpansionCandidates(scoped, candidates)).toEqual([
      candidates[0],
    ]);
    expect(port.canExpandResource(scoped, candidates[0]!)).toBe(true);
    expect(port.canExpandResource(scoped, candidates[1]!)).toBe(false);
    expect(port.canExpandResource(scoped, candidates[2]!)).toBe(false);
    expect(port.canExpandResource(scoped, candidates[3]!)).toBe(false);
  });

  it("permits pathless operational resources only for unrestricted vault scope", () => {
    const port = new PostgresAuthorizationPort({} as Postgres);
    const unrestricted: AuthorizedVaultScope = {
      ...scoped,
      accessByVault: {
        "vault-a": {
          pathPrefix: null,
          permissions: ["knowledge:read"],
        },
      },
    };

    expect(
      port.canExpandResource(unrestricted, { vaultId: "vault-a", path: null }),
    ).toBe(true);
  });
});
