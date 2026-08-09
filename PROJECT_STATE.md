# Project state

- Status: `release-candidate` — all executable gates listed below have passed;
  Git/tag/archive closure and the final read-only vault audit remain deliberately
  pending at the time of this update.
- Target version/checkpoint: `v0.1.17-knowledge-baseline`
- Updated: 2026-08-08 (America/Bogota)
- Active goal: Unified Goal V2
- Platform repository: `C:\Users\david\Documents\Architecture-Knowledge-Platform`
- External vault: `C:\Users\david\Documents\Architecture-Knowledge-System`
  (read-only import; never mutated by the platform)
- Managed corpus used for publication tests: `C:\tmp\akp-managed-knowledge-v2`
- Baseline Git commit/tag/archive hash: `PENDING_FINAL_CLOSURE`

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
Only the final read-only vault validators, private-file audit, commit, annotated
tag and archive SHA-256 are outstanding release-closeout actions; no result for
them is invented here.
