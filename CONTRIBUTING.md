# Contributing

Read `AGENTS.md`, `docs/status.md` and `ARCHITECTURE.md` before making a change.
Keep product behavior generic: private vault paths, consumer-specific IDs and
fixture-specific terminology belong only in explicitly named fixtures/case
studies, never in the generic runtime.

## Change rules

- Preserve the read-only boundary of imported vaults.
- Add database migrations; never rewrite a migration already applied.
- Keep business rules in shared application/domain code, not only in a client
  prompt, MCP description or UI.
- Add focused tests for changed behavior and update OpenAPI, AsyncAPI and MCP
  schemas together when a contract changes.
- Do not enable a retrieval or extraction provider by default without a
  reproducible benchmark and explicit decision.
- Record uncertainty and negative results; never upgrade unexecuted work to an
  executed capability.
- Keep the repository root product-facing. Historical assurance belongs under
  `docs/assurance/`; deterministic generated evidence belongs under `reports/`
  or CI artifacts.
- Do not create root-level progress, handoff or scratch documents. Use ignored
  `.work/`, `.tmp/` and `.cache/` directories for local artifacts.

## Branch lifecycle

Keep only branches with a continuing purpose:

- `main`;
- heads of open pull requests;
- baselines/checkpoints still referenced by an active PR or recovery plan.

Delete temporary test, evidence, formatting and no-op branches after their
useful commits are merged, cherry-picked or otherwise preserved. Before deleting
a branch, verify both its PR association and commit ancestry; names alone are
not sufficient evidence that a branch is obsolete.

## Required local gates

```powershell
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm audit --audit-level high
pnpm format:check
pnpm security:secrets
pnpm contracts:validate
pnpm docs:validate
pnpm hygiene:validate
pnpm check
pnpm build
pnpm test:integration
```

For extractor changes, use the checked-in Python lock:

```powershell
Push-Location apps/extractor
uv sync --locked
uv run --locked ruff check --no-cache .
uv run --locked mypy app
uv run --locked pytest -p no:cacheprovider
Pop-Location
```

For runtime/recovery changes, migrate a fresh database, start Compose, exercise
API/MCP/Web and run backup/restore. Update `docs/status.md` only with exact
behavior actually observed.

See [the detailed guide](docs/contributing.md) and
[local operations](docs/runbooks/local-operations.md).
