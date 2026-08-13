# Contributing

Read `AGENTS.md`, `PROJECT_STATE.md` and `REMAINING_REAL_GAPS.md` before making a
change. Keep product behavior generic: course names, private vault paths and
consumer-specific gold IDs belong only in named fixture packs.

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
- Do not create root-level progress, handoff or scratch documents. Use ignored
  `.work/`, `.tmp/` and `.cache/` directories for local artifacts.

## Required local gates

```powershell
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm audit --audit-level high
pnpm exec prettier --check .
pnpm security:secrets
pnpm contracts:validate
pnpm docs:validate
pnpm hygiene:validate
pnpm check
pnpm build
pnpm test:integration
```

For extractor changes, run Ruff, pytest and the document-intelligence benchmark
under Python 3.12. For runtime changes, migrate a fresh database, start Compose,
exercise API/MCP/Web, and run backup/restore. Update canonical reports only with
the exact commands and results actually observed.

See [the detailed guide](docs/contributing.md) for repository conventions and
[local operations](docs/runbooks/local-operations.md) for runtime setup.
