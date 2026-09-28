# RAG evidence, external references and operational hygiene

This document tracks the corrective work discovered after the context-answerability promotion. It intentionally uses generic/public fixtures only.

## P0 — passage evidence

- [x] Model requested answer shape separately from generic cue words.
- [x] Cover definition, yes/no + negation, condition, rationale, procedure, comparison, quantity/unit/period, and date/year.
- [x] Require entity/relation support inside a bounded local passage window.
- [x] Prevent vector rank and retrieval channels from constituting evidence.
- [x] Keep only a strict exact-identifier lookup exception.
- [x] Cover bounded bilingual paraphrase/negation without globally lowering lexical thresholds.
- [x] Keep conceptual/vector retrieval available when dependency wording is not an actual impact-analysis request.
- [x] Decouple internal candidate breadth from presentation limit and record the internal breadth/verification latency.
- [x] Extend registered benchmark labels from document relevance to explicit passage/predicate support via `goldSupportIds` / `retrievedSupportIds`.

## P1 — external ticket references

- [x] User/agent supplied references start as `REFERENCE`, never `SYSTEM_OF_RECORD`.
- [x] Require an appropriate write capability and principal action to create/update a session reference.
- [x] Preserve observation source, provider identity/revision and provenance.
- [x] Distinguish agent-relayed data (`providerVerified: false`) from authenticated provider observations (`providerVerified: true`).
- [x] Add Jira/Linear read-only provider adapters with cursor polling, idempotent inbox application and explicit AVAILABLE/DEGRADED/UNAVAILABLE health.
- [x] Keep provider registration fail-closed to allowlisted Jira Cloud / Linear endpoints and credential references rather than secret bytes.
- [x] Add simulated-provider tests. A real-integration claim remains blocked until sandbox credentials are exercised.
- [x] Expose safe AKP MCP operations for linking/querying/updating external references without promoting ticket content into approved knowledge.
- [ ] Provider webhook ingestion is intentionally not advertised until an authenticated HTTP path is wired into the inbox.
- [ ] Provider deletion/tombstone propagation is intentionally `NONE` until a demonstrable deletion reconciliation path exists.
- [ ] Run Jira and Linear sandbox/account acceptance with real credentials before calling the adapters live-validated.

## P1 — operational reconciliation

- [x] Add audited append-only quarantine disposition instead of deleting history.
- [x] Doctor distinguishes unresolved quarantine from reconciled history and can scope diagnostics by vault/environment.
- [x] Failed fixture ingests can receive terminal audited disposition without widening ingest roots.
- [x] Add regression coverage that terminal dispositions do not mutate quarantine history and cannot be applied to non-failed ingests.
- [x] Keep Browser E2E fixtures out of an operational database by requiring an explicitly disposable test/e2e/ci database.

## Web demo/mock-data audit

- [x] Audit production Web vault surfaces: they consume API-backed `/v1/vaults` / operator state rather than a hard-coded mock vault registry.
- [x] Prevent Browser E2E fixtures from being persisted into the ordinary runtime database.
- [x] Production/runtime Web therefore does not intentionally present synthetic vaults as connected/imported data.
- [x] No intentional production demo-vault surface was found; if one is introduced it must be explicitly labelled and isolated.
- [ ] Add a dedicated fresh-install/zero-vault Web regression; current protection is data-source and E2E database isolation rather than an explicit empty-install browser assertion.

## Merge boundary

- [ ] All same-SHA public workflows green on Node 24.
- [ ] Private local RAG regression suite repeated against this PR head.
- [ ] Jira/Linear sandbox run is required only for a live-provider validation claim; simulated-provider CI is not evidence of a real account connection.

## Evidence boundary

Private vault questions, IDs, paths and contents must not be committed. Public regressions must be semantically equivalent, not copied from private data.
