# Implementation report

## Outcome

The repository is now an executable, agent-neutral, multivault knowledge
platform. It registers vaults explicitly, imports canonical material read-only,
ingests immutable sources, extracts canonical `DocumentArtifact` structures,
publishes reviewed Git changes through a durable event pipeline, maintains
incremental retrieval projections and serves bounded knowledge through API,
CLI, Web and 20 MCP tools.

## Capability status

| Capability                                 | Status                     | Evidence                                                                                                 |
| ------------------------------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------- |
| Monorepo, strict TypeScript and boundaries | `IMPLEMENTED_AND_EXECUTED` | lint/typecheck/build; 558 modules and 823 dependencies without boundary violations                       |
| VaultRegistry and multivault isolation     | `IMPLEMENTED_AND_EXECUTED` | explicit vault scope, memberships, visibility, eval packs; real two-vault isolation test                 |
| Append-only PostgreSQL schema              | `IMPLEMENTED_AND_EXECUTED` | migrations `001`–`016` applied fresh and restored exactly                                                |
| Durable outbox and consumers               | `IMPLEMENTED_AND_EXECUTED` | immutable envelopes, delivery leases/fencing, retry, quarantine, requeue and reconciliation tests        |
| Incremental index activation               | `IMPLEMENTED_AND_EXECUTED` | changed/tombstoned documents only; revision activation after success; four real-DB tests                 |
| Canonical `DocumentArtifact`               | `IMPLEMENTED_AND_EXECUTED` | version/hash/media/locator checks, persistence and worker draft generation                               |
| Deterministic media adapters               | `IMPLEMENTED_AND_EXECUTED` | Markdown/code/HTML/PDF/DOCX/PPTX/XLSX/image metadata; nine fixture executions                            |
| Docling/Marker/Chunkr                      | `CONTRACT_ONLY`            | adapters and routing are explicit; unavailable candidates return `CAPABILITY_NOT_CONFIGURED`             |
| OCR/vision/audio/video                     | `CONTRACT_ONLY`            | no fabricated content; capability remains unavailable                                                    |
| Structural chunking/rehydration            | `IMPLEMENTED_AND_EXECUTED` | containers plus atomic tables/figures/equations/code/rules/evidence; dossier containers are not embedded |
| Retrieval/evaluation framework             | `IMPLEMENTED_AND_EXECUTED` | generic eval packs, 19 cases/slices, exact ten-configuration scorer                                      |
| Production retrieval default               | `DEFERRED`                 | offline evidence is synthetic; default remains `null`, vector disabled                                   |
| Git review/publication                     | `IMPLEMENTED_AND_EXECUTED` | immutable reviewed head, isolated worktrees, serialized decision and seven outbox events                 |
| API/CLI/Web/MCP                            | `IMPLEMENTED_AND_EXECUTED` | 50 OpenAPI paths, 20 MCP tools, CLI commands and successful Next build                                   |
| Sanitized audit export                     | `IMPLEMENTED_AND_EXECUTED` | deterministic ZIP/manifests, limits, redaction and audit event                                           |
| Raw evidence export                        | `PARTIALLY_IMPLEMENTED`    | verified/bounded endpoint and safe CLI; disabled by default; no MCP binary transfer                      |
| Backup/restore                             | `IMPLEMENTED_AND_EXECUTED` | exact 16 migrations, 555 documents, MinIO and Git bundle restored                                        |
| Repository hygiene                         | `IMPLEMENTED_AND_EXECUTED` | 319/319 tracked/untracked candidate files classified with zero unknown                                   |
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
  uncertain expired claims are not replayed.
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

## Honest limitations

The platform remains a controlled local release candidate. Optional document
intelligence backends and production semantic retrieval have not been selected;
enterprise identity/HA/RLS/object lock are absent; raw export is disabled; and
the final merge/tag is pending. See `REMAINING_REAL_GAPS.md`.
