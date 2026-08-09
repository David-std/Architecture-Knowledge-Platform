# Changelog

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
