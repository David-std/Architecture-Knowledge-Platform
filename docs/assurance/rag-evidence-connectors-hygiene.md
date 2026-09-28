# RAG evidence, external references and operational hygiene

This document tracks the corrective work discovered after the context-answerability promotion. It intentionally uses generic/public fixtures only.

## P0 — passage evidence

- [ ] Model requested answer shape separately from generic cue words.
- [ ] Cover definition, yes/no + negation, condition, rationale, procedure, comparison, quantity/unit/period, and date/year.
- [ ] Require entity/relation support inside a bounded local passage window.
- [ ] Prevent vector rank and retrieval channels from constituting evidence.
- [ ] Keep only a strict exact-identifier lookup exception.
- [ ] Cover bilingual paraphrase/negation without globally lowering lexical thresholds.
- [ ] Keep conceptual/vector retrieval available when dependency wording is not an actual impact-analysis request.
- [ ] Decouple internal candidate breadth from presentation limit and measure fallback latency.
- [ ] Extend benchmark expectations from document-level relevance to passage/predicate answerability.

## P1 — external ticket references

- [ ] User/agent supplied references start as REFERENCE, never SYSTEM_OF_RECORD.
- [ ] Require an appropriate write capability to create/update a session reference.
- [ ] Preserve observation time, provider identity/revision and provenance.
- [ ] Distinguish agent-relayed data from provider-verified data.
- [ ] Add Jira/Linear provider adapter contracts with read-only sync semantics, cursor/webhook/idempotency and stale/unavailable states.
- [ ] Add simulated-provider tests. A real-integration claim remains blocked until sandbox credentials are exercised.
- [ ] Expose safe AKP MCP operations for linking/querying/updating external references without promoting ticket content into approved knowledge.

## P1 — operational reconciliation

- [ ] Add audited quarantine disposition instead of deleting history.
- [ ] Doctor distinguishes unresolved quarantine from resolved/reconciled history and can scope diagnostics.
- [ ] Failed fixture ingests can receive terminal audited disposition without widening ingest roots.
- [ ] Keep test infrastructure from contaminating operator diagnostics.

## Web demo/mock-data audit

- [ ] Identify every Web path that renders demo/mock/example vault/session/ticket data.
- [ ] Production/runtime Web must not present synthetic vaults as connected or imported data.
- [ ] Any intentional demo surface must be explicitly labelled and isolated from live API state.
- [ ] Add regression coverage for empty/fresh installations.

## Evidence boundary

Private vault questions, IDs, paths and contents must not be committed. Public regressions must be semantically equivalent, not copied from private data.
