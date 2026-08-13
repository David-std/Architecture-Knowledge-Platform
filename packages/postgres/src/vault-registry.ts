import type { Postgres } from "./index.js";

export type VaultVisibility = "PRIVATE" | "TEAM" | "CENTRAL";

// Kept structurally compatible with @akp/contracts without importing the
// contracts source into this package's rootDir. The API validates this shape
// at its boundary; the persistence adapter only needs the normalized values.
export interface VaultRegistration {
  vaultKey: string;
  name: string;
  spaceId: string;
  gitRepository: string | null;
  defaultBranch: string;
  localPath: string;
  contentRoots: string[];
  sourceRoots: string[];
  schemaProfile: Record<string, unknown>;
  evalPack: Record<string, unknown>;
  retrievalConfig: Record<string, unknown>;
  permissions: Record<string, unknown>;
  visibility: VaultVisibility;
  enabled: boolean;
}

export interface VaultRecord {
  id: string;
  vault_key: string;
  name: string;
  space_id: string;
  git_repository: string | null;
  default_branch: string;
  local_path: string;
  content_roots: string[];
  source_roots: string[];
  schema_profile: Record<string, unknown>;
  eval_pack: Record<string, unknown>;
  retrieval_config: Record<string, unknown>;
  permissions: Record<string, unknown>;
  visibility: VaultVisibility;
  enabled: boolean;
  current_revision: string | null;
  last_imported_at: Date | null;
}

export interface VaultMembership {
  id?: string;
  userId: string;
  vaultId: string;
  role: string;
  pathPrefix: string | null;
  permissions: string[];
  enabled: boolean;
}

export interface GrantVaultMembershipInput {
  userId: string;
  vaultId: string;
  role?: string;
  pathPrefix?: string | null;
  permissions?: readonly string[];
  enabled?: boolean;
}

export interface AuthorizedVaultScopeRequest {
  userId: string;
  spaceId: string;
  permission?: string;
  vaultId?: string;
  vaultIds?: readonly string[];
  federated?: boolean;
}

export interface AuthorizedVaultScope {
  vaults: VaultRecord[];
  vaultIds: string[];
  federated: boolean;
}

interface SpaceMembershipRow {
  role: string;
  path_prefix: string | null;
}

interface AuthorizedVaultRow extends VaultRecord {
  membership_role: string | null;
  membership_path_prefix: string | null;
  membership_permissions: unknown;
  space_role: string | null;
  space_path_prefix: string | null;
}

interface VaultMembershipRow {
  id: string;
  user_id: string;
  vault_id: string;
  role: string;
  path_prefix: string | null;
  permissions: unknown;
  enabled: boolean;
}

const ROLE_PERMISSIONS: Record<string, readonly string[]> = {
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

const selectVault = `
  select id,vault_key,name,space_id,git_repository,default_branch,local_path,
         content_roots,source_roots,schema_profile,eval_pack,retrieval_config,
         permissions,visibility,enabled,current_revision,last_imported_at
    from vaults
`;

function permissionsForRole(role: string): readonly string[] {
  return ROLE_PERMISSIONS[role] ?? [];
}

function parsePermissions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function permissionsForMembership(role: string, configured: unknown): string[] {
  const explicit = parsePermissions(configured);
  return explicit.length > 0 ? explicit : [...permissionsForRole(role)];
}

/** Normalize a relative path prefix before it is persisted or compared. */
export function normalizeVaultPathPrefix(
  value: string | null | undefined,
): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const normalized = value.replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
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

/** Intersect two relative path scopes. Undefined means malformed/conflicting. */
export function intersectVaultPathPrefixes(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null | undefined {
  const normalizedLeft = normalizeVaultPathPrefix(left);
  const normalizedRight = normalizeVaultPathPrefix(right);
  if (normalizedLeft === undefined || normalizedRight === undefined)
    return undefined;
  if (normalizedLeft === null) return normalizedRight;
  if (normalizedRight === null) return normalizedLeft;
  if (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}/`)
  ) {
    return normalizedLeft;
  }
  if (normalizedRight.startsWith(`${normalizedLeft}/`)) return normalizedRight;
  return undefined;
}

/** Check a concrete document path against an already-intersected prefix. */
export function pathMatchesVaultPrefix(
  relativePath: string,
  prefix: string | null | undefined,
): boolean {
  const normalizedPath = normalizeVaultPathPrefix(relativePath);
  const normalizedPrefix = normalizeVaultPathPrefix(prefix);
  if (normalizedPath === undefined || normalizedPath === null) return false;
  if (normalizedPrefix === undefined || normalizedPrefix === null) return true;
  return (
    normalizedPath === normalizedPrefix ||
    normalizedPath.startsWith(`${normalizedPrefix}/`)
  );
}

/**
 * Pure authorization predicate shared by DB-backed resolution and tests. A
 * vault row is visible only when the current space membership intersects the
 * explicit vault membership. TEAM and CENTRAL vaults may inherit the space
 * membership until an explicit vault grant is created; PRIVATE vaults never do.
 */
export function canAccessVault(
  visibility: VaultVisibility,
  spaceMembership: { role: string; pathPrefix: string | null } | null,
  vaultMembership: {
    role: string;
    pathPrefix: string | null;
    permissions?: readonly string[];
  } | null,
  permission?: string,
): { allowed: boolean; pathPrefix: string | null; permissions: string[] } {
  if (!spaceMembership) {
    return { allowed: false, pathPrefix: null, permissions: [] };
  }
  const inherited = vaultMembership === null && visibility !== "PRIVATE";
  if (vaultMembership === null && !inherited) {
    return { allowed: false, pathPrefix: null, permissions: [] };
  }
  const vaultPermissions = vaultMembership
    ? vaultMembership.permissions && vaultMembership.permissions.length > 0
      ? [...vaultMembership.permissions]
      : [...permissionsForRole(vaultMembership.role)]
    : [...permissionsForRole(spaceMembership.role)];
  const spacePermissions = new Set(permissionsForRole(spaceMembership.role));
  const permissions = vaultPermissions.filter((entry) =>
    spacePermissions.has(entry),
  );
  if (permission && !permissions.includes(permission)) {
    return { allowed: false, pathPrefix: null, permissions };
  }
  const pathPrefix = intersectVaultPathPrefixes(
    spaceMembership.pathPrefix,
    vaultMembership?.pathPrefix,
  );
  if (pathPrefix === undefined) {
    return { allowed: false, pathPrefix: null, permissions };
  }
  return { allowed: true, pathPrefix, permissions };
}

export async function registerVault(
  db: Postgres,
  registration: VaultRegistration,
  options: { ownerUserId?: string } = {},
): Promise<VaultRecord> {
  const result = await db.pool.query<VaultRecord>(
    `
    insert into vaults(
      space_id,canonical_path,name,read_only,vault_key,git_repository,
      default_branch,local_path,content_roots,source_roots,schema_profile,
      eval_pack,retrieval_config,permissions,visibility,enabled
    ) values($1,$2,$3,true,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15)
    on conflict(vault_key) do update set
      name=excluded.name,git_repository=excluded.git_repository,
      default_branch=excluded.default_branch,canonical_path=excluded.canonical_path,
      local_path=excluded.local_path,content_roots=excluded.content_roots,
      source_roots=excluded.source_roots,schema_profile=excluded.schema_profile,
      eval_pack=excluded.eval_pack,retrieval_config=excluded.retrieval_config,
      permissions=excluded.permissions,visibility=excluded.visibility,
      enabled=excluded.enabled
    where vaults.space_id=excluded.space_id
    returning id,vault_key,name,space_id,git_repository,default_branch,local_path,
              content_roots,source_roots,schema_profile,eval_pack,retrieval_config,
              permissions,visibility,enabled,current_revision,last_imported_at
    `,
    [
      registration.spaceId,
      registration.localPath,
      registration.name,
      registration.vaultKey,
      registration.gitRepository,
      registration.defaultBranch,
      registration.localPath,
      registration.contentRoots,
      registration.sourceRoots,
      JSON.stringify(registration.schemaProfile),
      JSON.stringify(registration.evalPack),
      JSON.stringify(registration.retrievalConfig),
      JSON.stringify(registration.permissions),
      registration.visibility,
      registration.enabled,
    ],
  );
  const vault = result.rows[0];
  if (!vault) {
    throw new Error("VAULT_KEY_OWNED_BY_DIFFERENT_SPACE");
  }
  if (options.ownerUserId) {
    await grantVaultMembership(db, {
      userId: options.ownerUserId,
      vaultId: vault.id,
      role: "ADMIN",
      permissions: ROLE_PERMISSIONS.ADMIN ?? [],
    });
  }
  return vault;
}

export async function grantVaultMembership(
  db: Postgres,
  input: GrantVaultMembershipInput,
): Promise<VaultMembership> {
  const pathPrefix = normalizeVaultPathPrefix(input.pathPrefix);
  if (pathPrefix === undefined) throw new Error("INVALID_VAULT_PATH_PREFIX");
  const role = input.role ?? "VIEWER";
  const permissions = [
    ...(input.permissions && input.permissions.length > 0
      ? input.permissions
      : permissionsForRole(role)),
  ];
  const result = await db.pool.query<VaultMembershipRow>(
    `
    insert into vault_memberships(
      user_id,vault_id,role,path_prefix,permissions,enabled
    )
    select $1,$2,$3,$4,$5::jsonb,$6
      from vaults v
     where v.id=$2
       and exists(
         select 1 from memberships m
          where m.user_id=$1 and m.space_id=v.space_id
       )
    on conflict(user_id,vault_id,role,path_prefix) do update set
      permissions=excluded.permissions,enabled=excluded.enabled
    returning id,user_id,vault_id,role,path_prefix,permissions,enabled
    `,
    [
      input.userId,
      input.vaultId,
      role,
      pathPrefix,
      JSON.stringify(permissions),
      input.enabled ?? true,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("VAULT_SPACE_MEMBERSHIP_REQUIRED");
  return {
    id: String(row.id),
    userId: String(row.user_id),
    vaultId: String(row.vault_id),
    role: String(row.role),
    pathPrefix: row.path_prefix,
    permissions: parsePermissions(row.permissions),
    enabled: Boolean(row.enabled),
  };
}

export async function listVaults(
  db: Postgres,
  spaceIds: readonly string[],
): Promise<VaultRecord[]> {
  if (spaceIds.length === 0) return [];
  const result = await db.pool.query<VaultRecord>(
    `${selectVault} where space_id=any($1::uuid[]) order by vault_key`,
    [spaceIds],
  );
  return result.rows;
}

export async function getVault(
  db: Postgres,
  identifier: string,
  spaceIds: readonly string[],
): Promise<VaultRecord | null> {
  if (spaceIds.length === 0) return null;
  const isUuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      identifier,
    );
  const result = await db.pool.query<VaultRecord>(
    `${selectVault} where space_id=any($1::uuid[]) and ${isUuid ? "id=$2::uuid" : "vault_key=$2"} limit 1`,
    [spaceIds, identifier],
  );
  return result.rows[0] ?? null;
}

/**
 * Resolve a vault scope after intersecting the user's space and vault
 * memberships. A multi-vault result is never implicit: callers must opt in
 * with `federated=true`.
 */
export async function resolveAuthorizedVaultScope(
  db: Postgres,
  request: AuthorizedVaultScopeRequest,
): Promise<AuthorizedVaultScope> {
  const requested = [
    ...new Set([
      ...(request.vaultId ? [request.vaultId] : []),
      ...(request.vaultIds ?? []),
    ]),
  ];
  const federated = request.federated === true;
  if (requested.length === 0 && !federated) {
    throw new Error("VAULT_SCOPE_REQUIRED");
  }
  if (requested.length > 1 && !federated) {
    throw new Error("FEDERATED_QUERY_REQUIRES_EXPLICIT_OPT_IN");
  }

  const candidates = await db.pool.query<
    AuthorizedVaultRow & SpaceMembershipRow
  >(
    `
    select v.id,v.vault_key,v.name,v.space_id,v.git_repository,v.default_branch,
           v.local_path,v.content_roots,v.source_roots,v.schema_profile,
           v.eval_pack,v.retrieval_config,v.permissions,v.visibility,v.enabled,
           v.current_revision,v.last_imported_at,
           vm.role membership_role,vm.path_prefix membership_path_prefix,
           vm.permissions membership_permissions,
           sm.role space_role,sm.path_prefix space_path_prefix
      from vaults v
      left join vault_memberships vm
        on vm.vault_id=v.id and vm.user_id=$1 and vm.enabled=true
      left join memberships sm
        on sm.user_id=$1 and sm.space_id=v.space_id
     where v.space_id=$2 and v.enabled=true
       and ($3::text[] is null or v.id::text=any($3::text[]) or v.vault_key=any($3::text[]))
     order by v.vault_key,vm.id,sm.id
    `,
    [request.userId, request.spaceId, requested.length > 0 ? requested : null],
  );
  if (candidates.rowCount === 0) throw new Error("VAULT_SCOPE_NOT_FOUND");

  const selected = new Map<string, VaultRecord>();
  const denied = new Set<string>();
  for (const row of candidates.rows) {
    const access = canAccessVault(
      row.visibility,
      row.space_role
        ? { role: row.space_role, pathPrefix: row.space_path_prefix }
        : null,
      row.membership_role
        ? {
            role: row.membership_role,
            pathPrefix: row.membership_path_prefix,
            permissions: parsePermissions(row.membership_permissions),
          }
        : null,
      request.permission,
    );
    if (!access.allowed) {
      denied.add(String(row.id));
      continue;
    }
    if (!selected.has(String(row.id))) {
      const {
        membership_role: _membershipRole,
        membership_path_prefix: _membershipPath,
        membership_permissions: _membershipPermissions,
        space_role: _spaceRole,
        space_path_prefix: _spacePath,
        ...vault
      } = row;
      selected.set(String(row.id), vault);
    }
  }

  const selectedIds = [...selected.keys()];
  if (requested.length > 0) {
    const requestedIds = new Set(requested);
    const requestedRows = candidates.rows.filter(
      (row) =>
        requestedIds.has(String(row.id)) || requestedIds.has(row.vault_key),
    );
    if (requestedRows.length < requested.length) {
      throw new Error("VAULT_SCOPE_NOT_FOUND");
    }
    if (selectedIds.length !== requested.length) {
      throw new Error("VAULT_ACCESS_DENIED");
    }
  }
  if (selectedIds.length === 0) {
    if (denied.size > 0) throw new Error("VAULT_ACCESS_DENIED");
    throw new Error("VAULT_SCOPE_NOT_FOUND");
  }
  if (selectedIds.length > 1 && !federated) {
    throw new Error("FEDERATED_QUERY_REQUIRES_EXPLICIT_OPT_IN");
  }
  const vaults = [...selected.values()].sort((left, right) =>
    left.vault_key.localeCompare(right.vault_key),
  );
  return { vaults, vaultIds: vaults.map((vault) => vault.id), federated };
}
