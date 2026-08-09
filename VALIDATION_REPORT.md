# Validation report

- Environment: Windows + Docker Desktop; clean Node 20 container; Python 3.12
  container; PostgreSQL 16 + pgvector; MinIO.
- Target baseline: `v0.1.17-knowledge-baseline`
- Report date: 2026-08-08 (America/Bogota)
- Commit/tag/archive: `PENDING_FINAL_CLOSURE` at this point in the record.

`PASS` denotes an observed command or integration outcome. Historical evidence
is retained only where it remains useful; this report does not promote earlier
9-migration or 14-test counts as current facts.

## Current executed gates

| Gate                   | Result          | Exact observed evidence                                                                                                  |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Fresh schema migration | PASS            | `001`–`012`; 12 applied; zero SQL checksum mismatches in a newly created database                                        |
| Runtime verifier       | PASS            | 12 migrations; 552 docs; 2,071 units/embeddings; 1,192 relations; 3 sources; 79 artifacts; 1 ContextPacket               |
| Node 20 frozen install | PASS            | `pnpm install --frozen-lockfile --strict-peer-dependencies` in isolated container                                        |
| Dependency audit       | PASS            | `pnpm audit --audit-level high`: 0 high findings (1 low, 3 moderate remain below this gate)                              |
| Format                 | PASS            | `pnpm exec prettier --check .`                                                                                           |
| Node quality suite     | PASS            | `pnpm check`: typechecks, dependency-cruiser and all non-integration unit tests                                          |
| Production build       | PASS            | `pnpm build`, including Next production build                                                                            |
| API integration        | PASS            | 2 files, 26 tests: 21 security/governance plus 5 review-publication cases                                                |
| Python extractor       | PASS            | clean Python 3.12: `ruff check .`; 6 pytest cases passed                                                                 |
| Contracts/docs/secrets | PASS            | 46 OpenAPI paths, 2 AsyncAPI channels, 18 MCP tools; 30 Markdown; 221 repository files scanned                           |
| Runtime/API smoke      | PASS            | authenticated health `UP`, ContextPacket persisted, status/search succeeded                                              |
| MCP smoke              | PASS            | 18/18 required tools; real status `UP`; search returned 3 hits                                                           |
| Web smoke              | PASS            | `/`, `/login`, `/reviews` HTTP 200; review page had no `fetch failed` or server error marker                             |
| Eval                   | PASS            | run `8477b608-a9d6-41d1-b216-91488c0da6e1`; 4/4; zero critical failures                                                  |
| Retrieval benchmark    | PASS WITH LIMIT | 11 configurations over 4 cases; best eligible run `c8ec9350-9c11-4945-aac7-d201579cf0ab`; recommendation `lexical+graph` |
| Backup/restore         | PASS            | v3 manifest; 552 docs; 12 exact migrations; 22 MinIO entries; Git bundle verified                                        |

## Security and recovery corrections verified

- Scoped API tokens are intersected with current membership and persisted as an
  effective scope snapshot for web sessions.
- Path-scoped actors are denied whole-space/pathless metadata endpoints rather
  than receiving global status, audit, source, graph, schema, session or eval
  metadata.
- Idempotency identity includes concrete request URL and credential scope;
  expired uncertain leases become `ABANDONED`; the session exchange is excluded
  because replaying it cannot safely replay cookies.
- Publication tests exercise invalid frontmatter cleanup, duplicate path
  rejection, decision concurrency, changed draft head rejection and rejected
  draft cleanup.
- Backup/restore validates a fixed artifact list, sizes/hashes, exact migration
  inventory and configured managed-repository bundle rather than self-hashing a
  directory manifest.

## Explicit limitations of this evidence

- Four gold cases are a regression smoke, not a general retrieval-quality or
  multilingual semantic-recall claim.
- The selected benchmark configuration is a recommendation returned by the
  benchmark. It is not proof that every query intent should use that channel
  set.
- The Node 20 clean gate has no external database, so its unit suite excludes
  integrations correctly; the 26 integration tests were separately run against
  the local PostgreSQL service.
- The remaining release-closeout items are the final read-only vault audit,
  private-file staged audit, commit/tag and archive hash. They remain pending
  until their own outputs are recorded.
