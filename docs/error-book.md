# Error Book guide

The executable register is the `error_book` table exposed by `GET /v1/error-book`. Supported categories include `SOURCE_MISSED`, `FACT_DROPPED`, `WRONG_IDENTITY`, `DUPLICATE_PAGE`, `STALE_CLAIM`, `BROKEN_PROVENANCE`, `BAD_CONTEXT_PACKET`, `RETRIEVAL_FAILURE`, `INDEX_REVISION_MISMATCH`, `PROMPT_INJECTION`, `REVIEW_ESCAPE` and `RESTORE_FAILURE`.

An entry is useful only when it contains root cause, affected resource metadata, correction, regression test/eval and verification result. The initial shared-worktree publication escape produced the isolation ADR and Git regression test. Staleness invalidation produces `STALE_CLAIM` entries and impacted document IDs.
