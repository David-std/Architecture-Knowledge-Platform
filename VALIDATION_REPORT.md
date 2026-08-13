# Validation report

- Date: 2026-08-12 (America/Bogota)
- Environment: Windows, Node 25.2.0, pnpm 10.34.5, Python 3.14.0,
  PostgreSQL/pgvector and MinIO through Docker Desktop.
- CI target remains Node 20 and Python 3.12; the full final suite below was not
  rerun inside those exact runtimes in this iteration.
- Target checkpoint: `v0.2.0-platform-megagoal`.
- Functional implementation commit:
  `bdd70c92b9430c43c620ed5e53dd5af8748d85e4`.

`PASS` below means the command or integration outcome was observed. A
benchmark marked `LIMITED` is intentionally not promoted into a quality claim.

## Executed gates

| Gate                     | Result          | Observed evidence                                                                                   |
| ------------------------ | --------------- | --------------------------------------------------------------------------------------------------- |
| Frozen install           | PASS            | `pnpm install --offline --frozen-lockfile --strict-peer-dependencies`; 23 workspaces                |
| Dependency audit         | PASS            | `pnpm audit --audit-level high`; 0 high, 0 critical; 1 low and 3 moderate remain                    |
| Format                   | PASS            | `pnpm exec prettier --check .`                                                                      |
| Contracts                | PASS            | 50 OpenAPI paths, 3 AsyncAPI channels, 20 MCP tools                                                 |
| Docs                     | PASS            | 40 Markdown documents                                                                               |
| Hygiene/secrets          | PASS            | 320/320 files classified; 320 files scanned; no forbidden tracked secret/private artifact           |
| Node quality suite       | PASS            | lint, typecheck, 558-module/823-dependency boundary graph and all unit tests                        |
| Production build         | PASS            | all TypeScript packages plus Next production build and 18 dynamic routes                            |
| API integration          | PASS            | 2 files, 28/28 tests                                                                                |
| Real PostgreSQL packages | PASS            | `@akp/postgres` 12/12; `@akp/indexing` 4/4                                                          |
| Fresh migrations         | PASS            | isolated pgvector database applied `001`–`016`                                                      |
| Runtime verifier         | PASS            | 16 migrations; 555 docs; 6,138 units; 4,078 embeddings; 1,192 relations; ContextPacket present      |
| Python extractor         | PASS            | Ruff; 12/12 pytest under local Python 3.14.0                                                        |
| Runtime/API smoke        | PASS            | liveness/readiness `UP`; PostgreSQL, raw store and extractor ready; ContextPacket persisted         |
| MCP smoke                | PASS            | 20/20 tools; status `UP`; explicit VaultRegistry scope; search returned a valid empty hit set       |
| Document intelligence    | PASS WITH LIMIT | 9 deterministic executions; 27 optional candidates explicitly skipped; no optional default selected |
| Retrieval benchmark      | PASS WITH LIMIT | 19 generic cases/slices; exact 10 configurations; logic-only synthetic; production default `null`   |
| Backup/restore           | PASS            | v3 manifest; 555 docs; exact 16 migrations; 22 MinIO files; verified Git bundle                     |
| Recovery ZIP             | PASS            | 4,495,017 bytes; SHA-256 `06af22ada90f8e924facfd72065bffa7b1169d268f0a563fc7efdf3df7d8c5fd`         |

## Benchmark provenance

- Retrieval dataset SHA-256:
  `e8d9d5959aab4773b46210ad01b9ac6bfffc110dfc7f95d9bfb5cdd79991fdca`.
- Retrieval report SHA-256:
  `AA000CE2339B5F89C0351AFADFC40A4B0994E90552DA22209923D6BCE6A1C9F3`.
- The offline runner validates matrix/scoring/guardrails only. It does not read
  private vault content or a production database and makes no retrieval-quality
  claim.
- Document intelligence used local Python 3.14.0. CI declares Python 3.12, but
  this exact benchmark was not rerun under 3.12.

## Security/recovery assertions actually exercised

- API-token scopes survive web-session exchange and are re-intersected with
  current memberships; malformed prefixes fail closed.
- Idempotency is partitioned by concrete credential scope and resource URL;
  expired uncertain leases are abandoned rather than replayed.
- Vault and path scope protect metadata, source, graph, schema, eval, session,
  audit and export operations.
- Publication validates immutable reviewed head/base, serializes decisions,
  cleans rejected drafts and emits vault-scoped outbox events without a
  synchronous normal-path reindex.
- Backup recovery validates artifact names, sizes, hashes, exact migration
  inventory, MinIO contents and Git bundle integrity.

## Remaining evidence limits

- Local Node/Python versions differ from CI targets; the committed CI workflow
  is the reproducibility gate for Node 20/Python 3.12.
- Optional Docling/Marker/Chunkr adapters were unavailable and therefore
  skipped, not simulated.
- The retrieval benchmark is synthetic and logic-only; no production channel
  default or semantic-quality claim is justified.
- Raw evidence export is disabled by default and was tested with a mock object
  store; enabling it is a deployment decision.
- The final metadata commit and annotated tag close the validated branch in the
  permanent repository.
