# ADR 0001 — Canonical corpus and derived projections

- Status: accepted
- Date: 2026-07-29

## Context

Humans need portable Markdown/Obsidian while agents need bounded retrieval, policies and machine contracts. Treating vectors, the graph or Obsidian as competing sources creates drift.

## Decision

Approved Markdown and Git history are canonical. PostgreSQL FTS, pgvector, typed relations and `ContextPacket` records are rebuildable projections. The existing vault is imported read-only; reviewed supplemental knowledge is published to a separate managed Git repository.

## Consequences

Index revisions must resolve to a corpus revision and degrade explicitly when inconsistent. Runtime state never pollutes the vault. Recovery requires Git, PostgreSQL, raw objects and configuration metadata rather than one opaque index backup.
