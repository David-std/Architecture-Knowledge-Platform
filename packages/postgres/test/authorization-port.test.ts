import { describe, expect, it } from "vitest";
import {
  PostgresAuthorizationPort,
  authorizationDecisionRevision,
  type AuthorizedVaultScope,
  type AuthorizedVaultScopeRequest,
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

const request: AuthorizedVaultScopeRequest = {
  userId: "user-a",
  spaceId: "space-a",
  permission: "knowledge:read",
  vaultId: "vault-a",
  vaultIds: ["vault-a"],
  federated: false,
};

describe("PostgresAuthorizationPort", () => {
  it("revisions the effective authorization decision deterministically", () => {
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

  it("exposes ALLOW, DENY, INDETERMINATE and BACKEND_UNAVAILABLE without falling open", async () => {
    const db = {} as Postgres;
    const allow = new PostgresAuthorizationPort(db, async () => scoped);
    await expect(
      allow.resolveVaultScopeDecision(request),
    ).resolves.toMatchObject({
      status: "ALLOW",
      scope: {
        vaultIds: ["vault-a"],
        policyRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });

    const deny = new PostgresAuthorizationPort(db, async () => {
      throw new Error("VAULT_ACCESS_DENIED");
    });
    await expect(deny.resolveVaultScopeDecision(request)).resolves.toEqual({
      status: "DENY",
      code: "VAULT_ACCESS_DENIED",
      sourceCode: "VAULT_ACCESS_DENIED",
    });
    await expect(deny.resolveVaultScope(request)).rejects.toMatchObject({
      message: "VAULT_ACCESS_DENIED",
      authorizationStatus: "DENY",
    });

    const indeterminate = new PostgresAuthorizationPort(db, async () => {
      throw new Error("UNCLASSIFIED_POLICY_FAILURE");
    });
    await expect(
      indeterminate.resolveVaultScopeDecision(request),
    ).resolves.toEqual({
      status: "INDETERMINATE",
      code: "AUTHORIZATION_INDETERMINATE",
      sourceCode: "UNCLASSIFIED_POLICY_FAILURE",
    });
    await expect(
      indeterminate.resolveVaultScope(request),
    ).rejects.toMatchObject({
      message: "AUTHORIZATION_INDETERMINATE",
      authorizationStatus: "INDETERMINATE",
      statusCode: 503,
    });

    const backend = new PostgresAuthorizationPort(db, async () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
    });
    await expect(backend.resolveVaultScopeDecision(request)).resolves.toEqual({
      status: "BACKEND_UNAVAILABLE",
      code: "AUTHORIZATION_BACKEND_UNAVAILABLE",
      sourceCode: "ECONNREFUSED",
    });
    await expect(backend.resolveVaultScope(request)).rejects.toMatchObject({
      message: "AUTHORIZATION_BACKEND_UNAVAILABLE",
      authorizationStatus: "BACKEND_UNAVAILABLE",
      statusCode: 503,
    });
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
