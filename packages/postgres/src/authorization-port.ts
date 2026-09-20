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

export type AuthorizationDecisionStatus =
  | "ALLOW"
  | "DENY"
  | "INDETERMINATE"
  | "BACKEND_UNAVAILABLE";

export type AuthorizationVaultScopeDecision =
  | { status: "ALLOW"; scope: AuthorizationDecisionScope }
  | {
      status: Exclude<AuthorizationDecisionStatus, "ALLOW">;
      code: string;
      sourceCode: string;
    };

export type AuthorizationScopeResolver = (
  db: Postgres,
  request: AuthorizedVaultScopeRequest,
) => Promise<AuthorizedVaultScope>;

export interface AuthorizationPort {
  resolveVaultScopeDecision(
    request: AuthorizedVaultScopeRequest,
  ): Promise<AuthorizationVaultScopeDecision>;
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

const DENY_CODES = new Set([
  "VAULT_SCOPE_REQUIRED",
  "VAULT_SCOPE_NOT_FOUND",
  "VAULT_ACCESS_DENIED",
  "FEDERATED_QUERY_REQUIRES_EXPLICIT_OPT_IN",
]);

const BACKEND_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "57P01",
  "57P02",
  "57P03",
]);

function sourceErrorCode(error: unknown): string {
  if (error && typeof error === "object") {
    const candidate = (error as { code?: unknown }).code;
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return error instanceof Error && error.message
    ? error.message
    : "AUTHORIZATION_UNKNOWN_ERROR";
}

function authorizationFailureDecision(
  error: unknown,
): Exclude<AuthorizationVaultScopeDecision, { status: "ALLOW" }> {
  const sourceCode = sourceErrorCode(error);
  if (DENY_CODES.has(sourceCode)) {
    return { status: "DENY", code: sourceCode, sourceCode };
  }
  if (
    BACKEND_CODES.has(sourceCode) ||
    sourceCode.startsWith("08") ||
    /connection (?:terminated|refused|reset)|database.*unavailable/i.test(
      error instanceof Error ? error.message : "",
    )
  ) {
    return {
      status: "BACKEND_UNAVAILABLE",
      code: "AUTHORIZATION_BACKEND_UNAVAILABLE",
      sourceCode,
    };
  }
  return {
    status: "INDETERMINATE",
    code: "AUTHORIZATION_INDETERMINATE",
    sourceCode,
  };
}

function authorizationDecisionError(
  decision: Exclude<AuthorizationVaultScopeDecision, { status: "ALLOW" }>,
): Error {
  const error = new Error(decision.code) as Error & {
    code?: string;
    statusCode?: number;
    authorizationStatus?: AuthorizationDecisionStatus;
    sourceCode?: string;
  };
  error.code = decision.code;
  error.statusCode =
    decision.status === "BACKEND_UNAVAILABLE" ||
    decision.status === "INDETERMINATE"
      ? 503
      : 403;
  error.authorizationStatus = decision.status;
  error.sourceCode = decision.sourceCode;
  return error;
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
 *
 * Non-ALLOW outcomes are explicit so callers can distinguish a policy deny
 * from an unknown decision or an unavailable authorization backend. The
 * convenience resolveVaultScope method always fails closed for all three.
 */
export class PostgresAuthorizationPort implements AuthorizationPort {
  constructor(
    private readonly db: Postgres,
    private readonly scopeResolver: AuthorizationScopeResolver = (
      database,
      request,
    ) => resolveAuthorizedVaultScope(database, request),
  ) {}

  async resolveVaultScopeDecision(
    request: AuthorizedVaultScopeRequest,
  ): Promise<AuthorizationVaultScopeDecision> {
    try {
      const scope = await this.scopeResolver(this.db, request);
      return {
        status: "ALLOW",
        scope: {
          ...scope,
          policyRevision: authorizationDecisionRevision(request, scope),
        },
      };
    } catch (error) {
      return authorizationFailureDecision(error);
    }
  }

  async resolveVaultScope(
    request: AuthorizedVaultScopeRequest,
  ): Promise<AuthorizationDecisionScope> {
    const decision = await this.resolveVaultScopeDecision(request);
    if (decision.status === "ALLOW") return decision.scope;
    throw authorizationDecisionError(decision);
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
