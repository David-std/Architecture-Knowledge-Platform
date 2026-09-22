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
- Append-only temporal truth with valid-time/recorded-time queries, pre-fusion derived-support validation and versioned truth-maintenance projections.
- Evaluation packs, retrieval benchmarks and regression tracking.
- Operator search, graph, source, job, review, evaluation and health views.
- OpenTelemetry instrumentation, audit export, backup and isolated restore workflows.

## Defaults and optional capabilities

The platform is conservative by default. Optional model, vector and document-intelligence providers are not silently enabled. Provider endpoints and credentials are deployment configuration, not source content. A provider may be available without being selected as the production default.

Imported vaults are treated as external inputs. Source-specific curation rules belong in explicit import profiles or fixtures and must not alter generic platform behavior.


## v0.4 release limitations

The v0.4 product surface is intentionally bounded. These limitations are part of the release contract rather than hidden follow-up work:

- The connector framework ships real local/Git and authenticated generic webhook/inbox paths. Additional vendor-specific live connectors remain optional integrations and are not implied by the generic connector contract.
- Community/global retrieval is implemented and benchmarked, but the registered public product corpus is small. Those measurements do not establish a universal production default or broad-corpus community quality guarantee.
- Code Graph extraction through Graphify is pinned to the provider version exercised by CI. Language coverage and extraction behavior are therefore version-bound to that tested provider rather than claimed for arbitrary Graphify releases.
- Federation proves bounded node discovery, remote query, provenance, scope enforcement, timeout/circuit behavior and a real two-node path. It is not a claim of multi-region high availability or globally replicated control-plane consensus.
- Late-interaction retrieval is not retained as a production channel in the registered v0.4 matrix. No latency, storage or quality advantage is claimed for a channel that was not adopted and comparably executed.
- Optional model and document providers remain environment-dependent. An unavailable optional provider must stay explicitly degraded or unproven rather than becoming a synthetic PASS.

## Known operational limits

- The default deployment is local-first and binds services to loopback. Direct hostile multi-tenant or internet exposure requires additional deployment controls.
- Authorization is enforced at the application layer; database row-level security is not the primary isolation boundary.
- Raw backups are integrity-checked but encryption and remote replication remain deployment responsibilities.
- Optional retrieval and extraction quality depends on the selected provider and corpus; synthetic or fixture benchmarks are not broad quality guarantees.
- Derived truth-maintenance projections are rebuildable operational state. Retrieval validates support against the captured truth revision before RRF even when that projection is missing or delayed; physical historical vectors/dependencies are not deleted to manufacture freshness.
- Human review remains the authority for canonical publication; generated content and provider responses are untrusted until validated and approved.

## Verification

Repository gates cover formatting, contracts, documentation, repository hygiene, type/unit checks, integration behavior, secret scanning and production builds. Runtime-focused changes are additionally exercised with disposable infrastructure, and recovery changes are validated by restoring PostgreSQL, object storage and managed Git into isolated resources.

For setup and operations, see [the local operations runbook](runbooks/local-operations.md). For trust boundaries and residual risks, see [the threat model](security/threat-model.md).
