# Project state

- Status: `baseline-stable` — functional evidence, read-only vault audit and private snapshot passed.
- Target version/checkpoint: `v0.1.17-knowledge-baseline`
- Updated: 2026-08-08 (America/Bogota)
- Active goal: Unified Goal V2
- Platform repository: `C:\Users\david\Documents\Architecture-Knowledge-Platform`
- External vault: `C:\Users\david\Documents\Architecture-Knowledge-System`
  (read-only import; never mutated by the platform)
- Managed corpus used for publication tests: `C:\tmp\akp-managed-knowledge-v2`
- Functional baseline commit: `7daa261c446100b50bc985d60f199299291dfe2e`\n- Annotated tag: `v0.1.17-knowledge-baseline`\n- Private vault snapshot: `backups\\v0.1.17-knowledge-baseline-20260808\\architecture-knowledge-system-v0.1.17-knowledge-baseline-20260808.zip`\n- Vault snapshot SHA-256: `3f1c923e832ad31735b63c86d0c85938af733a55020ebce8564f6b0cdb22e146`\n- Vault manifest SHA-256: `a1c00872166cf652bfdd78a601013f6e6bee47807d74ecbb23402f167a398808`\n- Vault aggregate SHA-256: `204ba71e275ef877647b848d5f27c9c14b0d032a6b737dd2b9b8dbc0ec25b26f`

## Executed runtime baseline

| Measure                               | Observed value |
| ------------------------------------- | -------------: |
| Applied append-only migrations        |             12 |
| Vault-backed documents                |            552 |
| Hierarchical units / embeddings       |  2,071 / 2,071 |
| Typed relations                       |          1,192 |
| Immutable sources / artifacts         |         3 / 79 |
| Persisted ContextPackets              |              1 |
| API integration tests                 |      26 passed |
| Benchmark configurations / gold cases |         11 / 4 |
| MCP tools                             |        18 / 18 |

The import revision remains
`snapshot:0e65e61ea31f0c1b9d135ec9fc5a822fd13db7bd4b470b772c935f2007a1ac34`.
The imported vault has 100 unresolved wikilinks and 106 explicit import
warnings; neither condition is silently repaired or presented as an error-free
source corpus.

## Canonical decisions

1. Markdown/Git is canonical; PostgreSQL, vector/index, graph and ContextPacket
   records are rebuildable projections.
2. The original vault is only imported read-only. Reviewed generated knowledge
   is published to a separate managed Git repository.
3. The four-case benchmark currently recommends `lexical+graph`, but that
   recommendation is not silently treated as a universal runtime default. The
   intent planner remains explicit and the small benchmark is only regression
   evidence.
4. Source-recovery maps are agent-facing. Acquisition/download manifests stay
   archived provenance and are excluded from normal retrieval.
5. Evidence, claims, rules and context packs are typed dependency edges;
   ordinary wikilinks remain low-authority `related_to` links.
6. Direct publication is forbidden. Drafts use isolated worktrees, optimistic
   base/head checks, cleanup and a repository publication lock.

## Closure evidence recorded on 2026-08-08

- Fresh empty-database migration applied migrations `001`–`012` with zero
  checksum mismatches.
- A clean Node 20 / pnpm 10.34.5 container passed frozen strict-peer install,
  high-severity audit (0 high findings), Prettier, `pnpm check` and production
  build.
- API integration passed 26 tests (21 security/governance and 5 publication
  lifecycle cases). Unit tests, dependency boundaries and production build
  passed separately.
- Python 3.12 container passed `ruff check .` and 6 extractor tests.
- Runtime verification passed after persisting ContextPacket
  `03e8658c-2f2d-40a8-86bf-e93934ed199f`.
- A real API smoke returned `UP`; MCP enumerated and exercised all 18 tools;
  `/`, `/login` and `/reviews` returned HTTP 200 without hidden fetch errors.
- Eval run `8477b608-a9d6-41d1-b216-91488c0da6e1` passed all 4 cases; benchmark
  run `c8ec9350-9c11-4945-aac7-d201579cf0ab` evaluated 11 configurations and
  recommended `lexical+graph`.
- Backup v3 and isolated restore completed with 552 documents, 12 exact
  migrations, 22 MinIO archive entries and a verified Git bundle.

## Honest boundary

This is a controlled local baseline, not an internet-ready multi-tenant
service. The accepted limitations are listed in `REMAINING_REAL_GAPS.md`.
The read-only vault audit, deterministic manifest, private ZIP, staged private-file audit and annotated tag are complete. This file is a documentation-only follow-up to the tagged functional commit; product and assurance limits remain visible in `REMAINING_REAL_GAPS.md`.
