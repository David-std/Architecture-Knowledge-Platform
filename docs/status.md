# Product status

Architecture Knowledge Platform is under active pre-1.0 development. The current tree provides the complete local workflow for ingesting sources, compiling reviewed knowledge, querying it through bounded retrieval and operating the system through API, Web, CLI and MCP surfaces.

## Supported today

- Multi-vault registration, membership and path-scoped authorization.
- Read-only vault import and immutable source ingestion.
- Deterministic extraction for supported local document types with optional provider adapters.
- Lexical retrieval, optional semantic retrieval, graph traversal and bounded context packets.
- Git-backed proposals, review, validation, publication and rollback.
- Durable jobs, event delivery, retries, quarantine and reconciliation.
- Incremental lexical/vector/graph/context projection updates.
- Evaluation packs, retrieval benchmarks and regression tracking.
- Operator search, graph, source, job, review, evaluation and health views.
- OpenTelemetry instrumentation, audit export, backup and isolated restore workflows.

## Unified implementation state

The active product line now contains both previously parallel completion tracks in one history: the hardened event/retrieval/compiler/security foundation and the later document-intelligence/operator/observability/recovery/productization work. The integration keeps a single set of runtime contracts rather than parallel implementations, and the merged tree is the only candidate that should advance toward final validation.

The historical working branches remain comparison and provenance points until final validation completes; they are not separate supported product variants.

## Defaults and optional capabilities

The platform is conservative by default. Optional model, vector and document-intelligence providers are not silently enabled. Provider endpoints and credentials are deployment configuration, not source content. A provider may be available without being selected as the production default.

Imported vaults are treated as external inputs. Source-specific curation rules belong in explicit import profiles or fixtures and must not alter generic platform behavior.

## Known operational limits

- The default deployment is local-first and binds services to loopback. Direct hostile multi-tenant or internet exposure requires additional deployment controls.
- Authorization is enforced at the application layer; database row-level security is not the primary isolation boundary.
- Raw backups are integrity-checked but encryption and remote replication remain deployment responsibilities.
- Optional retrieval and extraction quality depends on the selected provider and corpus; synthetic or fixture benchmarks are not broad quality guarantees.
- Human review remains the authority for canonical publication; generated content and provider responses are untrusted until validated and approved.

## Verification

Repository gates cover formatting, contracts, documentation, repository hygiene, type/unit checks, integration behavior, secret scanning and production builds. Runtime-focused changes are additionally exercised with disposable infrastructure, and recovery changes are validated by restoring PostgreSQL, object storage and managed Git into isolated resources.

For setup and operations, see [the local operations runbook](runbooks/local-operations.md). For trust boundaries and residual risks, see [the threat model](security/threat-model.md).
