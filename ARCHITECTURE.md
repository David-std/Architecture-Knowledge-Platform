# Architecture

Architecture Knowledge Platform is a generic, local-first, multi-vault system.
It keeps approved Markdown in Git as canonical compiled knowledge; PostgreSQL,
pgvector, graph relations, ContextPackets and operational state are derived or
rebuildable projections. Immutable source bytes live in content-addressed
object storage and remain separate from imported vaults.

## System boundary

- `apps/api` exposes authenticated HTTP use cases and policy enforcement.
- `apps/worker` runs durable ingest and event consumers with leases, fencing,
  retries, quarantine and reconciliation.
- `apps/extractor` implements the provider-neutral Document Intelligence port.
- `apps/mcp` and `apps/cli` are bounded clients of the same application rules.
- `apps/web` provides human search, ingest, review and operational views.
- `packages/*` contain domain, storage, retrieval, indexing, compilation,
  publication and contract adapters; dependency rules are enforced by
  Dependency Cruiser.

## Canonical data flow

```text
registered vault (read-only import) or immutable source
  -> canonical document artifact and evidence locators
  -> grounded compilation plan and isolated Git draft
  -> deterministic validation and human review
  -> approved Git publication or reviewed rollback
  -> durable lifecycle events
  -> incremental lexical/vector/graph/context projections
  -> bounded ContextPacket for humans and agents
```

Normal publication queues incremental work through the PostgreSQL outbox. Full
reindex remains an explicit repair operation, not the normal write path. Every
query resolves an authorized scope; cross-vault federation is explicit opt-in.
Optional semantic/document providers may degrade without changing canonical
knowledge or bypassing review.

## Reconciled implementation line

The maintained product branch combines the hardened causal-event, retrieval,
compiler and security foundations with the document-intelligence, operator,
observability, recovery and repository-productization work. Shared contracts are
resolved in-place rather than by maintaining parallel runtime variants: the
outbox, authorization and validation rules remain canonical while later
capabilities consume those same boundaries.

This means the product has one supported execution path for ingestion,
publication, projection, retrieval and recovery. Historical working branches
remain useful as provenance, but they are not independent product variants and
must not be used as runtime sources of truth.

## Detailed views

- [C4 model](docs/architecture/c4.md)
- [Module boundaries](docs/architecture/modules.md)
- [Runtime flows](docs/architecture/runtime-flows.md)
- [Database ERD](docs/architecture/database-erd.md)
- [Audit export](docs/architecture/audit-export.md)
- [Threat model](docs/security/threat-model.md)
- [Architecture decisions](docs/adr/)
- [Current executed status](docs/status.md)

Registered vaults are consumers of the platform, not product-core defaults or
runtime write targets.
