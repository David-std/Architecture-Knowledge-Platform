# Architecture

Architecture Knowledge Platform is a local-first governed Context Workspace and Context Fabric. It preserves one canonical approved knowledge layer while composing multiple explicit operational representations for retrieval, software structure, work, runtime observations and temporal truth.

Approved Markdown in managed Git is canonical knowledge. Immutable source bytes remain separate. PostgreSQL, pgvector, graph projections, code graphs, community/PPR state, ContextPackets and caches are operational or derived state.

## Product planes

```text
DATA / CONTEXT PLANE
  sources, approved knowledge, indexes, specialized graphs, connectors

WORKSPACE COORDINATION PLANE
  work contexts, sessions, claims, leases, findings, blockers, artifacts, handoffs

GOVERNANCE / CONTROL PLANE
  principals, authorization, profiles, review/publication, temporal truth,
  model residency, audit, assurance, observability and federation policy
```

The coordination plane is not canonical knowledge. External systems of record retain authority for the objects they own.

## Specialized graph model

AKP deliberately avoids one semantically ambiguous graph. The federated graph substrate keeps these domains distinct:

- **Epistemic** — sources, evidence, claims, rules, decisions, support and contradiction.
- **Software Catalog** — declared systems, services, components, APIs, resources and owners.
- **Code** — symbols, definitions, references, calls, imports, tests and immutable Git locators.
- **Runtime** — observed service calls, deployments, test/runtime evidence and incidents.
- **Temporal** — facts and events with valid-time and recorded-time semantics.
- **Work** — goals, work items, pull requests, sessions, people/agents and activity.
- **Community** — rebuildable community, centrality, PPR and derived-summary projections.

Cross-domain relations are typed and provenance-bearing. Catalog declaration, static code structure and runtime observation may disagree; AKP preserves that disagreement instead of flattening it.

## Runtime components

- `apps/api` — authenticated use cases, authorization, retrieval/planning and policy enforcement.
- `apps/worker` — durable ingest, compilation, projection, assurance and event consumers with leases/fencing/retry.
- `apps/extractor` — provider-neutral Document Intelligence boundary.
- `apps/web` — human workspace and operator surfaces.
- `apps/mcp` and `apps/cli` — bounded clients of the same application rules.
- `packages/*` — domain, persistence, retrieval, graph, code, evaluation and publication modules.
- `contracts/` — versioned API/event contracts.
- `db/` — append-only migrations.

Dependency boundaries are enforced by repository gates rather than by convention alone.

## Canonical and work flow

```text
external system / registered vault / immutable source
  -> authenticated reference or immutable artifact
  -> authorized retrieval / workspace orientation
  -> work context + pinned ContextRevisionSet
  -> findings / code-runtime evidence / decision candidates
  -> governed promotion candidate
  -> deterministic validation + human review
  -> approved managed-Git publication
  -> durable causal events
  -> rebuild/update derived indexes and specialized graphs
  -> truth/support validation before fusion
  -> bounded ContextPacket for humans and agents
```

Capture is not publication. A model may extract, rank, summarize or propose, but it cannot approve its own proposal, invent authorization, upgrade evidence or execute arbitrary SQL/Cypher/shell/filesystem writes.

## Retrieval and reasoning boundary

Normal retrieval resolves the principal and permitted scope before candidate expansion. It may combine exact/alias, lexical, optional dense, code/symbol, typed graph, temporal, PPR/community and raw/source channels. Truth/freshness validation happens before fusion/rerank.

Reasoning uses a typed, bounded plan with allowlisted operators. Provider output is untrusted input to that plan; it is not an executable command language.

Every strict task can pin a `ContextRevisionSet`. Meaningful changes in truth/profile/policy/index authority are surfaced rather than silently mixed into the task.

## Deployment and federation

`SOLO_LOCAL`, small-team Git synchronization of canonical files, `TEAM_NODE` and `FEDERATED_ORG` are distinct deployment modes.

A Team Node owns shared writable coordination/derived state; clients do not Git-sync PostgreSQL. Federation keeps peer provenance, trust, revision and scope identity and applies local authorization before merged results become usable context.

Optional model/provider routing follows the most restrictive applicable residency policy. An external fallback cannot relax a `LOCAL_ONLY` source, space, organization or profile boundary.

## Recovery boundary

Durable/canonical state is backed up; derived projections are rebuildable. Restore verification covers PostgreSQL, object storage, managed Git and representative rebuilt context.

Projection IDs may change after rebuild when they are explicitly derived, but deterministic semantic outputs must remain equivalent where the product promises determinism.

## Detailed views

- [C4 model](docs/architecture/c4.md)
- [Module boundaries](docs/architecture/modules.md)
- [Runtime flows](docs/architecture/runtime-flows.md)
- [Database ERD](docs/architecture/database-erd.md)
- [Context Fabric](docs/context-fabric.md)
- [Workspace Operating Model](docs/guides/workspace-operating-model.md)
- [Graph Model](docs/guides/graph-model.md)
- [Retrieval & Context Engineering](docs/guides/retrieval-context-engineering.md)
- [Threat model](docs/security/threat-model.md)
- [Architecture decisions](docs/adr/)
- [Current product status](docs/status.md)
