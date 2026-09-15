# ADR 0002 — Isolated drafts and compensated publication

- Status: accepted
- Date: 2026-07-29

## Context

A shared Git working tree allowed one approved review to include a different rejected draft during early testing. Git and PostgreSQL cannot participate in one atomic transaction, so publication also has an unavoidable failure window between the managed Git commit and the PostgreSQL business commit.

## Decision

Each review uses an isolated Git worktree and branch. Publication takes one database-backed writer lock and persists a `PUBLISHING` intent, including reviewer identity and reason, before touching main. It then verifies the expected base and draft head and squash-merges exactly that branch.

The publication invariant is:

1. `PUBLISHING` is durable intent only; it is never evidence that knowledge is published.
2. `APPROVED + merged_commit + publication outbox` are written in one PostgreSQL transaction and together form the business commit point.
3. Projection consumers act only from that durable outbox; a Git commit by itself never advances retrieval state.
4. If Git succeeds but the PostgreSQL transaction fails in-process, the API reverts the Git commit. The compensating revision becomes the review's new base so the same isolated draft can be retried safely. No publication event is emitted for the failed attempt.
5. If a process dies after the Git commit and before the PostgreSQL transaction, an admin reconciliation may finalize only when current main is provably that review's publication: exactly one parent equal to the recorded base, a tree equal to the recorded draft head, and the expected publication commit subject.
6. If that proof fails, reconciliation changes the review to `PUBLICATION_RECOVERY_REQUIRED`, records the Error Book entry, and does not guess, revert, or append publication events.
7. The conditional `PUBLISHING -> APPROVED` row update is the replay/idempotency fence. Only the transaction that wins it appends the outbox, so reconciliation can be retried without double publication.

## Consequences

The demonstrated cross-draft escape is prevented by regression tests. Git/PostgreSQL failure windows are covered by integration tests for merge-then-DB-failure compensation, intent-then-Git-conflict, crash recovery, ambiguous-main failure, safe replay, and no double publication. Operator-visible Error Book records remain mandatory for any ambiguous recovery.
