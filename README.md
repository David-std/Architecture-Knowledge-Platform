# Architecture Knowledge Platform

Architecture Knowledge Platform (AKP) is a local-first, domain-agnostic system
for turning registered knowledge vaults and immutable source material into
reviewed Markdown/Git knowledge plus rebuildable retrieval projections. Humans
can keep approved knowledge readable in ordinary files; agents consume bounded,
authorized context through API, MCP, CLI and Web surfaces.

The repository is an active product-completion candidate, not a claim of
internet-scale or unattended production readiness. The concise executed state
lives in [docs/status.md](docs/status.md); historical assurance material is
preserved under [docs/assurance/](docs/assurance/).

## Capabilities

- Registers and imports arbitrary vaults read-only without making one corpus a
  product invariant.
- Stores submitted source bytes immutably by SHA-256 and retains provenance and
  evidence locators through extraction and compilation.
- Retrieves authorized knowledge through exact, lexical, semantic-vector and
  typed multi-hop graph channels, with deterministic planning/fallbacks and
  revision-aware projections.
- Builds bounded ContextPackets with citations, token budgets, conflicts, gaps,
  continuations and explicit no-answer behavior.
- Compiles evidence into grounded candidate knowledge changes against existing
  approved knowledge; generated output remains untrusted and cannot publish.
- Uses isolated Git drafts, deterministic validation, human review,
  publication/rollback events and rebuildable lexical/vector/graph/context
  projections.
- Supports provider-neutral document intelligence. Deterministic parsing remains
  available; structured/OCR providers are optional and explicit.
- Exposes operator workflows for search, graph, sources, jobs, reviews, evals
  and health without requiring raw JSON as the primary interface.
- Emits traces and metrics through OpenTelemetry when configured and includes
  reproducible backup/restore plus managed-Git recovery checks.

## Runtime model

```text
registered vault or immutable source
        |
        v
structured extraction + evidence
        |
        v
grounded candidate compilation
        |
        v
Git draft -> validation -> human review
        |
        v
publication / rollback events
        |
        v
exact + lexical + semantic + graph projections
        |
        v
bounded ContextPacket
        |
        +-- API
        +-- CLI
        +-- MCP
        +-- Web
```

Canonical approved knowledge remains Markdown/Git. PostgreSQL, pgvector, graph
relations, ContextPackets and other indexes are operational or derived state and
must remain rebuildable.

## Prerequisites

- Node.js 24 LTS (`>=24 <25`).
- pnpm 10.34.5.
- Python 3.12 for extractor development and tests.
- Docker with Compose v2 for PostgreSQL, MinIO and extractor services.

## Quick start

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile --strict-peer-dependencies
docker compose up -d --build --wait postgres minio extractor
pnpm db:migrate

$env:AKP_API_TOKEN = '<private-random-token>'
$env:AKP_API_TOKEN_SCOPES = '{"spaces":[{"spaceId":"00000000-0000-0000-0000-000000000003","pathPrefix":null,"permissions":["knowledge:read","source:read"]}]}'
pnpm auth:provision

pnpm --filter @akp/api dev
pnpm --filter @akp/worker dev
pnpm --filter @akp/web dev
```

Local defaults bind development services to loopback. Review `.env.example`
before changing endpoints or provider configuration.

## Import a vault

Use a path supplied by the operator; the repository does not assume a personal
vault name or workstation layout.

```powershell
$env:AKP_VAULT_PATH = 'D:\Knowledge\my-vault'

pnpm akp vault import `
  --vault-path $env:AKP_VAULT_PATH `
  --read-only `
  --report-dir reports\migration

pnpm akp vault status `
  --vault-path $env:AKP_VAULT_PATH
```

Equivalent conceptual input on any platform is `<path-to-your-vault>`. Import
is read-only; runtime jobs, raw objects, embeddings and index state do not
belong inside the imported corpus.

## Agent and operator interfaces

```powershell
$env:AKP_API_URL = 'http://127.0.0.1:8080'
$env:AKP_API_TOKEN = '<provisioned-token>'

pnpm akp search 'exact identifier or knowledge question'
pnpm akp context 'question that needs evidence and policy context'
pnpm akp eval run
pnpm --filter @akp/mcp start
pnpm --filter @akp/mcp start:http
```

For Web usage, open `/login`, exchange a scoped bearer token and continue with
the session cookie/CSRF boundary. Search, graph, source, job, review, eval and
health views are operator-facing; raw JSON remains inspection detail.

To read an imported vault in Obsidian, choose **Open folder as vault** and select
the same operator-provided `<path-to-your-vault>`. Do not open this runtime
repository as the knowledge vault.

## Validation

Core repository gates:

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

Extractor gates use the checked-in lock:

```powershell
Push-Location apps/extractor
uv sync --locked
uv run --locked ruff check --no-cache .
uv run --locked mypy app
uv run --locked pytest -p no:cacheprovider
Pop-Location
```

Broad comparative benchmarks belong to the final validation phase and must not
be confused with ordinary CI mechanics.

## Documentation

- [Current executed status](docs/status.md)
- [Architecture](ARCHITECTURE.md)
- [C4 model](docs/architecture/c4.md)
- [Runtime flows](docs/architecture/runtime-flows.md)
- [Threat model](docs/security/threat-model.md)
- [Local operations](docs/runbooks/local-operations.md)
- [Contributing](CONTRIBUTING.md)
- [Assurance history](docs/assurance/README.md)
