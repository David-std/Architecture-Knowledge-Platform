# Architecture Knowledge Platform

Architecture Knowledge Platform (AKP) is a local-first, multi-vault knowledge runtime for ingesting evidence, building scoped retrieval indexes and turning grounded evidence into governed knowledge changes. Git remains the canonical representation of approved knowledge; PostgreSQL stores durable operational state and derived indexes; object storage retains raw source evidence.

The platform is designed to remain domain-agnostic. Vault-specific schemas, evaluation packs and source material are configuration/data rather than assumptions in the core runtime.

## What this checkpoint supports

- durable ingest jobs, leases, retries, fencing, quarantine and causal event delivery;
- exact and weighted lexical retrieval over documents and structural units;
- provider-neutral semantic embeddings with an opt-in local multilingual provider and deterministic test adapter;
- typed, scoped, bounded multi-hop graph retrieval with path provenance;
- capability-aware query planning, reciprocal-rank fusion and explainable retrieval provenance;
- full and compact ContextPacket representations with explicit token budgets, gaps, conflicts and no-answer behavior;
- grounded knowledge compilation into reviewable proposals rather than direct autonomous publication;
- multi-vault and path-scoped authorization boundaries across retrieval and governance paths;
- document extraction through the local extractor service, including native-structure and OCR verification paths;
- CLI, API and MCP surfaces for the supported local workflow.

See [docs/status.md](docs/status.md) for the maintained operational status and [ARCHITECTURE.md](ARCHITECTURE.md) for the architecture overview.

## Prerequisites

- Node.js 24.x
- pnpm 10.34.5
- Python 3.12
- uv 0.12.7
- Docker with Compose
- Git

## Bootstrap

```bash
cp .env.example .env
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm db:migrate
pnpm auth:provision
```

For the extractor environment:

```bash
cd apps/extractor
uv sync --locked
cd ../..
```

Start the disposable local dependencies with:

```bash
docker compose up -d --wait postgres minio extractor
```

Set `AKP_VAULT_PATH` and any source/project roots to paths supplied by the operator. The example configuration intentionally does not assume a particular workstation, repository or private corpus.

## Register or import a vault

A vault is external product data. Supply its location explicitly rather than copying a repository-specific default:

```bash
pnpm akp vault import \
  --vault-path "<vault-path>" \
  --space-id "<space-id>" \
  --read-only
```

Keep authentication scopes and optional path prefixes as narrow as the integration requires. A registered vault may provide its own schema profile, evaluation pack and retrieval configuration without changing core runtime code.

## Retrieval behavior

AKP combines only channels that are both requested by the planner and available for the current vault/revision. Exact/lexical retrieval is available without a semantic model. Vector retrieval is opt-in and requires a configured embedding provider plus a consistent active generation. Graph traversal is typed, bounded and scope-checked at every hop.

Context packaging retains provenance, selection reasons, structural context and continuation metadata. Compact output is intended for constrained agent surfaces; full output preserves the richer review/debug representation.

## Knowledge changes

Compilation produces a grounded proposal against existing approved knowledge. Provider output is untrusted input: proposed targets, evidence, paths and review state must satisfy runtime validation and authorization before a proposal can enter the governed review flow. Publication is not delegated directly to a language model.

## Verification

Run the maintained local gates before publishing a change:

```bash
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm audit --audit-level high
pnpm format:check
pnpm check
pnpm contracts:validate
pnpm docs:validate
pnpm hygiene:validate
pnpm build
pnpm security:secrets
```

Integration tests additionally require the disposable PostgreSQL, MinIO and extractor services. GitHub Actions is the clean-checkout source of truth for release claims; green unit tests alone are not treated as proof of the complete runtime path.

## Repository layout

```text
apps/        executable API, worker, CLI, MCP, web and extractor surfaces
packages/    reusable domain, persistence, retrieval, indexing and compiler packages
contracts/   versioned API, event, schema and MCP contracts
db/          append-only database migrations
docs/        maintained architecture, security, runbook and release documentation
evals/       corpus-agnostic evaluation packs and portable fixtures
ops/         local operational configuration
policies/    machine-readable product policies
scripts/     build, validation, backup and operational tooling
test/        generic integration fixtures
```

Generated diagnostics belong under ignored report directories or CI artifacts, not in the repository root. Construction transcripts and superseded validation reports remain available through Git history instead of being maintained as product documentation.

## Security and deployment scope

The maintained target is a reproducible local deployment with explicit authorization boundaries. It is not presented as an HA cluster, hostile-internet edge service or unlimited-scale retrieval system. Keep secrets out of the repository, use operator-provided credentials and review deployment assumptions before exposing any service beyond the intended local environment.

## Contributing

Read [AGENTS.md](AGENTS.md) for repository invariants and [CONTRIBUTING.md](CONTRIBUTING.md) for branch, test and documentation expectations.
