# Implementation report

## Outcome

The repository is an executable TypeScript/Python platform, separate from the
Obsidian vault. It imports that vault read-only, builds disposable retrieval
projections, ingests immutable sources, compiles reviewable drafts, publishes
through Git governance and serves bounded knowledge through Web, API, MCP and
CLI interfaces.

Capability labels follow Unified Goal V2 exactly.

| Capability                                          | Status                     | Executed evidence                                                                                 |
| --------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| Separate monorepo, strict TypeScript and boundaries | `IMPLEMENTED_AND_EXECUTED` | clean typecheck/build/boundary runs and CI definition                                             |
| PostgreSQL/pgvector, MinIO and extractor Compose    | `IMPLEMENTED_AND_EXECUTED` | loopback containers started; readiness checks PostgreSQL, MinIO and extractor                     |
| Append-only database schema                         | `IMPLEMENTED_AND_EXECUTED` | 12 checksum migrations applied; 12 exact migrations recovered in v3 restore smoke                 |
| Read-only vault parity                              | `IMPLEMENTED_AND_EXECUTED` | 548 Markdown files imported without platform writes to the source vault                           |
| Curated/raw knowledge boundary                      | `IMPLEMENTED_AND_EXECUTED` | curated recovery maps promoted; six acquisition backlogs quarantined                              |
| Hierarchical indexing                               | `IMPLEMENTED_AND_EXECUTED` | 552 documents and 2,071 hierarchical document/section/rule/workflow/example/evidence units        |
| Exact, FTS, graph and RRF                           | `PARTIALLY_IMPLEMENTED`    | 1,192 relations; 4/4 smoke; `lexical+graph` benchmark recommendation is not a global default      |
| pgvector adapter and generation metadata            | `IMPLEMENTED_AND_EXECUTED` | benchmark channel executed; disabled by measured policy on the small set                          |
| Bounded ContextPacket                               | `IMPLEMENTED_AND_EXECUTED` | persisted packets; budget/hash/gap/conflict/continuation/no-answer tests                          |
| API and CLI                                         | `IMPLEMENTED_AND_EXECUTED` | shared use cases exercised by integration and operational commands                                |
| stdio and Streamable HTTP MCP                       | `IMPLEMENTED_AND_EXECUTED` | generic clients listed and used all 18 tools on both transports                                   |
| Immutable source/object ingest                      | `IMPLEMENTED_AND_EXECUTED` | content-addressed MinIO storage, deduplication and source SHA-256 records                         |
| Worker-to-extractor boundary                        | `IMPLEMENTED_AND_EXECUTED` | authenticated multipart transfer from immutable object with extractor-side SHA-256 match          |
| Markdown/text, PDF and captured HTML                | `IMPLEMENTED_AND_EXECUTED` | locator-bearing extraction and ingest/publication flows                                           |
| Image metadata                                      | `IMPLEMENTED_AND_EXECUTED` | dimensions/format/mode/hash; explicit `OCR_NOT_CONFIGURED` warning                                |
| DOCX and PPTX extraction                            | `IMPLEMENTED_AND_EXECUTED` | paragraph/table and slide/notes adapters with source-hash locators                                |
| Audio/video and OCR/vision                          | `CONTRACT_ONLY`            | capability discovery and structured `CAPABILITY_NOT_CONFIGURED`; no fake transcript/vision result |
| Durable jobs                                        | `IMPLEMENTED_AND_EXECUTED` | lease, heartbeat, fencing, retry/cancel and expired-lease recovery                                |
| Compilation plan and probes                         | `IMPLEMENTED_AND_EXECUTED` | `NEW`, `UPDATE`, `DISPUTED`, `NO_MATERIAL` and critical-probe behavior                            |
| Git review, publication and rollback                | `PARTIALLY_IMPLEMENTED`    | isolated worktrees, head/base checks and 5 lifecycle tests; no distributed atomic commit/fencing  |
| Space/path RBAC and audit                           | `IMPLEMENTED_AND_EXECUTED` | token/session permissions, cross-space denial and scoped audit viewer                             |
| Web session and CSRF lifecycle                      | `IMPLEMENTED_AND_EXECUTED` | opaque hashed session, HttpOnly/SameSite cookie, CSRF denial and revocation                       |
| Web operational UI                                  | `IMPLEMENTED_AND_EXECUTED` | production build plus live `/`, `/login` and `/reviews` HTTP-200 smoke                            |
| Freshness and contradictions                        | `IMPLEMENTED_AND_EXECUTED` | warn/block/verify, source-retirement cascade, packet conflict and resolution                      |
| Schema governance dry-run                           | `IMPLEMENTED_AND_EXECUTED` | read-only repeatable fingerprint, compatibility and affected-document report                      |
| Deterministic and scheduled lint                    | `IMPLEMENTED_AND_EXECUTED` | merge/source/reindex hooks plus zero-finding manual and scheduled runs                            |
| Error Book                                          | `IMPLEMENTED_AND_EXECUTED` | create/resolve and active regression-eval generation                                              |
| Project/code adapter                                | `PARTIALLY_IMPLEMENTED`    | immutable Git commit inventory, imports/dependencies and deterministic links; no dynamic proof    |
| OpenTelemetry bridge and health                     | `IMPLEMENTED_AND_EXECUTED` | request trace/latency hooks and dependency-aware readiness                                        |
| Backup/restore                                      | `IMPLEMENTED_AND_EXECUTED` | 552 documents, 12 exact migrations, Git bundle and 22 MinIO archive entries recovered             |
| Obsidian plugin or Web Clipper                      | `DEFERRED`                 | vault remains readable in Obsidian; no companion plugin is claimed                                |
| OIDC, MFA and SSO                                   | `DEFERRED`                 | local scoped web sessions work; federated identity is not implemented                             |

## How the implemented path behaves

1. An operator imports the existing vault read-only or submits a source inside
   an allowlisted ingest root.
2. Import compiles identity, units and relations. Ingest hashes the bytes,
   writes the immutable MinIO object and creates a durable job.
3. The worker downloads that object, verifies its hash and uploads it through
   authenticated multipart. The extractor streams it to a temporary file,
   verifies the expected hash again, extracts typed artifacts and removes the
   temporary file.
4. The compiler classifies identity/materiality, generates a structured plan
   and creates an isolated Git draft when human review is required.
5. Approval verifies permissions, path scope, base revision and publication
   lock before squash merge. The platform reindexes and records audit/impact;
   failures use compensation and Error Book evidence.
6. A query is planned by intent. Retrieved candidates are fused, then filtered
   by RBAC, lifecycle, trust, freshness and contradiction policy before a
   bounded, revision-bearing ContextPacket is returned.

## Corrected failures

- Shared Git state once allowed rejected content to escape through a different
  approved review. Per-review worktrees, publication locking, base checks and a
  regression test replaced it.
- Regex-only code observations were incorrectly presented as proof. They now
  remain `NO_SIGNAL` unless a deterministic test-to-symbol link exists.
- Extraction once referenced a mutable source path. The worker now reads the
  immutable MinIO object, verifies it and uses authenticated multipart with a
  second extractor-side hash check.
- Copied transfer notes reused operational IDs and acquisition statuses. They
  now receive raw path-derived identities and archival lifecycle, while curated
  `LINK.md` maps are deliberately retained as useful recovery knowledge.
- Wikilinks alone produced a nearly untyped graph. Explicit dependency metadata
  now compiles into typed edges; ambiguous links remain `related_to`.
- Browser pages once depended on a long-lived server token. Opaque revocable
  sessions and CSRF enforcement now form the local browser boundary.

## Architecture and evidence limits

The Git merge and database projection update use compensation rather than one
atomic transaction. The retrieval gold set has only four cases. The local
deterministic embedding demonstrates adapter/index lifecycle, not modern
semantic quality. The platform does not implement OCR/vision, audio/video
transcription, federated identity, database RLS, Object Lock or dynamic code
proof. These limits are tracked in `REMAINING_REAL_GAPS.md` rather than hidden
by green smoke tests.
