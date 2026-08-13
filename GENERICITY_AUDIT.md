# Genericity audit

Status: `IMPLEMENTED_AND_EXECUTED`

The executable core now has an explicit neutral eval pack under `evals/generic`
and the Architecture Knowledge System cases live only under
`evals/fixtures/architecture-knowledge-system`. The dataset loader rejects
unknown case fields, duplicate gold IDs, duplicate case IDs and course-specific
terms in the generic pack.

The migration and Postgres adapter provide a generic `VaultRegistry`, explicit
PRIVATE/TEAM/CENTRAL visibility, vault memberships and per-vault document path
and external-ID uniqueness. `resolveAuthorizedVaultScope` requires an explicit
federated opt-in for multiple vaults and intersects space/vault permissions and
path prefixes.

Commands executed:

```text
vitest run packages/evaluation/test packages/postgres/test
node scripts/validate-repository-hygiene.mjs --write
```

Observed results refreshed on 2026-08-12: evaluation tests passed 7/7,
PostgreSQL tests passed 12/12 against a real database, the multivault indexing
suite passed 4/4, and the hygiene command passed with 320 classified files.
The gate scans production UUID literals and excludes tests/fixtures, so this
result is evidence that no fixed development-space UUID remains in the scanned
core.
