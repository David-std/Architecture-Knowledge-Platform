# Release traceability (reconciled 2026-08-30)

| Requirement                     | Delivered artifact                                                        | Latest proof                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Generic multivault core         | migration 013, `vault-registry.ts`, scoped APIs/evals/importer            | fresh two-vault isolation with duplicate paths; 13 Postgres tests                            |
| Durable event pipeline          | migration 014, outbox/deliveries/quarantine/reconciliation, event worker  | lease/fencing/retry/quarantine/requeue tests; `EVENT_DRIVEN_VALIDATION_REPORT.md`            |
| Incremental indexes             | migration 015 and `@akp/indexing`                                         | 5 real-DB tests; tombstone-only and multivault isolation; full rebuild repair-only           |
| Canonical document intelligence | migrations 016–018, extractor ports/adapters, `DocumentArtifact` contract | Ruff, mypy and 13 pytest under Python 3.12; worker/contract tests; nine executed fixtures    |
| Structural retrieval            | hierarchical units, typed locators, parent rehydration                    | retrieval unit suite 19/19; repeated-block regression; product E2E ContextPacket             |
| Retrieval evaluation            | generic and curated eval packs, deterministic matrix/offline runners      | 19 generic plus 13 curated fixture cases; no production default claim                        |
| Review/publication              | isolated Git drafts and seven lifecycle outbox events                     | API integration 34/34; full ingest-review-publish-index-search, reject and rollback E2E      |
| API/CLI/MCP/Web                 | Fastify, CLI, 21 MCP tools, Next UI                                       | contracts 51/3/21; live API/MCP/CLI; authenticated and unauthenticated Web smokes            |
| Agent ContextPacket usability   | scoped MCP session, lexical retrieval, bounded packet                     | supported 300/512-token packet; 2 citations; deterministic comparison classified LIMITED     |
| Audit/export                    | sanitized ZIP plus opt-in raw evidence export                             | audit-export 10 unit tests; API/CLI raw export tests; secrets scan                           |
| Recovery                        | backup v3 and isolated restore                                            | populated and empty restores passed with all 18 migrations; checksum tampering failed closed |
| Hygiene/genericity              | deterministic classification, generic eval layout, archived iterations    | docs validator, 340-file source inventory, secret scan and clean checkout pass               |
| Synthetic scale                 | isolated PostgreSQL load harness and machine-readable report              | 1K/10K/50K/100K exact rows; FTS/vector/graph/packet measurements; cleanup passed             |
| External vault safety           | read-only registry/import boundary                                        | no platform publication into `Architecture-Knowledge-System`; managed Git is separate        |

## Evidence chain

The authoritative command record is `VALIDATION_REPORT.md`; architectural and
operational state is in `PROJECT_STATE.md`; event evidence is in
`EVENT_DRIVEN_VALIDATION_REPORT.md`; benchmark evidence is in
`DOCUMENT_INTELLIGENCE_BENCHMARK.md`, `RETRIEVAL_BENCHMARK.md` and their
machine-readable reports. Validated implementation commit
`aad98770e2e44fcb31f3c1943d3588a8c6f50fb2` is closed by annotated checkpoint
`v0.2.1-platform-validation`; the prior checkpoint remains
`v0.2.0-platform-megagoal`.
