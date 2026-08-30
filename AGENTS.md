# Agent operating contract

## Scope

This repository is the executable platform. The external vault at `C:\Users\david\Documents\Architecture-Knowledge-System` is an imported, read-only corpus unless a user explicitly authorizes a separate reviewed vault change. Never place runtime caches, embeddings, job state, secrets or licensed originals into that vault.

## Progressive loading

1. Read `README.md`, `PROJECT_STATE.md` and `REMAINING_REAL_GAPS.md`.
2. For implementation, inspect the relevant package and its contract only.
3. For knowledge answers, use API/MCP `akp_search` or `akp_build_context`; do not traverse the whole vault.
4. Treat `Resources/transfer-packs/**` as archived provenance, not current guidance. Curated recovery maps are explicitly typed and promoted by the importer.
5. Preserve `Source → Evidence → Claim → Rule → Workflow/Profile/Context pack → Eval` dependency direction. Unknown evidence stays unknown.

Root-level audit, benchmark and validation reports are on-demand evidence, not
startup context. Load the specific report only when a task cites its claim or
needs to reproduce its command; do not traverse every report by default.

## Invariants

- Markdown/Git is canonical for approved compiled knowledge; derived indexes are rebuildable.
- A write goes through isolated draft, deterministic validation, review and publication lock.
- A raw source is content-addressed by SHA-256 and extraction reads the immutable object.
- Every query is space-scoped; every write also enforces the membership path prefix.
- `UNVERIFIED`, `DISPUTED`, `STALE_PENDING_REVIEW`, `STALE_BLOCKED`, `ARCHIVED` and `INVALID` are meaningful states, not cosmetic labels.
- Do not promote copied acquisition instructions, unfinished task lists or transfer manifests into agent-facing knowledge.
- Do not enable vectors or reranking by default without a benchmark that improves eligible quality metrics.
- Never use known/default credentials outside disposable tests.

## Commands before handoff

```powershell
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm audit --audit-level high
pnpm security:secrets
pnpm contracts:validate
pnpm docs:validate
pnpm format:check
pnpm hygiene:validate
pnpm check
pnpm build
pnpm test:integration
pnpm verify:runtime
pnpm test:mcp
pnpm benchmark:retrieval:offline
pnpm benchmark:retrieval:curated
pnpm benchmark:scale -- --targets 1000,10000,50000,100000 --iterations 3

Push-Location apps/extractor
python -m ruff check --no-cache .
python -m mypy app
python -m pytest -p no:cacheprovider
Pop-Location

docker compose config
& .\scripts\backup.ps1 -OutputDirectory backups\release-candidate
& .\scripts\restore-smoke.ps1 -BackupDirectory backups\release-candidate
```

Do not crawl or revalidate the external vault during ordinary platform work.
Run its own validators read-only only when a task explicitly changes the import
profile, importer compatibility, or a claim derived from that vault. Platform
bootstrap, fixtures and release gates must remain valid without it.

## Change discipline

- Add migrations; never edit an applied migration. Checksums are enforced.
- Add tests for deterministic domain, security, retrieval, publication and recovery behavior.
- Update contracts and state reports with runtime changes.
- Capability reports use only: `IMPLEMENTED_AND_EXECUTED`, `IMPLEMENTED_NOT_EXECUTED`, `CONTRACT_ONLY`, `PARTIALLY_IMPLEMENTED`, `DEFERRED`, `BLOCKED`, `FAILED`, `UNKNOWN`.
- Competitive claims use only: `WORSE_THAN_REFERENCE`, `ROUGHLY_COMPARABLE`, `BETTER_WITH_EVIDENCE`, `UNKNOWN_NOT_REPRODUCED`.
