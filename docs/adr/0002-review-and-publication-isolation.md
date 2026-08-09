# ADR 0002 — Isolated drafts and compensated publication

- Status: accepted
- Date: 2026-07-29

## Context

A shared Git working tree allowed one approved review to include a different rejected draft during early testing.

## Decision

Each review uses an isolated Git worktree and branch. Publication takes one database-backed writer lock, checks the expected base, squash-merges exactly that branch, reindexes, records the decision and removes the worktree. On downstream failure it attempts a Git revert and records `REVIEW_ESCAPE` in the Error Book.

## Consequences

The demonstrated cross-draft escape is prevented by regression tests. Git and PostgreSQL still do not share an atomic transaction; compensation and operator-visible error records remain necessary.
