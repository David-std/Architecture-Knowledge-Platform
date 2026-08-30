# Project state

- Status: `validation-baseline-stable`
- Updated: 2026-08-30 (America/Bogota)
- Release tag: `v0.2.1-platform-validation`
- Validated implementation commit:
  `aad98770e2e44fcb31f3c1943d3588a8c6f50fb2`
- Prior baseline tag: `v0.2.0-platform-megagoal`
- Prior baseline commit:
  `e829ea6f65b617bbb6d4b5e5e3f97f984df2dda4`
- Platform repository:
  `C:\Users\david\Documents\Architecture-Knowledge-Platform`
- Isolated validation copy:
  `C:\Users\david\AppData\Local\Temp\akp-platform-validation-final-20260827`
- External vault: not used by the final hardening suite. It remains a
  read-only optional integration source and is not a platform bootstrap
  dependency.
- The annotated release tag records the documentation closure above the
  validated implementation commit. Its target is the authoritative release
  commit and can be resolved with
  `git rev-list -n 1 v0.2.1-platform-validation`.

## Validation environment

| Component  | Observed version |
| ---------- | ---------------- |
| Windows    | NT 10.0.26200.0  |
| Node.js    | 25.2.0           |
| pnpm       | 10.34.5          |
| Python     | 3.12.13          |
| PostgreSQL | 16.14            |
| pgvector   | 0.8.5            |
| Docker     | 29.6.2           |
| Git        | 2.49.0.windows.1 |

CI remains the authoritative compatibility gate for Node 20 and Python 3.12.

## Proven candidate evidence

| Measure                     | Observed result                                                                                     |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| Append-only migrations      | 18 exact files; fresh apply, idempotent rerun and checksum guard passed                             |
| Runtime verifier            | 47/47 schema, isolation, lineage, credential and durable-outbox checks passed                       |
| Required runtime relations  | 53/53 present                                                                                       |
| TypeScript unit tests       | 113 passed; 3 database-only cases skipped by the unit command                                       |
| API integration             | 34/34 passed across security, review/publication and product lifecycle                              |
| Real database package tests | 3/3 passed for crash/reclaim outbox plus incremental and multivault indexing                        |
| Python extractor            | Ruff PASS, mypy 17 source files PASS, pytest 13/13                                                  |
| Architecture boundaries     | 158 source modules / 390 dependencies; zero violations                                              |
| Contracts                   | 51 OpenAPI paths / 3 AsyncAPI channels / 21 MCP tools                                               |
| Web build                   | 18 dynamic routes                                                                                   |
| Active documentation        | 38 Markdown files; validator PASS                                                                   |
| Dependency audit            | 443 dependencies; zero known vulnerabilities at every severity                                      |
| Live API / MCP / CLI        | readiness `UP`; MCP 21/21; CLI status PASS                                                          |
| Agent usability smoke       | MCP session and ContextPacket PASS; 300/512-token section with two citations; deterministic only    |
| Live Web                    | unauthenticated protected routes `307` to `/login`; authenticated workflows returned `200`          |
| Retrieval Level A / Level B | 19 × 10 generic cases; 13 × 10 curated cases over three isolated fixture vaults                     |
| Document intelligence       | 9 deterministic executions; 27 optional candidates explicitly skipped                               |
| Synthetic scale             | 1K, 10K, 50K and 100K documents/units; exact counts and cleanup passed                              |
| Backup / restore            | populated and empty restores passed with all 18 migrations; checksum tampering failed closed        |
| Failure injection           | PostgreSQL, MinIO, extractor, vector channel and API/MCP failures degraded or recovered as designed |
| Repository hygiene          | 340 files classified; tracked-file secret scan and `git diff --check` passed                        |

The bootstrap verifier intentionally treats corpus sizes as observations, not
release requirements. Its latest release-gate run observed four registered
read-only fixtures, two documents, three units, one embedding and 22 audit
events, with zero relations, sources, artifacts or ContextPackets and zero
isolation or lineage violations.

## Product workflow proof

The product-lifecycle integration performs real ingestion, deterministic
extraction, review creation, `REQUEST_CHANGES`, draft revision 2, approval,
Git publication, durable outbox delivery, worker drain, incremental indexing,
search and persisted ContextPacket generation. It then proves rejection and
rollback, including tombstoning and removal from search. PostgreSQL, MinIO,
Git and filesystem fixtures are isolated; the external vault is never read.

A separate MCP usability smoke created an ephemeral vault, started a scoped
512-token agent session, retrieved one supported section through lexical search
and built a 300-token packet with two source/revision citations and no gaps.
The packet carried provenance and untrusted-content controls, but it was larger
than the raw fixture and no LLM judged task quality; this is `PARTIALLY_PROVEN`,
not evidence that packets always reduce tokens or improve completion quality.

## Current architecture decisions

1. `VaultRegistry` is the explicit tenancy boundary. Every operational and
   knowledge resource carries vault and space identity; federation is opt-in.
2. Reviewed Markdown/Git remains canonical. PostgreSQL, FTS, vectors, graph,
   packets and eval results are rebuildable projections.
3. Publication records vault-scoped lifecycle events. Normal indexing is
   asynchronous and incremental; full rebuild is an administrator-confirmed
   repair path.
4. `DocumentArtifact` is the provider-neutral extraction contract. The
   deterministic adapter is the availability fallback; no optional provider
   is promoted without an executed comparative benchmark.
5. Production retrieval default remains `null`. Vectors and reranking are not
   enabled from synthetic fixture scores.
6. Raw evidence export remains disabled by default and requires explicit
   authorization, hash verification, safe roots and confirmation.

## Important defects corrected during validation

- whole-space/pathless operations now reject path-scoped credentials;
- audit and Error Book metadata recursively remove secrets and host paths;
- automatic worker reviews carry the required `vault_id`;
- the indexer accepts reviewed proposals stored at repository root or under
  `managed/` without weakening containment;
- prompt-injection source text remains untrusted evidence and malicious HTML
  active content is removed;
- unauthenticated Web pages redirect to login instead of rendering HTTP 500;
- outbox crash-recovery integration isolates its consumer fixture instead of
  timing out while draining unrelated historical deliveries;
- idempotent replay now incorporates current vault enabled/visibility state and
  inherited grants, so a disabled or newly private vault fails authorization
  before a stored success can be replayed;
- the runtime verifier rejects the legacy outbox-attempt uniqueness shape and
  requires terminal outcomes to be unique by event, consumer, generation,
  attempt and outcome;
- clean unit bootstrap builds internal workspace dependencies and excludes
  compiled `dist` tests, removing duplicate test execution;
- Hono was pinned to a non-vulnerable release and four unused dependencies
  were removed.

## Honest boundary

This baseline is a reusable local platform, not an internet-ready hosted
service. Optional Docling, Marker and Chunkr execution, production semantic
quality, enterprise identity, high availability, RLS, remote encrypted/WORM
backup and effective telemetry export remain explicitly classified in
`REMAINING_REAL_GAPS.md`. The current OpenTelemetry API bridge has no configured
provider/exporter, so persisted lifecycle state is operational evidence but
not distributed tracing.
