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
  authenticationKind: "API_TOKEN" | "WEB_SESSION";
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
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
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

function idempotencyScopeFingerprint(
  authenticationKind: Actor["authenticationKind"],
  credentialId: string,
  memberships: Actor["memberships"],
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
               null::uuid session_id,'API_TOKEN'::text authentication_kind,scopes token_scopes
          from api_tokens
         where revoked_at is null
           and (expires_at is null or expires_at > now())
           and token_hash=$1
        union all
        select null::uuid token_id,user_id,token_hash,csrf_hash,id,'WEB_SESSION'::text,
               scopes token_scopes
          from web_sessions
         where revoked_at is null and expires_at > now() and token_hash=$1
      )
      select c.credential_hash,c.csrf_hash,c.session_id,c.authentication_kind,c.token_id,c.token_scopes,
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
       group by c.credential_hash,c.csrf_hash,c.session_id,c.authentication_kind,c.token_id,c.token_scopes,u.id,u.email
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
      idempotencyScopeFingerprint: idempotencyScopeFingerprint(
        authenticationKind,
        credentialId,
        memberships,
      ),
      ...(row.session_id ? { sessionId: String(row.session_id) } : {}),
    };
    (request as FastifyRequest & { actor: Actor }).actor = actor;
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
    insert into audit_events(organization_id, space_id, actor_id, action, resource_type,
                             resource_id, metadata, trace_id, vault_id)
    select organization_id,$1,$2,$3,$4,$5,$6::jsonb,$7,
           case when exists(
             select 1 from vaults where id=$8::uuid and space_id=$1
           ) then $8::uuid else null end
      from resolved_organization
    returning id
    `,
    [
      resolvedSpace,
      actor?.id ?? null,
      action,
      resourceType,
      resourceId ?? null,
      JSON.stringify(metadata),
      request.id,
      candidateVaultId,
    ],
  );
  if (!inserted.rowCount) throw new Error("AUDIT_ORGANIZATION_UNRESOLVED");
}
