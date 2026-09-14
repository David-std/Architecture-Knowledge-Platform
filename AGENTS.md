# AGENTS.md

This file is the operational guide for coding agents and automated contributors working in Architecture Knowledge Platform.

## Product model

AKP is a local-first, multi-vault knowledge platform. Approved Markdown in the managed Git repository is canonical. PostgreSQL, vector/lexical indexes, graph relations, context packets and operational records are projections or workflow state. Imported vaults and raw evidence are read-only inputs.

Keep these boundaries intact:

- Never write directly to an imported vault.
- Never bypass proposal, validation, review and publication for canonical knowledge changes.
- Treat provider and source content as untrusted input.
- Enforce vault, space and path scope at every retrieval hop and evidence boundary.
- Keep secrets, private source bytes, local paths and provider credentials out of committed artifacts.
- Prefer deterministic application/runtime controls over prompt-only rules.

## Repository map

- `apps/api` — authenticated HTTP use cases and policy enforcement.
- `apps/worker` — durable ingestion, compilation, indexing and event consumers.
- `apps/extractor` — provider-neutral extraction service.
- `apps/web` — operator console.
- `apps/cli` — command-line client and operational workflows.
- `apps/mcp` — MCP client surface over the same application rules.
- `packages/*` — reusable domain, persistence, retrieval, indexing and publication modules.
- `contracts/` — OpenAPI, AsyncAPI and shared contract artifacts.
- `db/` — append-only migrations.
- `evals/` — corpus-agnostic evaluation packs and explicit fixtures.
- `docs/` — architecture, guides, runbooks, security and release evidence.
- `reports/` — reproducible machine-generated benchmark output; transient reports belong in ignored report directories or CI artifacts.
- `scripts/` — build, validation, benchmark and recovery automation.

## Source-of-truth documentation

Read these before broad changes:

1. `README.md`
2. `ARCHITECTURE.md`
3. `docs/status.md`
4. `docs/security/threat-model.md`
5. `docs/runbooks/local-operations.md`
6. `CONTRIBUTING.md`

Release-specific evidence may live under `docs/assurance/releases/`, but it is not a substitute for current product documentation.

## Branches and commits

Use short-lived branches with lowercase kebab-case names and a purpose prefix:

- `feat/<topic>` for features
- `fix/<topic>` for defects
- `docs/<topic>` for documentation-only work
- `test/<topic>` for test-only work
- `chore/<topic>` for maintenance

Do not create scratch, no-op or evidence-only remote branches. Keep temporary experiments local or under ignored `.work/`, `.tmp/` or `.cache/` directories. Delete short-lived branches after their change is merged or abandoned.

Commit messages should describe the product behavior or repository change, not an internal iteration number, agent session or conversational checkpoint.

## Change rules

- Add migrations; never rewrite an applied migration.
- Keep business rules in application/domain code, not only in UI, MCP descriptions or prompts.
- Update OpenAPI, AsyncAPI and MCP contracts together when a shared contract changes.
- Add focused tests proportional to the risk of the changed behavior.
- Do not enable optional retrieval, extraction or model providers by default without reproducible evidence and an explicit configuration decision.
- Keep the generic runtime independent of a specific vault, course, company, developer workstation or fixture corpus.
- Do not commit generated local reports, backups, `.env`, temporary repositories or private raw evidence.

## Focused checks

Run the narrowest relevant tests while developing, then run the full gate before declaring a change complete.

```powershell
pnpm format:check
pnpm contracts:validate
pnpm docs:validate
pnpm hygiene:validate
pnpm check
pnpm build
```

For extractor changes:

```powershell
Push-Location apps/extractor
uv sync --locked
uv run --locked ruff check --no-cache .
uv run --locked mypy app
uv run --locked pytest -p no:cacheprovider
Pop-Location
```

For runtime, persistence, publication or recovery changes, also run the relevant integration suite with fresh disposable infrastructure and exercise backup/restore when the change can affect recovery.

## Full release gate

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
pnpm verify:runtime
pnpm test:mcp
```

A capability is not considered proven solely because code exists. Use executable tests and clean-checkout CI for claims that depend on runtime behavior.
