# Architecture Knowledge Platform

Architecture Knowledge Platform (AKP) is a local-first system for turning heterogeneous technical sources into reviewed, traceable knowledge. Approved Markdown in Git is canonical; PostgreSQL, lexical/vector search, graph relations, context packets and operational state are derived or rebuildable projections.

## What the platform provides

- Read-only import of one or more registered knowledge vaults.
- Durable ingestion of immutable source material with provider-neutral extraction.
- Lexical, semantic and graph retrieval with vault and path isolation.
- Grounded context packets with citations, conflicts and gaps.
- Proposal, review, validation, publication and rollback workflows backed by Git.
- Evaluation packs, retrieval benchmarks and regression tracking.
- Operator surfaces through Web, API, CLI and MCP.
- Audit export, observability, backup and isolated restore tooling.

## Requirements

- Node.js 24 LTS (`>=24 <25`)
- pnpm 10.34.5
- Python 3.12 for the extractor
- Docker with Compose

## Quick start

```powershell
Copy-Item .env.example .env
docker compose up -d --build --wait postgres minio extractor
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm db:migrate
pnpm verify:runtime
```

Start the API, worker and Web application in separate terminals:

```powershell
pnpm --filter @akp/api dev
pnpm --filter @akp/worker dev
pnpm --filter @akp/web dev
```

Local services bind to loopback by default. Configure credentials, allowed source roots and optional providers in `.env`; do not commit private values.

## Import a vault

Vaults are registered explicitly and imported read-only. Use any local path appropriate to the installation:

```powershell
pnpm akp vault import `
  --vault-path <path-to-your-vault> `
  --space-id <authorized-space-uuid> `
  --read-only
```

Import reports are runtime artifacts and are written under `reports/migration/` unless another report directory is selected.

## Quality gates

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

Extractor changes also require Ruff, mypy and pytest under Python 3.12. Runtime and recovery changes should additionally exercise migrations, API/MCP/Web smoke checks and backup/restore.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Current capabilities and limits](docs/status.md)
- [Local operations](docs/runbooks/local-operations.md)
- [Threat model](docs/security/threat-model.md)
- [Contributing](CONTRIBUTING.md)
- [Release history](CHANGELOG.md)

## Design boundary

Imported vaults and raw sources are inputs, not product configuration. The platform does not assume a particular course, organization, repository layout or personal workstation. Source-specific conventions belong in explicit import profiles or evaluation fixtures, never in the generic runtime core.
