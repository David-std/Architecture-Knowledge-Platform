# Project state

- Status: `baseline-stable`
- Target checkpoint: `v0.2.0-platform-megagoal`
- Updated: 2026-08-12 (America/Bogota)
- Platform repository: `C:\Users\david\Documents\Architecture-Knowledge-Platform`
- Validation worktree: `C:\Users\david\AppData\Local\Temp\akp-final-megagoal`
- External vault: `C:\Users\david\Documents\Architecture-Knowledge-System`
  (read-only; the platform never publishes into it)
- Managed publication repository: `C:\tmp\akp-managed-knowledge-v2`
- Private recovery ZIP:
  `C:\Users\david\AppData\Local\Temp\akp-final-megagoal-backup-c015d9a5cfe74d819f576d5cabcf36c7.zip`
- Recovery ZIP SHA-256:
  `06af22ada90f8e924facfd72065bffa7b1169d268f0a563fc7efdf3df7d8c5fd`
- Functional implementation commit:
  `bdd70c92b9430c43c620ed5e53dd5af8748d85e4`
- Annotated tag: `v0.2.0-platform-megagoal`

## Executed baseline

| Measure                           | Observed value |
| --------------------------------- | -------------: |
| Append-only migrations            |             16 |
| Registered read-only vaults       |              4 |
| Knowledge documents               |            555 |
| Hierarchical units / embeddings   |  6,138 / 4,078 |
| Typed relations                   |          1,192 |
| Immutable sources / artifacts     |         3 / 79 |
| Persisted ContextPackets          |              1 |
| API integration tests             |      28 passed |
| MCP tools                         |        20 / 20 |
| OpenAPI paths / AsyncAPI channels |         50 / 3 |
| Classified repository files       |            320 |

The imported vault revision remains
`snapshot:0e65e61ea31f0c1b9d135ec9fc5a822fd13db7bd4b470b772c935f2007a1ac34`.
Its unresolved links and import warnings remain explicit; the platform does not
fabricate repairs.

## Current architecture decisions

1. `VaultRegistry` is the explicit tenancy boundary. Queries, ingestion,
   publication, indexes, evidence and eval packs carry a vault identity;
   multi-vault synthesis requires explicit opt-in.
2. Markdown/Git remains canonical. PostgreSQL, lexical/vector indexes, graph,
   ContextPackets and eval results are derived projections.
3. Publication commits review state plus seven vault-scoped outbox events.
   Normal indexing is asynchronous and incremental; full rebuild is an
   administrator-confirmed repair operation.
4. `DocumentArtifact` is the canonical extraction contract. Deterministic
   adapters are available locally; Docling, Marker and Chunkr remain optional
   and no default is selected without a real benchmark.
5. Retrieval uses hierarchical/structural units. Container units are retained
   for parent rehydration and are not embedded as dossier-wide vectors.
6. Sanitized audit bundles are explicit exports. Raw evidence bytes require a
   separate confirmation, object hash/size verification, safe output roots and
   a deployment-disabled feature flag.

## Executed closure evidence

- Frozen pnpm install, high-severity dependency audit, global Prettier, lint,
  typecheck, dependency boundaries, all unit tests and production build passed.
- Fresh PostgreSQL applied migrations `001`–`016`; active database migration
  rerun was idempotent and runtime verification passed.
- API integration passed 28/28 cases, including scoped sessions,
  idempotency, publication/outbox, reindex, source retirement and audit export.
- PostgreSQL tests passed 12/12 and indexing tests passed 4/4 against a real
  database; a fresh multivault fixture proved identical paths remain isolated.
- Python Ruff and 12 extractor tests passed locally under Python 3.14.0.
- Live liveness/readiness returned `UP`; a real ContextPacket was persisted;
  MCP enumerated/exercised 20 tools against an authorized vault.
- Document intelligence benchmark executed nine deterministic fixtures and
  skipped 27 unavailable optional candidates honestly.
- Offline retrieval benchmark executed 19 generic cases/slices over the exact
  ten-configuration matrix. It is logic-only evidence; production default is
  deliberately `null` and vector invocation is disabled.
- Backup v3 restored 555 documents, the exact 16 migration names/checksums,
  22 MinIO files and a verified managed-Git bundle.

## Honest boundary

This is a stable local baseline, not an internet-ready hosted service. The
validated branch is integrated into the permanent repository and carries the
annotated tag above. Real residual limits remain explicit in
`REMAINING_REAL_GAPS.md`.
