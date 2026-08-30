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

Observed results reconciled on 2026-08-30: the current evaluation, PostgreSQL
and multivault suites are included in the passing Node validation run, and the
hygiene gate scans production UUID literals while excluding tests/fixtures, so
it can detect fixed development-space coupling in the core. The dependency
boundary scanner passed over 158 source modules and 390 dependencies in the
tagged clean checkout. The Level-B retrieval fixture uses three explicitly separate
generic vaults and never reads Architecture-Knowledge-System.
