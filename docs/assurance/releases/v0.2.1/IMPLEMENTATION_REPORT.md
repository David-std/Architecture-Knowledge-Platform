# Implementation report

## Outcome

The repository is an executable, agent-neutral, multivault knowledge platform.
It registers vaults explicitly, imports canonical material read-only, ingests
immutable sources, extracts canonical `DocumentArtifact` structures, publishes
reviewed Git changes through a durable event pipeline, maintains incremental
retrieval projections and serves bounded knowledge through API, CLI, Web and 21
MCP tools. The validated local baseline is recorded by the annotated tag
`v0.2.1-platform-validation`.

## Capability status

| Capability                                 | Status                     | Evidence                                                                                                 |
| ------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Monorepo, strict TypeScript and boundaries | `IMPLEMENTED_AND_EXECUTED` | lint/typecheck/build; stable source scan cruised 158 modules and 390 dependencies without violations     |
| VaultRegistry and multivault isolation     | `IMPLEMENTED_AND_EXECUTED` | explicit vault scope, memberships, visibility, eval packs; real two-vault isolation test                 |
| Append-only PostgreSQL schema              | `IMPLEMENTED_AND_EXECUTED` | migrations `001`–`018` applied fresh, rerun idempotently and restored in isolation                       |
| Durable outbox and consumers               | `IMPLEMENTED_AND_EXECUTED` | immutable envelopes, delivery leases/fencing, retry, quarantine, requeue and reconciliation tests        |
| Incremental index activation               | `IMPLEMENTED_AND_EXECUTED` | changed/tombstoned documents only; real-DB incremental/multivault tests and product E2E                  |
| Canonical `DocumentArtifact`               | `IMPLEMENTED_AND_EXECUTED` | version/hash/media/locator checks, persistence and worker draft generation                               |
| Deterministic media adapters               | `IMPLEMENTED_AND_EXECUTED` | Markdown/code/HTML/PDF/DOCX/PPTX/XLSX/image metadata; nine fixture executions                            |
| Docling/Marker/Chunkr                      | `CONTRACT_ONLY`            | adapters and routing are explicit; unavailable candidates return `CAPABILITY_NOT_CONFIGURED`             |
| OCR/vision/audio/video                     | `CONTRACT_ONLY`            | no fabricated content; capability remains unavailable                                                    |
| Structural chunking/rehydration            | `IMPLEMENTED_AND_EXECUTED` | containers plus atomic tables/figures/equations/code/rules/evidence; dossier containers are not embedded |
| Retrieval/evaluation framework             | `IMPLEMENTED_AND_EXECUTED` | generic and curated fixture packs; 19 generic plus 13 curated cases; exact matrix scorer                 |
| Production retrieval default               | `DEFERRED`                 | offline evidence is synthetic; default remains `null`, vector disabled                                   |
| Git review/publication                     | `IMPLEMENTED_AND_EXECUTED` | immutable reviewed head, isolated worktrees, serialized decision and seven outbox events                 |
| API/CLI/Web/MCP                            | `IMPLEMENTED_AND_EXECUTED` | 51 OpenAPI paths, 21/21 MCP, live CLI, authenticated Web smoke and 18-route Next build                   |
| Synthetic scale                            | `IMPLEMENTED_AND_EXECUTED` | isolated 1K/10K/50K/100K PostgreSQL fixture with measured queries, packet builder and cleanup            |
| Sanitized audit export                     | `IMPLEMENTED_AND_EXECUTED` | deterministic ZIP/manifests, limits, redaction and audit event                                           |
| Raw evidence export                        | `PARTIALLY_IMPLEMENTED`    | verified/bounded endpoint and safe CLI; disabled by default; no MCP binary transfer                      |
| Backup/restore                             | `IMPLEMENTED_AND_EXECUTED` | v3 artifacts hash-verified; populated and empty 18-migration restores passed                             |
| Repository hygiene                         | `IMPLEMENTED_AND_EXECUTED` | 340 files deterministically classified; secret scan and clean-checkout reproduction passed               |
| Generic vault import profiles              | `IMPLEMENTED_AND_EXECUTED` | generic fixture and explicit legacy profile tests keep vault-specific curation opt-in                    |
| Distributed observability                  | `PARTIALLY_IMPLEMENTED`    | durable lifecycle evidence exists; local OTel provider/exporter and workflow-specific metrics are absent |
| OIDC/MFA/SSO, HA and RLS                   | `DEFERRED`                 | local scoped tokens/sessions only                                                                        |

## Runtime flow

1. An operator registers a vault with stable identity, roots, schema profile,
   retrieval configuration, visibility, permissions and eval pack.
2. Read-only import or immutable source ingestion always carries `vaultId`.
   Source bytes are content-addressed in MinIO.
3. The worker verifies bytes and invokes the configured document-intelligence
   adapter. The canonical artifact preserves structures, reading order,
   locators, warnings, hashes and extractor configuration.
4. Compiled knowledge becomes an isolated review draft. Approval verifies the
   reviewed commit and commits review state plus vault-scoped lifecycle events.
5. Durable consumers claim deliveries with leases and fencing. The indexer
   rebuilds only changed units/edges, invalidates affected packets and activates
   index revisions after successful completion.
6. Search requires explicit vault scope. Hierarchical candidates are fused and
   filtered by permissions, lifecycle, trust, freshness and contradiction
   policy before a revision-bearing ContextPacket is persisted.
7. Audit metadata can be exported as a sanitized deterministic bundle. Raw
   evidence requires separate confirmation and remains deployment-disabled by
   default.

## Important corrected defects

- Scoped API tokens no longer expand privileges when exchanged for web
  sessions.
- Idempotency identity now includes credential scope and concrete request URL;
  uncertain expired claims are not replayed. Current vault enabled/visibility
  state and inherited grants are re-fingerprinted before replay.
- Whole-space/pathless endpoints require unrestricted scope, while private
  vault discovery is membership-aware.
- Publication no longer performs normal-path synchronous full reindexing.
- Repeated identical structural blocks now receive stable distinct unit keys,
  preventing unique-key failure during rebuild.
- Rebuilds remove legacy pre-registry units by document identity, avoiding
  collisions after the VaultRegistry migration.
- Tombstone-only indexing does not create empty embedding generations.
- Raw evidence cannot be returned through MCP or written outside approved CLI
  roots.
- Automatic worker reviews now retain their vault identity, and the indexer
  resolves reviewed paths stored either at repository root or under
  `managed/`.
- Protected Web pages redirect unauthenticated requests to `/login` instead of
  surfacing the API authentication boundary as HTTP 500.
- The outbox crash-recovery integration now isolates its disposable consumer
  deliveries instead of draining unrelated historical events under a global
  timeout.
- Migration 018 and the runtime gate enforce outcome-aware outbox-attempt
  uniqueness, preserving `CLAIMED` and terminal outcomes for the same attempt.

## Honest limitations

The platform remains a controlled local candidate. Optional document
intelligence backends and production semantic retrieval have not been selected;
enterprise identity/HA/RLS/object lock are absent; raw export is disabled; the
remaining fixture benchmarks do not establish production capacity or semantic
quality. Effective distributed tracing is not configured. See
`REMAINING_REAL_GAPS.md`.
