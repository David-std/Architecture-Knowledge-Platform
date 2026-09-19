import { createHash } from "node:crypto";
import type { Postgres } from "./index.js";
import {
  pathMatchesVaultPrefix,
  resolveAuthorizedVaultScope,
  type AuthorizedVaultScope,
  type AuthorizedVaultScopeRequest,
} from "./vault-registry.js";

export interface AuthorizedResourceCandidate {
  vaultId: string;
  path?: string | null;
}

export interface AuthorizationDecisionScope extends AuthorizedVaultScope {
  /** Stable fingerprint of the effective authorization decision. */
  policyRevision: string;
}

export interface AuthorizationPort {
  resolveVaultScope(
    request: AuthorizedVaultScopeRequest,
  ): Promise<AuthorizationDecisionScope>;
  canExpandResource(
    scope: AuthorizedVaultScope,
    candidate: AuthorizedResourceCandidate,
  ): boolean;
  filterExpansionCandidates<T extends AuthorizedResourceCandidate>(
    scope: AuthorizedVaultScope,
    candidates: readonly T[],
  ): T[];
}

export function authorizationDecisionRevision(
  request: AuthorizedVaultScopeRequest,
  scope: AuthorizedVaultScope,
): string {
  const accessByVault = Object.fromEntries(
    Object.entries(scope.accessByVault)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([vaultId, access]) => [
        vaultId,
        {
          pathPrefix: access.pathPrefix,
          permissions: [...access.permissions].sort(),
        },
      ]),
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        userId: request.userId,
        spaceId: request.spaceId,
        permission: request.permission ?? null,
        vaultIds: [...scope.vaultIds].sort(),
        accessByVault,
        federated: scope.federated,
      }),
    )
    .digest("hex");
}

/**
 * Built-in authorization adapter. Retrieval/planning callers use the resolved
 * scope before candidate expansion; this is intentionally not a final-output
 * redaction layer. A pathless resource requires an unrestricted vault scope.
 */
export class PostgresAuthorizationPort implements AuthorizationPort {
  constructor(private readonly db: Postgres) {}

  async resolveVaultScope(
    request: AuthorizedVaultScopeRequest,
  ): Promise<AuthorizationDecisionScope> {
    const scope = await resolveAuthorizedVaultScope(this.db, request);
    return {
      ...scope,
      policyRevision: authorizationDecisionRevision(request, scope),
    };
  }

  canExpandResource(
    scope: AuthorizedVaultScope,
    candidate: AuthorizedResourceCandidate,
  ): boolean {
    if (!scope.vaultIds.includes(candidate.vaultId)) return false;
    const access = scope.accessByVault[candidate.vaultId];
    if (!access) return false;
    if (candidate.path === null || candidate.path === undefined) {
      return access.pathPrefix === null;
    }
    return pathMatchesVaultPrefix(candidate.path, access.pathPrefix);
  }

  filterExpansionCandidates<T extends AuthorizedResourceCandidate>(
    scope: AuthorizedVaultScope,
    candidates: readonly T[],
  ): T[] {
    return candidates.filter((candidate) =>
      this.canExpandResource(scope, candidate),
    );
  }
}
