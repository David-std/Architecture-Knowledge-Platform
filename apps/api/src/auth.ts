import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Postgres } from "@akp/postgres";

export type Permission =
  | "knowledge:read"
  | "source:read"
  | "source:write"
  | "knowledge:propose"
  | "knowledge:review"
  | "eval:run"
  | "admin";

export interface Actor {
  id: string;
  email: string;
  roles: string[];
  spaceIds: string[];
  memberships: Array<{
    spaceId: string;
    role: string;
    pathPrefix: string | null;
    permissions?: Permission[];
  }>;
  authenticationKind: "API_TOKEN" | "WEB_SESSION" | "PRINCIPAL_TOKEN";
  principalId: string;
  principalKind:
    | "HUMAN"
    | "AGENT_PROCESS"
    | "SERVICE_ACCOUNT"
    | "CONNECTOR"
    | "MAINTENANCE_JOB";
  parentPrincipalId: string | null;
  principalSessionId: string | null;
  principalVaultId: string | null;
  principalAllowedActions: string[];
  principalPolicyRevision: number;
  /**
   * Stable only for the currently authenticated credential and its effective
   * authorization tuples. It is intentionally a hash rather than a raw token
   * or session value so it can safely partition idempotency records.
   */
  idempotencyScopeFingerprint: string;
  sessionId?: string;
}

interface PersistedTokenScope {
  spaceId: string;
  pathPrefix: string | null;
  permissions: Permission[];
}

interface AuthenticationRow {
  credential_hash: string;
  csrf_hash: string | null;
  session_id: string | null;
  authentication_kind: string;
  token_id: string | null;
  token_scopes: unknown;
  principal_id: string | null;
  credential_policy_revision: number | null;
  credential_allowed_actions: string[] | null;
  id: string;
  email: string;
  roles: string[];
  space_ids: string[];
  memberships: Array<Record<string, unknown>>;
}

const ROLE_PERMISSIONS: Record<string, Permission[]> = {
  VIEWER: ["knowledge:read", "source:read"],
  CONTRIBUTOR: [
    "knowledge:read",
    "source:read",
    "source:write",
    "knowledge:propose",
  ],
  CURATOR: [
    "knowledge:read",
    "source:read",
    "source:write",
    "knowledge:propose",
  ],
  REVIEWER: ["knowledge:read", "source:read", "knowledge:review"],
  ARCHITECT: [
    "knowledge:read",
    "source:read",
    "source:write",
    "knowledge:propose",
    "knowledge:review",
    "eval:run",
  ],
  ADMIN: [
    "knowledge:read",
    "source:read",
    "source:write",
    "knowledge:propose",
    "knowledge:review",
    "eval:run",
    "admin",
  ],
  SERVICE_ACCOUNT: ["knowledge:read", "source:read", "source:write"],
};

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizePath(
  value: string | null | undefined,
): string | null | undefined {
  if (value === null || value === undefined) return null;
  const candidate = value.replaceAll("\\", "/");
  if (
    candidate.startsWith("/") ||
    /^[A-Za-z]:/.test(candidate) ||
    candidate.includes("\u0000")
  ) {
    return undefined;
  }
  const normalized = candidate.replace(/\/+$/, "");
  if (
    !normalized ||
    normalized.includes("//") ||
    normalized
      .split("/")
      .some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment.includes(":") ||
          /[\u0000-\u001f]/.test(segment),
      )
  ) {
    return undefined;
  }
  return normalized;
}

function intersectPathPrefixes(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null | undefined {
  if (left === undefined || right === undefined) return undefined;
  if (!left) return right;
  if (!right) return left;
  if (left === right || left.startsWith(`${right}/`)) return left;
  if (right.startsWith(`${left}/`)) return right;
  return undefined;
}

function permissionsForMembership(membership: Actor["memberships"][number]) {
  return membership.permissions ?? ROLE_PERMISSIONS[membership.role] ?? [];
}

function isPermission(value: unknown): value is Permission {
  return (
    typeof value === "string" &&
    [
      "knowledge:read",
      "source:read",
      "source:write",
      "knowledge:propose",
      "knowledge:review",
      "eval:run",
      "admin",
    ].includes(value)
  );
}

function parseTokenScopes(value: unknown): PersistedTokenScope[] {
  if (!value || typeof value !== "object") return [];
  const spaces = (value as { spaces?: unknown }).spaces;
  if (!Array.isArray(spaces)) return [];
  return spaces.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const scope = candidate as Record<string, unknown>;
    if (typeof scope.spaceId !== "string") return [];
    const permissions = Array.isArray(scope.permissions)
      ? scope.permissions.filter(isPermission)
      : [];
    if (!permissions.length) return [];
    const pathPrefix =
      scope.pathPrefix === null
        ? null
        : typeof scope.pathPrefix === "string"
          ? normalizePath(scope.pathPrefix)
          : undefined;
    if (pathPrefix === undefined) return [];
    return [
      {
        spaceId: scope.spaceId,
        pathPrefix,
        permissions,
      },
    ];
  });
}

function scopeMemberships(
  memberships: Actor["memberships"],
  tokenScopes: unknown,
): Actor["memberships"] {
  const scopes = parseTokenScopes(tokenScopes);
  return memberships.flatMap((membership) => {
    const membershipPermissions = permissionsForMembership(membership);
    const membershipPrefix = normalizePath(membership.pathPrefix);
    if (membershipPrefix === undefined) return [];
    return scopes.flatMap((scope) => {
      if (scope.spaceId !== membership.spaceId) return [];
      const pathPrefix = intersectPathPrefixes(
        membershipPrefix,
        scope.pathPrefix,
      );
      if (pathPrefix === undefined) return [];
      const permissions = membershipPermissions.filter((permission) =>
        scope.permissions.includes(permission),
      );
      if (!permissions.length) return [];
      return [
        {
          spaceId: membership.spaceId,
          role: membership.role,
          pathPrefix,
          permissions,
        },
      ];
    });
  });
}

/** Persist only authorization already effective for the current actor. A web
 * session is a bearer credential in its own right, so it must carry this
 * least-privilege snapshot instead of expanding back to every user membership.
 */
export function serializeEffectiveScopes(actor: Actor): {
  spaces: PersistedTokenScope[];
} {
  const seen = new Set<string>();
  const spaces = actor.memberships
    .map((membership) => ({
      spaceId: membership.spaceId,
      pathPrefix: normalizePath(membership.pathPrefix),
      permissions: [...permissionsForMembership(membership)].sort(),
    }))
    .filter(
      (scope): scope is PersistedTokenScope =>
        scope.permissions.length > 0 && scope.pathPrefix !== undefined,
    )
    .sort((left, right) =>
      `${left.spaceId}:${left.pathPrefix ?? ""}:${left.permissions.join(",")}`.localeCompare(
        `${right.spaceId}:${right.pathPrefix ?? ""}:${right.permissions.join(",")}`,
      ),
    )
    .filter((scope) => {
      const key = `${scope.spaceId}:${scope.pathPrefix ?? ""}:${scope.permissions.join(",")}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { spaces };
}

export function authorizationPolicyFingerprint(actor: Actor): string {
  const canonicalMemberships = actor.memberships
    .map((membership) => ({
      spaceId: membership.spaceId,
      pathPrefix: normalizePath(membership.pathPrefix),
      permissions: [...permissionsForMembership(membership)].sort(),
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return createHash("sha256")
    .update(
      JSON.stringify({
        memberships: canonicalMemberships,
        principal: {
          id: actor.principalId,
          kind: actor.principalKind,
          parentPrincipalId: actor.parentPrincipalId,
          sessionId: actor.principalSessionId,
          vaultId: actor.principalVaultId,
          allowedActions: [...actor.principalAllowedActions].sort(),
          policyRevision: actor.principalPolicyRevision,
        },
      }),
    )
    .digest("hex");
}

function idempotencyScopeFingerprint(
  authenticationKind: Actor["authenticationKind"],
  credentialId: string,
  memberships: Actor["memberships"],
  tokenScopes: unknown,
  vaultAuthorizationState: readonly Record<string, unknown>[],
  principal: {
    id: string;
    kind: string;
    vaultId: string | null;
    policyRevision: number;
    allowedActions: string[];
  },
): string {
  const canonicalMemberships = memberships
    .map((membership) => ({
      spaceId: membership.spaceId,
      pathPrefix: normalizePath(membership.pathPrefix),
      permissions: [...permissionsForMembership(membership)].sort(),
    }))
    .sort((left, right) =>
      JSON.stringify(left).localeCompare(JSON.stringify(right)),
    );
  return createHash("sha256")
    .update(
      JSON.stringify({
        authenticationKind,
        credentialId,
        memberships: canonicalMemberships,
        // A vault grant is an independent authorization boundary. Include the
        // complete current grant set (including disabled rows) and the
        // credential's persisted token/session scope so an idempotency replay
        // cannot survive a vault revocation or scope narrowing.
        tokenScopes,
        principal: {
          ...principal,
          allowedActions: [...principal.allowedActions].sort(),
        },
        vaultAuthorizationState: vaultAuthorizationState
          .map((membership) => ({
            vaultId: String(membership.vault_id ?? ""),
            spaceId: String(membership.space_id ?? ""),
            visibility: String(membership.vault_visibility ?? ""),
            vaultEnabled: membership.vault_enabled !== false,
            role:
              membership.role === null || membership.role === undefined
                ? null
                : String(membership.role),
            pathPrefix:
              membership.path_prefix === null ||
              membership.path_prefix === undefined
                ? null
                : String(membership.path_prefix),
            permissions: Array.isArray(membership.permissions)
              ? membership.permissions
                  .filter(
                    (permission): permission is string =>
                      typeof permission === "string",
                  )
                  .sort()
              : (membership.permissions ?? []),
            membershipEnabled:
              membership.membership_enabled === null ||
              membership.membership_enabled === undefined
                ? null
                : membership.membership_enabled !== false,
          }))
          .sort((left, right) =>
            JSON.stringify(left).localeCompare(JSON.stringify(right)),
          ),
      }),
    )
    .digest("hex");
}

function safeHashEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function cookieValue(header: string | undefined, name: string): string {
  if (!header) return "";
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return "";
    }
  }
  return "";
}

export function actorOf(request: FastifyRequest): Actor | null {
  return (request as FastifyRequest & { actor?: Actor }).actor ?? null;
}

export function hasPermission(
  actor: Actor,
  permission: Permission,
  spaceId?: string,
): boolean {
  return actor.memberships.some(
    (membership) =>
      (!spaceId || membership.spaceId === spaceId) &&
      permissionsForMembership(membership).includes(permission),
  );
}

export function hasSpaceAccess(
  actor: Actor | null,
  spaceId: string,
  permission: Permission,
): boolean {
  return Boolean(actor && hasPermission(actor, permission, spaceId));
}

export function spaceIdsForPermission(
  actor: Actor | null,
  permission: Permission,
): string[] {
  if (!actor) return [];
  return [
    ...new Set(
      actor.memberships
        .filter((membership) =>
          permissionsForMembership(membership).includes(permission),
        )
        .map((membership) => membership.spaceId),
    ),
  ];
}

export function rolesForPermission(
  actor: Actor | null,
  spaceId: string,
  permission: Permission,
): string[] {
  if (!actor) return [];
  return [
    ...new Set(
      actor.memberships
        .filter(
          (membership) =>
            membership.spaceId === spaceId &&
            permissionsForMembership(membership).includes(permission),
        )
        .map((membership) => membership.role),
    ),
  ].sort();
}

export function hasPathAccess(
  actor: Actor | null,
  spaceId: string,
  permission: Permission,
  relativePath: string,
): boolean {
  if (!actor) return false;
  const normalized = normalizePath(relativePath);
  if (normalized === undefined || normalized === null) return false;
  return actor.memberships.some((membership) => {
    if (
      membership.spaceId !== spaceId ||
      !permissionsForMembership(membership).includes(permission)
    ) {
      return false;
    }
    const prefix = normalizePath(membership.pathPrefix);
    if (prefix === undefined) return false;
    return (
      !prefix || normalized === prefix || normalized.startsWith(`${prefix}/`)
    );
  });
}

/**
 * Return the normalized path scopes that currently grant a permission in one
 * space. Callers that execute recursive SQL use these values before ranking or
 * traversal so an unauthorized document cannot act as an invisible bridge.
 */
export function pathPrefixesForPermission(
  actor: Actor | null,
  spaceId: string,
  permission: Permission,
): Array<string | null> {
  if (!actor) return [];
  const prefixes = actor.memberships.flatMap((membership) => {
    if (
      membership.spaceId !== spaceId ||
      !permissionsForMembership(membership).includes(permission)
    ) {
      return [];
    }
    const prefix = normalizePath(membership.pathPrefix);
    return prefix === undefined ? [] : [prefix];
  });
  return [
    ...new Map(prefixes.map((prefix) => [prefix ?? "", prefix])).values(),
  ];
}

/** A path-scoped membership cannot read or mutate a resource that has no
 * canonical knowledge path to evaluate. This conservative default avoids
 * leaking raw sources, jobs or workspace-wide operational metadata. */
export function hasUnrestrictedPathAccess(
  actor: Actor | null,
  spaceId: string,
  permission: Permission,
): boolean {
  return Boolean(
    actor?.memberships.some(
      (membership) =>
        membership.spaceId === spaceId &&
        normalizePath(membership.pathPrefix) === null &&
        permissionsForMembership(membership).includes(permission),
    ),
  );
}

/** Pathless operational resources (jobs, index metadata, error registers,
 * schema reports) cannot be safely filtered by a document prefix. Callers of
 * those routes must have an unrestricted membership for the relevant space. */
export function unrestrictedSpaceIdsForPermission(
  actor: Actor | null,
  permission: Permission,
): string[] {
  return spaceIdsForPermission(actor, permission).filter((spaceId) =>
    hasUnrestrictedPathAccess(actor, spaceId, permission),
  );
}

export function hasPrincipalAction(
  actor: Actor | null,
  action: string,
): boolean {
  return Boolean(
    actor &&
    (actor.principalAllowedActions.includes("*") ||
      actor.principalAllowedActions.includes(action)),
  );
}

export function requirePrincipalAction(
  action: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const actor = actorOf(request);
    if (!actor) {
      await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      return;
    }
    if (!hasPrincipalAction(actor, action)) {
      await reply.code(403).send({ code: "PRINCIPAL_ACTION_DENIED", action });
    }
  };
}

export function requirePermission(
  permission: Permission,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    const actor = actorOf(request);
    if (!actor) {
      await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      return;
    }
    if (!hasPermission(actor, permission)) {
      await reply.code(403).send({ code: "PERMISSION_DENIED", permission });
    }
  };
}

function agentProcessRouteAction(
  method: string,
  requestPath: string,
): string | null {
  if (requestPath === "/v1/auth/session" && ["GET", "POST"].includes(method)) {
    return "workspace:read";
  }
  if (requestPath === "/v1/sessions" && method === "GET") {
    return "workspace:read";
  }
  if (/^\/v1\/sessions\/[^/]+\/state$/.test(requestPath) && method === "GET") {
    return "workspace:read";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/bootstrap$/.test(requestPath) &&
    method === "POST"
  ) {
    return "workspace:read";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/promotions$/.test(requestPath) &&
    method === "POST"
  ) {
    return "knowledge:propose";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/claims$/.test(requestPath) &&
    method === "POST"
  ) {
    return "workspace:claim";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/claims\/heartbeat$/.test(requestPath) &&
    method === "POST"
  ) {
    return "workspace:claim";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/claims\/release$/.test(requestPath) &&
    method === "POST"
  ) {
    return "workspace:claim";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/claims\/handoff$/.test(requestPath) &&
    method === "POST"
  ) {
    return "workspace:handoff";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/events$/.test(requestPath) &&
    method === "POST"
  ) {
    return "workspace:event:append";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/decisions(?:\/[^/]+)?$/.test(requestPath) &&
    method === "GET"
  ) {
    return "workspace:read";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/decisions$/.test(requestPath) &&
    method === "POST"
  ) {
    return "workspace:event:append";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/decisions\/[^/]+\/(?:alternatives|objections|consultations|selection)$/.test(
      requestPath,
    ) &&
    method === "POST"
  ) {
    return "workspace:event:append";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/decisions\/[^/]+\/(?:alternatives\/[^/]+\/decision|objections\/[^/]+\/resolve|consultations\/[^/]+\/respond)$/.test(
      requestPath,
    ) &&
    method === "POST"
  ) {
    return "workspace:event:append";
  }
  if (
    /^\/v1\/sessions\/[^/]+\/decisions\/[^/]+\/capture$/.test(requestPath) &&
    method === "POST"
  ) {
    return "knowledge:propose";
  }
  if (
    ["/v1/search", "/v1/context"].includes(requestPath) &&
    method === "POST"
  ) {
    return "knowledge:read";
  }
  if (requestPath === "/v1/proposals" && method === "POST") {
    return "knowledge:propose";
  }
  return null;
}

export function registerAuthentication(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/")) return;
    const authorization = request.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ")
      ? authorization.slice(7).trim()
      : "";
    const sessionToken = cookieValue(request.headers.cookie, "akp_session");
    const token = bearer || sessionToken;
    if (!token) {
      await reply.code(401).send({ code: "AUTHENTICATION_REQUIRED" });
      return;
    }
    const hash = tokenHash(token);
    const result = await db.pool.query<AuthenticationRow>(
      `
      with credential as (
        select id token_id,user_id,token_hash credential_hash,null::text csrf_hash,
               null::uuid session_id,'API_TOKEN'::text authentication_kind,scopes token_scopes,
               null::uuid principal_id,null::bigint credential_policy_revision,
               array['*']::text[] credential_allowed_actions
          from api_tokens
         where revoked_at is null
           and (expires_at is null or expires_at > now())
           and token_hash=$1
        union all
        select null::uuid token_id,user_id,token_hash,csrf_hash,id,'WEB_SESSION'::text,
               scopes token_scopes,null::uuid,null::bigint,array['*']::text[]
          from web_sessions
         where revoked_at is null and expires_at > now() and token_hash=$1
        union all
        select id token_id,user_id,token_hash,null::text,null::uuid,
               'PRINCIPAL_TOKEN'::text,scopes,principal_id,policy_revision,allowed_actions
          from principal_credentials
         where revoked_at is null and expires_at > now() and token_hash=$1
      )
      select c.credential_hash,c.csrf_hash,c.session_id,c.authentication_kind,c.token_id,c.token_scopes,
             c.principal_id,c.credential_policy_revision,c.credential_allowed_actions,
             u.id, u.email,
             array_remove(array_agg(distinct m.role), null) roles,
             array_remove(array_agg(distinct m.space_id::text), null) space_ids,
             coalesce(
               jsonb_agg(
                 distinct jsonb_build_object(
                   'spaceId',m.space_id::text,'role',m.role,'pathPrefix',m.path_prefix
                 )
               ) filter (where m.id is not null),
               '[]'::jsonb
             ) memberships
        from credential c
        join users u on u.id = c.user_id
        left join memberships m on m.user_id = u.id
       group by c.credential_hash,c.csrf_hash,c.session_id,c.authentication_kind,c.token_id,c.token_scopes,
                c.principal_id,c.credential_policy_revision,c.credential_allowed_actions,u.id,u.email
       limit 1
      `,
      [hash],
    );
    const row = result.rows[0];
    if (!row || !safeHashEquals(hash, String(row.credential_hash))) {
      await reply.code(401).send({ code: "INVALID_TOKEN" });
      return;
    }
    const authenticationKind = String(
      row.authentication_kind,
    ) as Actor["authenticationKind"];
    if (
      authenticationKind === "WEB_SESSION" &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
    ) {
      const csrfHeader = request.headers["x-csrf-token"];
      const csrf = Array.isArray(csrfHeader) ? csrfHeader[0] : csrfHeader;
      const csrfHash = csrf ? tokenHash(csrf) : "";
      if (!csrfHash || !safeHashEquals(csrfHash, String(row.csrf_hash))) {
        await reply.code(403).send({ code: "CSRF_TOKEN_REQUIRED" });
        return;
      }
    }
    const principalResult = await db.pool.query<Record<string, unknown>>(
      `select p.id,p.kind,p.parent_principal_id,p.session_id,p.vault_id,p.allowed_actions,
              p.policy_revision,p.state,parent.state parent_state
         from principals p
         left join principals parent on parent.id=p.parent_principal_id
        where p.id=coalesce(
          $1::uuid,
          (select id from principals where kind='HUMAN' and user_id=$2 limit 1)
        )
        limit 1`,
      [row.principal_id, row.id],
    );
    const principal = principalResult.rows[0];
    // Derived principals never outlive their authority root. Checking only the
    // child state would let an issued AGENT_PROCESS continue after its parent
    // human principal was revoked. Fail closed as an invalid credential when
    // the recorded parent is missing or no longer active.
    if (
      !principal ||
      principal.state !== "ACTIVE" ||
      (principal.parent_principal_id && principal.parent_state !== "ACTIVE")
    ) {
      await reply.code(401).send({ code: "INVALID_TOKEN" });
      return;
    }
    if (
      String(row.authentication_kind) === "PRINCIPAL_TOKEN" &&
      Number(row.credential_policy_revision) !==
        Number(principal.policy_revision)
    ) {
      await reply.code(401).send({ code: "PRINCIPAL_POLICY_CHANGED" });
      return;
    }
    const principalActions = Array.isArray(principal.allowed_actions)
      ? principal.allowed_actions.map(String)
      : [];
    const credentialActions = Array.isArray(row.credential_allowed_actions)
      ? row.credential_allowed_actions.map(String)
      : [];
    const principalAllowedActions = principalActions.includes("*")
      ? credentialActions
      : credentialActions.filter((action) => principalActions.includes(action));

    const databaseMemberships = (row.memberships ?? []).flatMap(
      (membership: Record<string, unknown>) => {
        const pathPrefix =
          membership.pathPrefix === null || membership.pathPrefix === undefined
            ? null
            : normalizePath(String(membership.pathPrefix));
        if (pathPrefix === undefined) return [];
        return [
          {
            spaceId: String(membership.spaceId),
            role: String(membership.role),
            pathPrefix,
          },
        ];
      },
    );
    // Both API tokens and web sessions are credentials with persisted scopes.
    // A session is created from an already-intersected API-token actor and is
    // re-intersected with current memberships on every request. This prevents
    // a narrow token from being exchanged for the user's broader web role.
    const memberships = scopeMemberships(databaseMemberships, row.token_scopes);
    // Include every vault in the actor's effective spaces, not only explicit
    // grants. TEAM/CENTRAL access can be inherited from a space membership,
    // and a disabled vault or TEAM -> PRIVATE transition must invalidate a
    // completed idempotency replay before route-specific authorization runs.
    const vaultAuthorizationState = await db.pool.query(
      `
      select v.id::text vault_id, v.space_id::text, v.visibility vault_visibility,
             v.enabled vault_enabled, vm.role, vm.path_prefix, vm.permissions,
             vm.enabled membership_enabled
        from vaults v
        left join vault_memberships vm
          on vm.vault_id=v.id and vm.user_id=$1
       where v.space_id=any($2::uuid[])
       order by v.id,vm.id
      `,
      [
        row.id,
        [...new Set(memberships.map((membership) => membership.spaceId))],
      ],
    );
    const credentialId = String(row.token_id ?? row.session_id ?? "unknown");
    const actor: Actor = {
      id: String(row.id),
      email: String(row.email),
      roles: [...new Set(memberships.map((membership) => membership.role))],
      spaceIds: [
        ...new Set(memberships.map((membership) => membership.spaceId)),
      ],
      memberships,
      authenticationKind,
      principalId: String(principal.id),
      principalKind: String(principal.kind) as Actor["principalKind"],
      parentPrincipalId: principal.parent_principal_id
        ? String(principal.parent_principal_id)
        : null,
      principalSessionId: principal.session_id
        ? String(principal.session_id)
        : null,
      principalVaultId: principal.vault_id ? String(principal.vault_id) : null,
      principalAllowedActions,
      principalPolicyRevision: Number(principal.policy_revision),
      idempotencyScopeFingerprint: idempotencyScopeFingerprint(
        authenticationKind,
        credentialId,
        memberships,
        row.token_scopes,
        vaultAuthorizationState.rows as Array<Record<string, unknown>>,
        {
          id: String(principal.id),
          kind: String(principal.kind),
          vaultId: principal.vault_id ? String(principal.vault_id) : null,
          policyRevision: Number(principal.policy_revision),
          allowedActions: principalAllowedActions,
        },
      ),
      ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    };
    (request as FastifyRequest & { actor: Actor }).actor = actor;
    if (actor.principalKind === "AGENT_PROCESS") {
      if (!actor.principalSessionId || !actor.principalVaultId) {
        await reply.code(401).send({ code: "PRINCIPAL_SCOPE_INVALID" });
        return;
      }
      const requestPath = request.url.split("?")[0] ?? request.url;
      const requiredAction = agentProcessRouteAction(
        request.method,
        requestPath,
      );
      if (!requiredAction || !hasPrincipalAction(actor, requiredAction)) {
        await reply.code(403).send({
          code: "PRINCIPAL_ROUTE_DENIED",
          ...(requiredAction ? { action: requiredAction } : {}),
        });
        return;
      }
    }
    if (
      actor.principalKind === "MAINTENANCE_JOB" &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method)
    ) {
      await reply.code(403).send({
        code: "MAINTENANCE_PRINCIPAL_MUTATION_DENIED",
      });
      return;
    }
    if (actor.sessionId) {
      await db.pool.query(
        "update web_sessions set last_seen_at=now() where id=$1",
        [actor.sessionId],
      );
    }
  });
}

export async function audit(
  db: Postgres,
  request: FastifyRequest,
  action: string,
  resourceType: string,
  resourceId?: string,
  metadata: Record<string, unknown> = {},
  spaceId?: string,
): Promise<void> {
  const sanitizedMetadata = sanitizeAuditMetadata(metadata);
  const actor = actorOf(request);
  const body =
    request.body && typeof request.body === "object"
      ? (request.body as Record<string, unknown>)
      : {};
  const requestedSpace =
    typeof body.spaceId === "string" ? body.spaceId : undefined;
  const resolvedSpace =
    spaceId ??
    (requestedSpace && actor?.spaceIds.includes(requestedSpace)
      ? requestedSpace
      : undefined) ??
    (actor?.spaceIds.length === 1 ? actor.spaceIds[0] : null);
  const candidateVaultId =
    typeof metadata.vaultId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      metadata.vaultId,
    )
      ? metadata.vaultId
      : null;
  const inserted = await db.pool.query(
    `
    with resolved_organization as (
      select s.organization_id,0 priority
        from spaces s where s.id=$1
      union all
      select s.organization_id,1 priority
        from memberships m join spaces s on s.id=m.space_id
       where m.user_id=$2
      order by priority limit 1
    )
    insert into audit_events(organization_id, space_id, actor_id, principal_id, action, resource_type,
                             resource_id, metadata, trace_id, vault_id)
    select organization_id,$1,$2,$3,$4,$5,$6,$7::jsonb,$8,
           case when exists(
             select 1 from vaults where id=$9::uuid and space_id=$1
           ) then $9::uuid else null end
      from resolved_organization
    returning id
    `,
    [
      resolvedSpace,
      actor?.id ?? null,
      actor?.principalId ?? null,
      action,
      resourceType,
      resourceId ?? null,
      JSON.stringify(sanitizedMetadata),
      request.id,
      candidateVaultId,
    ],
  );
  if (!inserted.rowCount) throw new Error("AUDIT_ORGANIZATION_UNRESOLVED");
}

const AUDIT_SENSITIVE_KEY =
  /^(?:source(?:uri|_uri|path|_path)|local(?:path|_path)|absolute(?:path|_path)|repository(?:path|_path)|root(?:path|_path)|canonical(?:path|_path)|object(?:key|_key)|endpoint|host)$/i;
const ABSOLUTE_PATH_TOKEN =
  /(?:[A-Za-z]:[\\/]|\\\\|file:\/\/|\/(?:Users|home|tmp|var)\/)[^\s"']+/g;

/** Remove host routing details before audit metadata becomes durable. */
function sanitizeAuditMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditMetadata);
  if (typeof value === "string") {
    return value.replaceAll(ABSOLUTE_PATH_TOKEN, "[REDACTED_PATH]");
  }
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !AUDIT_SENSITIVE_KEY.test(key))
      .map(([key, entry]) => [key, sanitizeAuditMetadata(entry)]),
  );
}
