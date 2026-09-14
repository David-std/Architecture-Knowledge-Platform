# Local operations runbook

## Start infrastructure

```powershell
Copy-Item .env.example .env
pnpm install --frozen-lockfile --strict-peer-dependencies
docker compose up -d --build --wait postgres minio extractor
pnpm db:migrate
pnpm verify:runtime
docker compose ps
```

Set private values for `AKP_API_TOKEN`, `AKP_API_TOKEN_SCOPES`,
`AKP_EXTRACTOR_TOKEN`, MinIO credentials and managed-repository paths. Do not
reuse example placeholders or commit `.env`. Start API, worker and Web in
separate terminals:

```powershell
pnpm --filter @akp/api dev
pnpm --filter @akp/worker dev
pnpm --filter @akp/web dev
```

`/health/liveness` confirms the API process. `/health/readiness` checks required
runtime dependencies. Development infrastructure binds to loopback by default.

## Provision scoped credentials

```powershell
$env:AKP_API_TOKEN = '<private-random-token-at-least-24-characters>'
$env:AKP_API_TOKEN_SCOPES = '{"spaces":[{"spaceId":"00000000-0000-0000-0000-000000000003","pathPrefix":null,"permissions":["knowledge:read","source:read"]}]}'
pnpm auth:provision
```

`AKP_API_TOKEN_SCOPES` must contain explicit space entries. A `pathPrefix` may
be `null` only when the token genuinely needs whole-space access. Evaluation,
administration and rebuild operations that aggregate a full space require a
whole-space grant; do not give `admin` to a path-scoped token.

MCP, CLI and automation use the bearer token. The Web UI exchanges it at
`/login` for an opaque HttpOnly session and paired CSRF boundary. Current
membership and path scope are re-evaluated rather than trusting a stale client
snapshot.

## Import and inspect a vault

The operator supplies the vault path. No personal corpus or workstation path is
a platform default.

```powershell
$env:AKP_VAULT_PATH = 'D:\Knowledge\my-vault'

pnpm akp vault import `
  --vault-path $env:AKP_VAULT_PATH `
  --read-only `
  --report-dir reports\migration

pnpm akp vault status `
  --vault-path $env:AKP_VAULT_PATH
```

On other platforms use the equivalent `<path-to-your-vault>`. Import is
read-only. Treat import counts and warnings as observations about that corpus,
not product invariants, and never invent targets for unresolved links.

## Submit and monitor a source

Submitted paths must be under an `AKP_INGEST_ROOTS` entry. The API creates a
durable job; raw bytes are stored content-addressed and extraction verifies the
immutable source hash before derived work continues.

Use `GET /v1/ingest/:id` or the `/jobs/:id` operator page to inspect state,
attempts, retry/lease data, provider correlation and failures. Retry or cancel
through supported APIs rather than editing job tables directly.

Inspect extractor/provider capability truth at runtime:

```powershell
Invoke-RestMethod http://127.0.0.1:8090/v1/capabilities
```

Provider availability is configuration-dependent. Deterministic parsing remains
a fallback; optional structured/OCR/multimedia providers must report explicit
availability or degradation rather than fabricated results.

## Search and build bounded context

```powershell
$env:AKP_API_URL = 'http://127.0.0.1:8080'
pnpm akp search 'exact identifier or knowledge question'
pnpm akp context 'question that needs evidence and policy context'
```

Inspect requested/effective channels, degradation warnings, packet revision,
selection reasons, citations, conflicts and gaps. Follow continuation handles
rather than loading an entire vault. A missing semantic/optional provider should
degrade explicitly while permitted deterministic channels continue.

## Rebuild derived projections

```powershell
$spaceId = '00000000-0000-0000-0000-000000000003'
$headers = @{
  Authorization = "Bearer $env:AKP_API_TOKEN"
  'Idempotency-Key' = "runbook-reindex-$([guid]::NewGuid())"
}
$body = @{
  spaceId = $spaceId
  confirm = 'REBUILD_DERIVED_PROJECTIONS'
  reimportVault = $false
} | ConvertTo-Json
Invoke-RestMethod -Method Post -ContentType application/json -Body $body `
  -Headers $headers -Uri "$env:AKP_API_URL/v1/reindex"
```

Use an admin token with `pathPrefix: null` for the target space. Rebuild is an
explicit repair operation; normal publication and rollback use durable
incremental projection events. Inspect revision parity through the index/health
surfaces after completion.

## Review and publication recovery

Generated/provider output is candidate material only. Inspect evidence,
compilation candidates, contradictions, probes and diff before approval. Direct
model publication is forbidden.

If publication is interrupted between Git and PostgreSQL, use the supported
review reconciliation operation. Do not manually guess or rewrite an ambiguous
main revision. Recovery is idempotent and fails closed when attribution is not
safe.

## Schema, lint, Error Book and audit

```powershell
pnpm akp schema dry-run --version 1.1 --require id type status
pnpm akp lint run --trigger MANUAL
```

Schema dry-run is read-only. Error Book entries can become regression evals;
audit views remain scope-controlled. Resolve recurring failures only after
verification evidence exists.

## Backup and managed-Git restore

```powershell
$env:AKP_MANAGED_REPO = 'D:\AKP\managed-knowledge'
& .\scripts\backup.ps1 -OutputDirectory backups\release-candidate
& .\scripts\restore-smoke.ps1 -BackupDirectory backups\release-candidate
& .\scripts\verify-managed-git-restore.ps1 `
  -BackupDirectory backups\release-candidate `
  -SourceManagedRepository $env:AKP_MANAGED_REPO `
  -SpaceId 00000000-0000-0000-0000-000000000003
```

The backup set contains PostgreSQL, MinIO data and a managed Git bundle when
configured, plus non-secret metadata. Restore verification uses isolated
resources, checks the bundle in a newly cloned repository, verifies its expected
main commit/files and proves that searchable derived state can be rebuilt.

## Open an imported vault in Obsidian

Choose **Open folder as vault** and select the same operator-provided
`<path-to-your-vault>`. Platform import remains read-only. Do not copy runtime
indexes, jobs, secrets or raw object storage into that folder.

## Repository gate before handoff

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

Push-Location apps/extractor
uv sync --locked
uv run --locked ruff check --no-cache .
uv run --locked mypy app
uv run --locked pytest -p no:cacheprovider
Pop-Location

docker compose config --quiet
git diff --check
```

Broad retrieval/document/agent/load comparisons are final validation evidence,
not a reason to weaken focused correctness gates.
