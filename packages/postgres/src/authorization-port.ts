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

export interface AuthorizationPort {
  resolveVaultScope(
    request: AuthorizedVaultScopeRequest,
  ): Promise<AuthorizedVaultScope>;
  canExpandResource(
    scope: AuthorizedVaultScope,
    candidate: AuthorizedResourceCandidate,
  ): boolean;
  filterExpansionCandidates<T extends AuthorizedResourceCandidate>(
    scope: AuthorizedVaultScope,
    candidates: readonly T[],
  ): T[];
}

/**
 * Built-in authorization adapter. Retrieval/planning callers use the resolved
 * scope before candidate expansion; this is intentionally not a final-output
 * redaction layer. A pathless resource requires an unrestricted vault scope.
 */
export class PostgresAuthorizationPort implements AuthorizationPort {
  constructor(private readonly db: Postgres) {}

  resolveVaultScope(
    request: AuthorizedVaultScopeRequest,
  ): Promise<AuthorizedVaultScope> {
    return resolveAuthorizedVaultScope(this.db, request);
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
