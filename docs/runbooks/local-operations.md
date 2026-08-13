# Local operations runbook

## Start infrastructure and verify dependencies

```powershell
Copy-Item .env.example .env
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

`/health/liveness` confirms the API process. `/health/readiness` checks
PostgreSQL, MinIO and the extractor. Local infrastructure binds to loopback by
default.

## Provision automation credentials and use a browser session

```powershell
$env:AKP_API_TOKEN = '<private-random-token-at-least-24-characters>'
$env:AKP_API_TOKEN_SCOPES = '{"spaces":[{"spaceId":"00000000-0000-0000-0000-000000000003","pathPrefix":null,"permissions":["knowledge:read","source:read"]}]}'
pnpm auth:provision
```

`AKP_API_TOKEN_SCOPES` is required and must contain at least one explicit
`spaces` entry. Each entry has a UUID `spaceId`, an explicit `pathPrefix`
(`null` means the whole space; a relative path such as `shared` limits access),
and one or more supported permissions. Re-run `pnpm auth:provision` after
changing the scope profile; provisioning replaces the token's persisted scope
snapshot.

Use a least-privilege profile appropriate to the operation:

| Profile | `pathPrefix`              | Permissions                                                                                                   | Typical use                               |
| ------- | ------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| read    | a relative path or `null` | `knowledge:read`, `source:read`                                                                               | Search, context and source inspection     |
| eval    | `null`                    | read permissions plus `eval:run`                                                                              | Evaluation, benchmark and lint operations |
| admin   | `null`                    | `knowledge:read`, `source:read`, `source:write`, `knowledge:propose`, `knowledge:review`, `eval:run`, `admin` | Schema governance, audit and reindex      |

Evaluation and administration routes that aggregate or rebuild a space require
whole-space access (`pathPrefix: null`). Do not grant `admin` to a path-scoped
token.

For MCP, CLI and automation, send the bearer token in `Authorization`. For the
Web UI, open `/login` and exchange it for an opaque HttpOnly session. The API
stores session/CSRF hashes plus the effective scope snapshot and intersects that
snapshot with current memberships on every request. Session writes require
`X-CSRF-Token`. Revoke with `POST /v1/auth/session/revoke`.

## Import and inspect the external vault

```powershell
pnpm akp vault import `
  --vault-path C:\Users\david\Documents\Architecture-Knowledge-System `
  --read-only `
  --report-dir reports\migration
pnpm akp vault status `
  --vault-path C:\Users\david\Documents\Architecture-Knowledge-System
```

Expected baseline: 548 imported Markdown files, 552 composite documents, 2,071
units and 1,192 relations. Warnings include 100 unresolved wikilinks and six
archived acquisition backlogs. Do not convert these warnings into invented
targets or agent instructions.

## Submit and monitor a source

The submitted path must be under an `AKP_INGEST_ROOTS` entry. The API creates a
durable job; the worker stores the object by SHA-256 and transfers the immutable
bytes to the extractor through authenticated multipart with an expected hash.

Use `GET /v1/ingest/:id` or the `/jobs/:id` page to inspect transitions. An
expired lease is reclaimable; a live worker renews its lease every third of the
lease interval. Cancel/retry through the API rather than editing database job
state.

Check extractor capability truth at:

```powershell
Invoke-RestMethod http://127.0.0.1:8090/v1/capabilities
```

Text/Markdown, PDF, captured HTML, image metadata, DOCX and PPTX are configured.
OCR/vision, audio and video return `CAPABILITY_NOT_CONFIGURED`.

## Search and build bounded context

```powershell
$env:AKP_API_URL = 'http://127.0.0.1:8080'
pnpm akp search 'hexagonal architecture boundary'
pnpm akp context 'choose architecture for volatile integrations'
```

The four-case benchmark recommends `lexical+graph`; it is not a global runtime override. Inspect the
packet revision, channels, selection reasons, citations, conflicts and gaps
before using it as authority. Follow continuation handles rather than loading
the whole vault.

## Rebuild derived indexes

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

The caller must use an admin token with `pathPrefix: null` for `$spaceId`. The
confirmation must be `REBUILD_DERIVED_PROJECTIONS` when `reimportVault` is false
or omitted. To import the configured vault before rebuilding, set
`reimportVault = $true` and use `confirm = 'REIMPORT_AND_REBUILD'`.

The response reports `status`, `imports`, `relationCount`, `projection` and
`lint`. Read the resulting lexical/vector/graph/context-pack revision markers
separately with `GET /v1/indexes`; vector-disabled degradation is expected until
a larger benchmark justifies activation.

## Schema, lint, Error Book and audit

```powershell
pnpm akp schema dry-run --version 1.1 --require id type status
pnpm akp lint run --trigger MANUAL
```

Schema dry-run opens a repeatable read-only transaction, fingerprints the
corpus before and after, reports compatibility/affected documents and persists
the report. It does not apply the schema. The worker runs scheduled lint;
merge, source update and reindex also invoke deterministic lint.

Create recurring failures through `/v1/error-book`, turn them into active evals
with `/v1/error-book/:id/regression`, then resolve only with a verification
result. Administrators inspect space-scoped events at `/admin/audit` or
`GET /v1/audit-events`.

## Backup and isolated restore

```powershell
$env:AKP_MANAGED_REPO = 'C:\path\to\managed-knowledge'
& .\scripts\backup.ps1 -OutputDirectory backups\release-candidate
& .\scripts\restore-smoke.ps1 -BackupDirectory backups\release-candidate
```

The set contains a PostgreSQL custom dump, MinIO data archive, managed Git
bundle when configured and non-secret configuration metadata. Each file is
SHA-256 listed in `manifest.json`. Restore smoke uses isolated resources and
never overwrites the active environment.

The 2026-08-12 v3 recovery restored 555 documents, 16 exact migrations, the
Git bundle and 22 MinIO archive entries. The entry count is archive metadata,
not a claim of user source-object count.

## Final release gate

```powershell
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm audit --audit-level high
pnpm security:secrets
pnpm contracts:validate
pnpm docs:validate
pnpm check
pnpm build
pnpm test:integration
pnpm verify:runtime
pnpm test:mcp

Push-Location apps/extractor
python -m ruff check --no-cache .
python -m pytest -p no:cacheprovider
Pop-Location

docker compose config --quiet
git diff --check
```

The current integration suite contains 28 cases across security/governance and
review-publication. Record the exact result before committing/tagging the
baseline.

## Open the vault in Obsidian

In Obsidian choose **Open folder as vault**, select
`C:\Users\david\Documents\Architecture-Knowledge-System`, then open its
`README.md`. Platform import remains read-only. Do not copy runtime indexes,
jobs, secrets or raw object storage into that folder.
