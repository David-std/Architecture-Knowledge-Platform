# Repository hygiene report

Status: `IMPLEMENTED_AND_EXECUTED`

The hygiene gate is deterministic and classifies the existing repository files
into the categories required by the final hardening goal. It ignores paths that
Git reports as deleted but that are no longer present in the worktree, keeps
iteration residue under `docs/archive/iterations/` explicitly classified, and
separates generic evals from vault-specific fixture packs.

Generated inventory: `REPOSITORY_FILE_CLASSIFICATION.json`

Command executed:

```text
node scripts/validate-repository-hygiene.mjs --write
```

Observed result on 2026-08-12:

```json
{
  "status": "PASSED",
  "files": 320,
  "classificationPath": "REPOSITORY_FILE_CLASSIFICATION.json"
}
```

Tests and fixtures are excluded from the fixed-UUID scan; intentional
fixture-specific IDs remain in their scoped eval pack.
