# Unified Goal V2 traceability

| Requirement                    | Delivered artifact                                       | Latest executed proof                                                        |
| ------------------------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Separate executable repository | pnpm monorepo, Compose, CI and 12 migrations             | clean Node 20 check/build; fresh schema 001–012 with zero mismatches         |
| Preserve canonical vault       | read-only importer and separate managed Git corpus       | 552 docs imported; no platform runtime write to vault                        |
| Stable identity and hierarchy  | importer, schemas and unit compiler                      | 2,071 hierarchical units; 1,192 typed relations                              |
| Hybrid retrieval               | exact/lexical/vector/graph/context/raw/code adapters     | 4/4 eval and 11 configuration benchmark; vector remains benchmark-only       |
| Bounded ContextPacket          | contract, packet builder and persistence                 | packet `03e8658c-2f2d-40a8-86bf-e93934ed199f` persisted through live API     |
| API/CLI/MCP                    | Fastify, CLI and 18 MCP tools                            | MCP status `UP`, 18 tools listed, search returned 3 hits                     |
| Immutable ingest/extraction    | MinIO hash boundary and Python extractor                 | clean Python 3.12 ruff + 6 pytest cases; authenticated hash flow             |
| Review/publication/rollback    | isolated drafts, verification and lock                   | 5 integration cases cover invalid/duplicate/mutable/reject cleanup outcomes  |
| Team governance                | scope-aware tokens/sessions, RBAC, audit and idempotency | 21 security/governance integration tests passed                              |
| Web product                    | Next UI                                                  | production build; `/`, `/login`, `/reviews` live HTTP 200 smoke              |
| Evaluation/proof               | gold set, eval and benchmark routes                      | eval `8477b608-a9d6-41d1-b216-91488c0da6e1` 4/4; 11-run benchmark            |
| Backup/restore                 | v3 PowerShell backup and isolated restore                | 552 documents, exact 12 migrations, 22 MinIO entries and Git bundle verified |
| Documentation and contracts    | OpenAPI, AsyncAPI, MCP schema, ADR/runbooks              | validators: 46 paths, 2 channels, 18 tools, 30 Markdown                      |

## Closure trace\n\nThe read-only vault validator/eval outputs, deterministic manifest, private ZIP, staged private-file audit, functional commit and annotated tag have been recorded at closure. `PROJECT_STATE.md` holds the exact vault ZIP, manifest and aggregate SHA-256 values. Remaining entries in `REMAINING_REAL_GAPS.md` are genuine limits rather than missing release evidence.
