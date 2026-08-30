# Event-driven validation evidence

This is focused evidence for the event-driven indexing and multi-vault
contracts. It does not replace the repository-wide CI gate or declare the
overall release complete.

The migration transcript below is the complete event-pipeline chain through
`018`; a separate adversarial backup/restore and checksum run is recorded in
`VALIDATION_REPORT.md` and `MIGRATION_REPORT.md`.

## Fresh PostgreSQL migration chain

An isolated `pgvector/pgvector:pg16` database was empty before migration. The
same migration runner used by normal bootstrap applied the chain:

```powershell
pnpm exec tsx scripts/migrate.ts
```

The command applied, in order, every migration from
`001_init.sql` through `018_outbox_attempt_outcomes.sql`:

```text
Applied 001_init.sql
Applied 002_platform_runtime.sql
Applied 003_allow_audited_duplicate_external_ids.sql
Applied 004_hybrid_freshness_governance.sql
Applied 005_provenance_and_job_fencing.sql
Applied 006_revoke_bootstrap_credential.sql
Applied 007_generic_write_idempotency.sql
Applied 008_web_sessions_schema_governance.sql
Applied 009_eval_space_isolation.sql
Applied 010_token_scopes_and_idempotency_claims.sql
Applied 011_repository_publication_locks.sql
Applied 012_session_scopes_and_idempotency_scope.sql
Applied 013_generic_vault_registry.sql
Applied 014_event_outbox.sql
Applied 015_structural_units_and_incremental_indexes.sql
Applied 016_document_artifact_contract.sql
Applied 017_legacy_vault_metadata_guard.sql
Applied 018_outbox_attempt_outcomes.sql
```

The container is disposable and is not a project dependency. It must be
removed after the integrating agent finishes collecting evidence.

## Durable outbox and registry

```text
pnpm --filter @akp/postgres typecheck       PASS
pnpm --filter @akp/postgres test           PASS — 4 files, 13 tests
```

The PostgreSQL tests cover append idempotency, lease heartbeat, restart
reclaim/fencing, poison quarantine/requeue, reconciliation, explicit vault
scope, and registry authorization. Projection/index/context/evaluation
requests reject envelopes without a `vaultId`.

Migration 018 was also inspected on a freshly migrated database: the legacy
attempt-level uniqueness constraint is absent and the only outcome key includes
`event_id`, `consumer_name`, `delivery_generation`, `attempt` and `outcome`.
The integration path retains `CLAIMED` and terminal outcomes for one attempt.

## Incremental indexing and multi-vault isolation

```text
pnpm --filter @akp/indexing typecheck      PASS
pnpm --filter @akp/indexing test          PASS — 3 files, 5 tests
```

The fresh-DB integration suite verifies changed-path indexing, tombstone
updates, redelivered-event idempotency, revision-drift detection, and that a
tombstone-only event does not create a new embedding generation. The added
`multivault-isolation.integration.test.ts` registers two vault identities with
the same canonical checkout path, stores duplicate managed paths in both, and
asserts that each vault resolves only its own target relation.

## Worker consumers and publication

```text
pnpm --filter @akp/worker typecheck        PASS
pnpm --filter @akp/worker test            PASS — 3 files, 9 tests
```

The worker suite covers lifecycle mapping, context invalidation, impacted-eval
deduplication, vector freshness, event-path/tombstone deduplication, and
lease/fencing behavior.

```text
pnpm --filter @akp/api exec vitest run --config vitest.integration.config.ts \
  test/review-publication.integration.test.ts
PASS — 1 file, 7 tests
```

The approval test confirms business state and the publication/corpus/
lexical/vector/graph/context/evaluation outbox requests commit together,
every event carries the selected vault, causation chains are persisted, and
the approved managed document is not synchronously inserted by the approval
request. The response remains `indexing: "PENDING"`; indexing is performed by
the worker path.

The explicit reindex contract was also run against the same fresh database
after provisioning a disposable least-privilege token:

```text
pnpm --filter @akp/api exec vitest run --config vitest.integration.config.ts \
  test/security.integration.test.ts \
  -t "requires explicit confirmation and rebuilds derived projections"
PASS — 1 test (25 skipped by the focused filter)
```

It verifies missing `vaultId` (400), missing confirmation (409), and a
vault-scoped projection rebuild with a non-empty unit count.

## Limitations and remaining gates

- This report intentionally covers focused PostgreSQL/indexing/worker/API
  checks. Full repository gates are recorded separately in
  `VALIDATION_REPORT.md`; external vector-provider execution remains a real
  evidence gap.
- Repository typecheck and dependency-boundary gates pass; no inherited
  exact-optional-property error remains.
- No persistent database, source repository, or non-ephemeral user data was
  changed by the validation container.
