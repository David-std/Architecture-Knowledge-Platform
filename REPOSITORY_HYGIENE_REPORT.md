# Repository hygiene report

Status: `IMPLEMENTED_AND_EXECUTED`

The hygiene gate is deterministic and classifies the existing repository files
into the categories required by the final hardening goal. It ignores paths that
Git reports as deleted but that are no longer present in the worktree, keeps
iteration residue under `docs/archive/iterations/` explicitly classified, and
separates generic evals from vault-specific fixture packs. Root audit and
benchmark reports remain on-demand evidence; they are not required startup
context (see `AGENTS.md`).

The gate also fails closed if either retired iteration report is reintroduced
at repository root; their only accepted location is
`docs/archive/iterations/`.

Generated inventory: `REPOSITORY_FILE_CLASSIFICATION.json`

Command executed:

```text
node scripts/validate-repository-hygiene.mjs --write
```

Observed result on 2026-08-30 against the transferred source tree:

```json
{
  "status": "PASSED",
  "files": 340,
  "classificationPath": "REPOSITORY_FILE_CLASSIFICATION.json"
}
```

The 340 classified files comprise 167 product-code files, 49 product tests,
31 product-documentation files, 18 append-only migrations, 16 product
contracts, 15 product evals, 13 canonical generated artifacts, 23 generic
fixtures, six explicitly vault-specific fixtures and two archived iteration
records classified as `OBSOLETE`. No unclassified file or sandbox write probe
is present in the generated inventory.

Tests and fixtures are excluded from the fixed-UUID scan; intentional
fixture-specific IDs remain in their scoped eval pack.
