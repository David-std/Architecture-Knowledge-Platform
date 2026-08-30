# Architecture Knowledge Platform

Local-first executable platform around the Architecture Knowledge Vault. The
approved knowledge remains readable Markdown; PostgreSQL, pgvector, the typed
graph and ContextPackets are derived projections. Obsidian is the human reader
for the external vault. Agents use bounded API, MCP or CLI operations instead
of traversing every file.

This repository is the validated local baseline identified by
`v0.2.1-platform-validation`, not a claim of production readiness. Exact
validation state is recorded in
[PROJECT_STATE.md](PROJECT_STATE.md),
[VALIDATION_REPORT.md](VALIDATION_REPORT.md) and
[REMAINING_REAL_GAPS.md](REMAINING_REAL_GAPS.md).

## What the platform does

- Imports `C:\Users\david\Documents\Architecture-Knowledge-System` read-only,
  preserving IDs, aliases, frontmatter, wikilinks and source/evidence trails.
- Separates useful agent knowledge from copied transfer logistics. Curated
  `LINK.md` recovery maps remain searchable; acquisition/download backlogs are
  archived and excluded from normal retrieval.
- Compiles each imported snapshot into current documents, hierarchical
  retrieval units and typed relations. Runtime verification treats corpus
  sizes as observations; it never turns one vault's historical counts into a
  product invariant.
- Plans each query, retrieves through exact, lexical, graph, context-pack,
  raw-source and code-evidence channels, then applies RBAC, lifecycle, trust,
  freshness and contradiction policy.
- Returns a bounded `ContextPacket` with revision, citations, selection reasons,
  gaps, conflicts and continuation handles.
- Accepts raw sources into immutable SHA-256 MinIO keys, processes durable
  Postgres jobs and sends the verified object to the Python extractor through
  authenticated multipart upload with a second SHA-256 check.
- Extracts Markdown/text, PDF, captured HTML, image metadata, DOCX and PPTX with
  locators. OCR/vision, audio transcription and video understanding report
  `CAPABILITY_NOT_CONFIGURED`; no result is fabricated.
- Produces an isolated Git draft, deterministic validation and a human review.
  Approved changes are squash-merged under a publication lock and reindexed;
  rejected changes remain isolated and published changes can be rolled back.
- Exposes the same use cases through Fastify HTTP, 21 MCP tools over stdio or
  Streamable HTTP, a CLI and a Next.js operational UI.
- Tracks staleness, contradiction clusters, schema dry runs, deterministic
  knowledge lint, audit events and an Error Book that can create regression
  eval cases.

## What happens when you use it

```text
Vault or source
  -> read-only import or immutable SHA-256 storage
  -> hierarchical units + lexical/graph projections
  -> permission and knowledge-state policy
  -> bounded ContextPacket for API/MCP/CLI/Web

New material
  -> durable ingest job
  -> authenticated extractor
  -> compilation plan
  -> isolated Git draft
  -> human review
  -> merge + reindex, or rejection/rollback
```

For a knowledge question, search first and request a ContextPacket when the
answer needs rules, workflow, evidence and provenance together. For new source
material, submit it through `/ingest` or the CLI, follow its job, and approve
only the generated review after inspecting the diff and evidence. The original
Obsidian vault is never the runtime job store and is not modified by import.

## Quick start on Windows

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile --strict-peer-dependencies
docker compose up -d --build --wait postgres minio extractor
pnpm db:migrate

# Use a private random value of at least 24 characters; never commit it.
$env:AKP_API_TOKEN = '<private-random-token>'
# Persist explicit, least-privilege scope(s); `pathPrefix` can be null only
# when the token genuinely needs the whole space.
$env:AKP_API_TOKEN_SCOPES = '{"spaces":[{"spaceId":"00000000-0000-0000-0000-000000000003","pathPrefix":null,"permissions":["knowledge:read","source:read"]}]}'
pnpm auth:provision

pnpm --filter @akp/api dev
pnpm --filter @akp/worker dev
pnpm --filter @akp/web dev
```

Local defaults bind PostgreSQL, MinIO, the extractor and API to loopback. The
default infrastructure ports are `55432`, `19000`, `19001` and `8090`.

## Import the existing vault

```powershell
pnpm akp vault import `
  --vault-path C:\Users\david\Documents\Architecture-Knowledge-System `
  --read-only `
  --report-dir reports\migration
pnpm akp vault status `
  --vault-path C:\Users\david\Documents\Architecture-Knowledge-System
```

The latest recorded import processed 548 Markdown files with zero import
errors and 106 explicit warnings. One hundred unresolved wikilinks remain
warnings; the importer does not invent targets.

## Use the agent interfaces

```powershell
$env:AKP_API_URL = 'http://127.0.0.1:8080'
$env:AKP_API_TOKEN = '<provisioned-token>'

pnpm akp search 'hexagonal architecture boundary'
pnpm akp context 'choose architecture for volatile integrations'
pnpm akp eval run
pnpm akp benchmark retrieval
pnpm akp benchmark packet 'compare Clean and Hexagonal' --runs 3
pnpm akp schema dry-run --version 1.1 --require id type status
pnpm akp lint run --trigger MANUAL
```

Start either MCP transport with the same scoped token:

```powershell
pnpm --filter @akp/mcp start
pnpm --filter @akp/mcp start:http
```

The 19-case synthetic runner and 13-case curated fixture runner both leave
`productionDefault` as `null`. Vectors remain benchmark-only; query planning is
intent-specific until a held-out production-like evaluation and explicit
policy change justify a default.

## Use the Web UI

Open `/login`, exchange a scoped bearer token once, and continue with the
opaque HttpOnly session cookie. Session-authenticated writes require the paired
CSRF token. The UI covers dashboard, search/ContextPacket inspection, source
and derivative inspection, ingest/jobs, reviews, knowledge documents, graph,
evals, spaces, health, audit and session login. The current Web smoke exercises `/`, `/login` and `/reviews`; production build enumerates the implemented routes.

## Open the human vault in Obsidian

1. Open Obsidian.
2. Choose **Open folder as vault**.
3. Select `C:\Users\david\Documents\Architecture-Knowledge-System`.
4. Open `README.md` and follow its context-pack routes.

Do not open this runtime repository as the knowledge vault. Jobs, raw objects,
embeddings and index state intentionally stay outside the Obsidian corpus.

## Validation and operations

```powershell
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm audit --audit-level high
pnpm security:secrets
pnpm contracts:validate
pnpm docs:validate
pnpm format:check
pnpm check
pnpm build
pnpm test:integration
pnpm verify:runtime
pnpm test:mcp
pnpm benchmark:retrieval:offline
pnpm benchmark:retrieval:curated
pnpm benchmark:scale -- --targets 1000,10000,50000,100000 --iterations 3
```

See [the local operations runbook](docs/runbooks/local-operations.md),
[the OpenAPI contract](contracts/openapi.yaml),
[the MCP catalog](contracts/mcp-tools.json),
[the runtime flows](docs/architecture/runtime-flows.md) and
[the C4 model](docs/architecture/c4.md).
