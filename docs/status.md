# Product status

Architecture Knowledge Platform is under active pre-1.0 development. The v0.4 tree is a governed local-first Context Workspace / Context Fabric for humans and agents. It connects approved knowledge, software, work and runtime context while keeping provenance, authorization, revisioning and human review explicit.

## Supported today

- Multi-vault spaces, path-scoped authorization, human/service/agent principals and explicit revocation.
- Versioned Knowledge Profiles with validation, compatibility/impact analysis, activation and review-first interoperability.
- Team Context sessions with pinned revisions, claims, lease/fencing, structured handoffs, offline snapshots and governed promotion.
- A first-party Software Delivery Workspace Profile covering work, software, decisions, incidents, builds, deployments and tests.
- Read-only vault import, immutable source ingestion and structured Document Intelligence with optional provider adapters.
- Exact/alias and lexical retrieval, optional multilingual semantic retrieval, typed graph/code traversal, reranking and bounded ContextPackets.
- Federated graph domains for epistemic, software catalog, code, runtime, temporal, work and rebuildable community projections.
- Deterministic Code Graph querying for symbols, callers/callees, paths, explanation, impact, change-impact and tests.
- Append-only bi-temporal truth, point-in-time queries, support validation, supersession/invalidation and stale-derived suppression before fusion.
- Community/PPR, GLOBAL and DRIFT-style retrieval as derived orientation channels that never become citation authority.
- Typed bounded reasoning plans with allowlisted operators and deterministic fallback when a planner model is unavailable.
- Git-backed proposals, collaborative decision/review workflows, validation, publication and rollback.
- Continuous Assurance for grounding, freshness, contradictions, access boundaries and related maintenance findings.
- Generic connector capability contracts plus authenticated webhook/inbox ingestion, checkpoints, deletion and permission-fidelity semantics.
- Bounded federation with remote provenance, scope/version checks, timeout/circuit behavior and partial-result semantics.
- Role-aware model routing and residency policy with explicit fail-closed/degraded behavior.
- Human workspace views for active work, services, agent sessions, reviews, decisions, graph/temporal context, team administration and health.
- API, CLI and MCP surfaces over the same governed application rules.
- OpenTelemetry instrumentation, audit export, backup/restore, scale/concurrency and reproducible quality/evaluation workflows.

## Defaults and optional capabilities

The platform is conservative by default. Optional model, vector and document-intelligence providers are not silently enabled. Provider endpoints and credentials are deployment configuration, not source content. A provider may be available without being selected as the production default.

Graph, vector, community and model enhancements do not override authorization, lifecycle, temporal validity or support/truth checks. If an optional channel cannot satisfy those boundaries it is omitted or reported as degraded.

Imported vaults and connector payloads are external inputs. Source-specific curation belongs in explicit profiles, connector mappings or fixtures and must not alter generic platform behavior.

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
- Backup encryption, remote replication, WORM storage, OIDC/MFA and public-edge hardening remain deployment responsibilities.
- Federation evidence covers bounded team/organization nodes, not multi-region HA or global consensus.
- Registered public evaluation corpora are intentionally small and do not establish universal retrieval/agent superiority.
- PPR is an on-demand bounded retrieval operation rather than a durable background service.
- Late interaction is excluded from the production matrix rather than silently represented by another retrieval channel.
- Optional retrieval, model and extraction quality depends on the selected provider and corpus; unexecuted comparisons stay unmeasured.
- Human review remains the authority for canonical publication; generated content and provider responses are untrusted until validated and approved.

## Verification

Repository gates cover formatting, contracts, documentation, repository hygiene, type/unit checks, integration behavior, secret scanning and production builds. Additional maintained workflows exercise semantic retrieval, domain quality, Document Intelligence, team-node behavior, concurrency, resilience, scale, federation, long-context placement, agent behavior, recovery and same-revision final proof.

For the operating model, see the [Workspace Operating Model](guides/workspace-operating-model.md). For setup and operations, see [Operations & Recovery](guides/operations-recovery.md). For trust boundaries and residual risks, see the [threat model](security/threat-model.md).
