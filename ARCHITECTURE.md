# Architecture

Architecture Knowledge Platform is a generic, local-first, multi-vault system.
It keeps approved Markdown in Git as canonical compiled knowledge; PostgreSQL,
pgvector, graph relations, context packets and operational state are derived or
rebuildable projections. Immutable source bytes live in content-addressed
object storage and remain separate from the imported Obsidian vault.

## System boundary

- `apps/api` exposes authenticated HTTP use cases and policy enforcement.
- `apps/worker` runs durable ingest and event consumers with leases, fencing,
  retries, quarantine and reconciliation.
- `apps/extractor` implements the provider-neutral Document Intelligence port.
- `apps/mcp` and `apps/cli` are bounded clients of the same application rules.
- `apps/web` provides human search, ingest, review and operational views.
- `packages/*` contain domain, storage, retrieval, indexing, publication and
  contract adapters; dependency rules are enforced by Dependency Cruiser.

## Canonical data flow

```text
registered vault (read-only import) or immutable source
  -> canonical document artifact and evidence locators
  -> compilation plan and isolated Git draft
  -> deterministic validation and human review
  -> approved Git merge
  -> transactional lifecycle events
  -> incremental lexical/vector/graph/context projections
  -> bounded ContextPacket for humans and agents
```

Normal publication queues incremental work through the PostgreSQL outbox. Full
reindex remains an explicit repair operation, not the normal write path. Every
query resolves an authorized vault scope; cross-vault federation is opt-in.

## Detailed views

- [C4 model](docs/architecture/c4.md)
- [Module boundaries](docs/architecture/modules.md)
- [Runtime flows](docs/architecture/runtime-flows.md)
- [Database ERD](docs/architecture/database-erd.md)
- [Audit export](docs/architecture/audit-export.md)
- [Threat model](docs/security/threat-model.md)
- [Architecture decisions](docs/adr/)

The external Architecture Knowledge System vault is one registered consumer and
fixture pack. It is not the product core and is never a runtime write target.
