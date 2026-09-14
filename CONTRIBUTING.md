# Contributing

Architecture Knowledge Platform accepts changes that preserve its local-first, multi-vault and review-governed design. Keep contributions generic: developer-specific paths, private corpus names and one-off environment assumptions do not belong in product code or active documentation.

## Branch naming

Use lowercase kebab-case with a short purpose prefix:

- `feat/<topic>`
- `fix/<topic>`
- `docs/<topic>`
- `test/<topic>`
- `chore/<topic>`

Keep branches short-lived. Do not publish remote scratch, no-op or experiment branches; use ignored local working directories instead. Remove branches after merge or abandonment.

## Change expectations

1. Preserve the read-only boundary of imported vaults and immutable evidence.
2. Add a database migration rather than modifying an applied migration.
3. Keep authorization, validation and publication rules in executable application/runtime code.
4. Update shared contracts when externally visible behavior changes.
5. Add focused tests for the behavior or failure mode being changed.
6. Keep the generic runtime independent of a particular corpus, organization, course or workstation.
7. Do not commit `.env`, credentials, backups, raw licensed/private sources, generated local reports or temporary managed repositories.
8. Do not publish canonical knowledge by writing directly to the managed Git repository; use the proposal/review flow.

## Local checks

Before opening or updating a pull request, run the relevant focused tests and the repository gates:

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

Extractor changes additionally require the locked Python environment, Ruff, mypy and pytest. Persistence, publication and recovery changes should be exercised against disposable infrastructure and include restore evidence when applicable.

## Documentation and reports

Current behavior belongs in `README.md`, `ARCHITECTURE.md`, `docs/status.md`, the security documentation and runbooks. Release history belongs in `CHANGELOG.md`; concise release evidence may live under `docs/assurance/releases/`.

Runtime-generated import reports, diagnostics and temporary validation output must stay in ignored report directories or CI artifacts. Reproducible benchmark datasets and machine-readable benchmark results may be versioned under `evals/` or `reports/` when they are part of the supported evaluation workflow.

## Commits

Use commit messages that describe the product behavior or repository change. Avoid internal iteration numbers, agent-session labels and conversational checkpoints.
