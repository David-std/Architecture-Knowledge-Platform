# Changelog

## Unreleased — v0.3 product completion (draft)

- Closed P0 event correctness with per-consumer causal eligibility and a
  machine-readable drain-to-quiescence that distinguishes claimable, blocked,
  scheduled, leased, quarantined and succeeded deliveries.
- Added focused PostgreSQL regressions for parent success/retry/quarantine,
  unrelated roots, expired leases and the claim-versus-summary race; retained
  the unchanged 34-case API integration suite and product-lifecycle assertion.
- Moved the supported runtime to Node 24.20.0 (`>=24 <25`) and verified frozen
  strict installation, unit/type gates, build, MCP and backup/restore remotely.
- Added the authoritative Python `uv.lock`, locked CI and Docker consumption,
  and kept Docling, Marker and Chunkr provider dependencies opt-in.
- Made CI diagnostic and self-cleaning, corrected the CLI import smoke's
  required space identifier and refreshed repository file classification.
- P0 clean-checkout proof: GitHub Actions run `33463026103`, both jobs PASS on
  head `10fbea61afe66342dd519ebdcf01e982364a76a3`.

## v0.2.1-platform-validation — baseline stable, 2026-08-30

- Extended the documented executable schema from migrations `001`–`016` to
  `001`–`018`, including the legacy metadata guard and outbox attempt outcomes.
- Reconciled contracts and reports with 51 OpenAPI paths, 3 AsyncAPI channels,
  21 MCP tools and 34 passing API integration cases.
- Replaced historical corpus-size assumptions in `verify:runtime` with 47
  bootstrap invariants covering schema, migration hashes, credentials,
  isolation, lineage and durable outbox triggers; populated thresholds are now
  an explicit opt-in.
- Hardened path/vault authorization and audit metadata across governance,
  projects, reviews, ingestion, evaluation, Error Book and schema routes.
- Added prompt-injection and malicious-HTML boundary regressions; removed four
  unused sanitize-html/Fastify runtime or type dependencies.
- Pinned Hono 4.13.5 after the dependency audit exposed vulnerable transitive
  4.12.32; the repeated audit reports zero known vulnerabilities.
- Executed Level-B retrieval over 13 cases, ten configurations and three
  isolated fixture vaults without selecting a production default.
- Added a real product-lifecycle E2E covering ingest, extraction,
  `REQUEST_CHANGES`, revision, approval, publication, outbox, worker, indexing,
  search, ContextPacket, rejection and rollback.
- Exercised a real scoped MCP agent session and bounded ContextPacket with two
  citations; retained `PARTIALLY_PROVEN` because no LLM quality comparison was
  executed and packet overhead exceeded the tiny raw fixture.
- Corrected missing `vault_id` on worker-created reviews and allowed the
  indexer to resolve reviewed proposals stored at repository root or under
  `managed/`.
- Added a reproducible 1K/10K/50K/100K PostgreSQL scale harness with FTS,
  fixed-vector, graph and ContextPacket measurements plus exact cleanup.
- Corrected protected Web routes to redirect unauthenticated renders to
  `/login`; added two regressions and live authenticated/unauthenticated page
  smokes.
- Isolated the durable-outbox integration consumer so crash/reclaim evidence
  does not time out while draining unrelated historical deliveries.
- Bound idempotent replay to current vault enabled/visibility state and both
  explicit and inherited grants; revocation now fails before replay.
- Added outcome-aware outbox attempt verification and rejected the legacy
  uniqueness shape that could suppress terminal delivery outcomes.
- Made clean unit bootstrap build internal workspaces and exclude compiled
  `dist` tests; the stable source boundary scan now covers 158 modules and 390
  dependencies.
- Executed populated and empty backup/restore smokes with all 18 migrations;
  migration rerun was idempotent and checksum tampering failed closed.
- Archived two superseded iteration reports under `docs/archive/iterations/`
  and excluded them from active documentation validation.
- Validated implementation commit
  `aad98770e2e44fcb31f3c1943d3588a8c6f50fb2` plus the metadata closure are
  recorded by annotated tag `v0.2.1-platform-validation`.

## v0.2.0-platform-megagoal — baseline stable, 2026-08-12

- Added generic `VaultRegistry`, per-vault memberships, visibility, eval packs
  and strict multi-vault query/index/export isolation.
- Added durable event outbox, delivery leases/fencing, quarantine/requeue,
  reconciliation and asynchronous publication lifecycle events.
- Added incremental structural indexing, parent rehydration and vault-scoped
  index revisions; retained full rebuild only as an explicit repair operation.
- Added canonical `DocumentArtifact`, deterministic structured adapters,
  document-intelligence benchmark and honest optional adapter routing.
- Added generic eval packs, exact ten-configuration scoring and deterministic
  offline retrieval harness without selecting a production default.
- Added sanitized audit ZIPs and separately confirmed, deployment-disabled raw
  evidence export with safe CLI roots.
- Expanded contracts to 50 OpenAPI paths, 3 AsyncAPI channels and 20 MCP tools.
- Fresh migrations `001`–`016`, API integration 28/28, Python 12/12, real
  Postgres/indexing tests, runtime/API/MCP smoke and v3 recovery all passed.
- Private recovery ZIP SHA-256:
  `06af22ada90f8e924facfd72065bffa7b1169d268f0a563fc7efdf3df7d8c5fd`.

Functional implementation commit
`bdd70c92b9430c43c620ed5e53dd5af8748d85e4` plus the final metadata commit are
recorded by annotated tag `v0.2.0-platform-megagoal`.

## v0.1.17-knowledge-baseline — baseline stable, 2026-08-08

Functional baseline commit `7daa261c446100b50bc985d60f199299291dfe2e` carries annotated tag `v0.1.17-knowledge-baseline`. The private vault ZIP is SHA-256 `3f1c923e832ad31735b63c86d0c85938af733a55020ebce8564f6b0cdb22e146`; its deterministic content manifest and aggregate hash are recorded in `PROJECT_STATE.md`.

### Closure hardening

- Added migration 012 scope snapshots and scope-aware idempotency identity.
- Enforced whole-space-only guards for pathless governance, knowledge, source,
  eval, schema, session and audit metadata.
- Hardened idempotency lease recovery, concrete-resource identity and session
  exchange handling.
- Added publication integration coverage for invalid drafts, duplicate paths,
  decision concurrency, draft mutation and cleanup.
- Hardened Git read failures, projection transaction boundaries and stale
  metadata reset; audited review comments.
- Rebuilt backup/restore as v3 with explicit artifacts, hash/size validation,
  exact migration inventory, isolated database and Git bundle verification.
- Corrected OpenAPI/MCP/reindex contracts, token scope docs, ERD and runbook.
- Fixed the cross-shell test exclusion so the Node unit gate does not
  accidentally execute database integration tests on Linux.
- Added pnpm overrides for `fast-uri`, `js-yaml` and `nanoid`; high-severity
  dependency audit is now clean.
- Corrected extractor lint behavior and verified it under clean Python 3.12.

### Executed results

- Fresh migration 001–012; Node 20 check/build; API integration 26/26; Python
  extractor 6/6; live runtime/API/MCP/web smokes; eval 4/4; 11-run benchmark;
  v3 backup/restore with 552 docs, 12 migrations, 22 MinIO entries and Git
  bundle verification.

### Known limits

The remaining product/evidence limits are maintained in
`REMAINING_REAL_GAPS.md`. The final closure action is not represented as done
until commit, annotated tag, snapshot hashes and read-only vault audit exist.
