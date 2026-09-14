# Agent operating contract

## Scope and sources of truth

This repository is the executable platform. Registered vaults are external,
operator-supplied, read-only import sources unless a separate reviewed workflow
explicitly authorizes a knowledge change. Never place runtime caches,
embeddings, job state, secrets or licensed originals into an imported vault.

Start with:

1. `README.md` for product/runtime usage.
2. `docs/status.md` for the concise executed state.
3. `ARCHITECTURE.md` plus the relevant package/contract for implementation.
4. `CONTRIBUTING.md` for change and branch discipline.
5. `docs/assurance/` only when historical evidence is explicitly needed.

Historical assurance snapshots are not active instructions. Do not infer current
behavior from an archived report when current code/tests/status disagree.

## Architecture boundaries

- `apps/api` owns authenticated HTTP use cases and policy enforcement.
- `apps/worker` owns durable ingest/event execution, leases, retries and
  reconciliation.
- `apps/extractor` implements provider-neutral document intelligence.
- `apps/cli`, `apps/mcp` and `apps/web` are bounded clients of shared rules.
- `packages/*` contains reusable domain, storage, retrieval, indexing,
  compilation, publication and observability code.
- `contracts/` is the versioned interface source; `db/migrations/` is append-only.
- Approved Markdown/Git knowledge is canonical. Derived indexes are rebuildable.

Preserve the dependency direction:

```text
Source -> Evidence -> Candidate knowledge -> Review -> Approved knowledge
       -> Derived projections -> ContextPacket/Eval
```

Unknown or contradictory evidence remains explicit.

## Security and publication invariants

- Resolve authorization before retrieval or mutation; preserve space/vault/path
  scope through exact, lexical, vector, graph, raw and compiler paths.
- Provider/model output is untrusted input. It cannot grant tools, permissions,
  trust or publication authority.
- No model or client publishes directly. Writes go through isolated Git draft,
  deterministic validation, human review and the publication lock/lifecycle.
- Rollback is a publication event, not an ad-hoc projection mutation.
- Raw source bytes are content-addressed; extraction must verify immutable input.
- Never use known/default credentials outside disposable tests.
- Do not hard-code one corpus, course, project, workstation path or private
  identifier into generic runtime behavior.

## Focused work

Before editing, inspect the existing implementation and nearest focused tests.
For a correctness gap use:

```text
reproduce -> strengthen focused test -> implement -> run focused test
          -> run impacted integration gate
```

Do not replace a failing invariant with looser assertions, sleeps or mocks that
avoid the real boundary.

## Canonical gates

For normal TypeScript/product changes:

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

For extractor changes:

```powershell
Push-Location apps/extractor
uv sync --locked
uv run --locked ruff check --no-cache .
uv run --locked mypy app
uv run --locked pytest -p no:cacheprovider
Pop-Location
```

For recovery-sensitive changes also execute the backup/restore and managed-Git
recovery gates used by CI. Broad retrieval/document/agent/load comparisons are
P10 evidence, not a substitute for focused correctness tests.

## Repository and branch discipline

- Keep the root product-facing. New assurance material belongs under `docs/` or
  generated `reports/`, not as root progress files.
- Do not create `GOAL_*`, `*_PROGRESS`, worklog, scratch or handoff documents in
  the tracked product tree.
- Keep `main`, active PR heads and explicitly referenced baselines. Delete
  temporary evidence/test/no-op branches once their useful commits are merged
  or otherwise preserved.
- A branch name is not evidence that work is current; check its PR and ancestry.
- Add migrations; never rewrite an applied migration.
- Update contracts and current status only with behavior actually executed.
