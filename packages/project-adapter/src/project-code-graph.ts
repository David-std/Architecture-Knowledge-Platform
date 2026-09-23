export interface ProjectCodeGraphIdentity {
  repository: string;
  scopeId: string;
  authorizationPathPrefix: string;
}

export function projectCodeGraphIdentity(
  vaultId: string,
  slug: string,
): ProjectCodeGraphIdentity {
  const normalizedVaultId = vaultId.trim().toLowerCase();
  const normalizedSlug = slug.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      normalizedVaultId,
    )
  ) {
    throw new Error("CODE_GRAPH_VAULT_ID_INVALID");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(normalizedSlug)) {
    throw new Error("CODE_GRAPH_PROJECT_SLUG_INVALID");
  }
  return {
    repository: `akp-project:${normalizedVaultId}:${normalizedSlug}`,
    scopeId: `project:${normalizedVaultId}:${normalizedSlug}`,
    authorizationPathPrefix: `projects/${normalizedSlug}`,
  };
}

export interface ParsedProjectCodeGraphRepository extends ProjectCodeGraphIdentity {
  vaultId: string;
  slug: string;
}

export function parseProjectCodeGraphRepository(
  repository: string,
): ParsedProjectCodeGraphRepository | null {
  const match =
    /^akp-project:([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):([a-z0-9][a-z0-9-]{0,79})$/i.exec(
      repository.trim(),
    );
  if (!match) return null;
  const vaultId = match[1]!.toLowerCase();
  const slug = match[2]!.toLowerCase();
  return {
    vaultId,
    slug,
    ...projectCodeGraphIdentity(vaultId, slug),
  };
}
