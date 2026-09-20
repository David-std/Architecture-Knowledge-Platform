# Graph Model Guide

## What this feature is

AKP maintains a federated graph substrate as derived, rebuildable context state. It does not replace governed Markdown, source evidence or external systems of record.

The graph keeps domains distinct: `EPISTEMIC`, `SOFTWARE_CATALOG`, `CODE`, `RUNTIME`, `TEMPORAL`, `WORK` and `COMMUNITY`. Nodes are revisioned identities; edges carry typed relations and provenance describing derivation, source/evidence references, revision, time and optional confidence.

## When to use it

Use graph queries when a task needs bounded multi-hop relationships, change impact, dependency paths, cross-domain context or structural evidence that is not represented well by plain lexical retrieval.

Use direct source/truth retrieval when a single authoritative fact is enough. A graph score or path is supporting context, not an authority upgrade.

## Configuration

### Specialized domain vocabulary

The public contract keeps domain-specific vocabulary instead of treating every graph as anonymous `type` strings. The Software Catalog domain defines the canonical kinds `domain`, `system`, `service`, `component`, `api`, `resource`, `repository`, `team` and `person`, plus the relations `part_of`, `owned_by`, `provides`, `consumes`, `depends_on` and `implemented_by`. Catalog assertions are declared or curated state; they are not relabeled as live runtime topology.

The Runtime domain separately defines deployments, environments, runtime services, traces/spans or aggregated runtime calls, test/coverage observations and incident/alert references. Runtime observations carry an observation timestamp or bounded window, and include source revision/deployment identifiers when those are available. Missing a runtime call in one observation window remains an observation of absence for that window; it does not erase or negate a declared catalog dependency.

### Capability catalog

The federated graph store derives a permission-aware catalog from durable projection revisions instead of assuming every graph domain exists. Catalog entries expose domain/scope, active and source revisions, builder/version, a deterministic configuration hash, lifecycle-derived status, capabilities and last successful build. Path-scoped callers see an entry only when the projection contains at least one node inside their authorized prefix; a catalog lookup therefore cannot reveal a hidden repository or graph scope merely because its projection exists.

`READY` is directly usable. `BUILDING` keeps an existing active revision visible while a replacement is being built. `DEGRADED` reports a failed replacement while preserving a usable active revision. `STALE` and `UNAVAILABLE` fail closed for strict consumers. Project code retrieval consults this catalog before telling the query planner that the code channel is available; it no longer assumes that a `CODE` projection exists.

Graph queries require an authorized space/vault scope, allowed graph domains, a relation allowlist, direction, freshness policy and hard traversal bounds.

Runtime bounds include maximum hops, fanout, candidates and time budget. Search also applies hard caps before executing recursive expansion.

Graph projection revisions record source revision, provider, provider/configuration version, lifecycle and freshness. An active revision remains authoritative for graph reads until a replacement is built and activated.

## Normal workflow

1. Build or update a graph projection from source state.
2. Validate the artifact and persist a projection revision.
3. Activate a successful revision.
4. Query nodes, neighbors, paths or impact with an authorized scope.
5. Return revision metadata and provenance with the path.
6. Mark an old projection stale when its source authority changes and rebuild it through the supported projection path.

Retrieval may combine graph candidates with exact, lexical, vector, code and community channels using bounded ranking/fusion.

## Security and governance boundaries

Authorization is applied before graph traversal and every returned node remains within the permitted vault/path scope. Traversal cannot hop through an unauthorized node to reach an otherwise visible target.

Relation allowlists and graph-domain allowlists constrain expansion. Arbitrary model-generated Cypher is not accepted as an execution path.

Provenance records how a relationship was derived, such as source-explicit, deterministic extraction, static resolution, runtime observation or model inference. A derived or model-inferred relationship does not become canonical truth merely because it exists in a graph.

Relationships that carry evidence, temporal validity, confidence or review state are persisted as first-class relationship assertions. The structural edge references that assertion; the assertion owns its lifecycle and provenance. Multiple assertions may describe the same endpoints and relation without being collapsed, so disputed or independently supported relationships remain inspectable instead of being flattened into one edge property bag. Current traversal accepts active and disputed assertions, while superseded or retired assertions do not become current paths.

## Degraded and offline behavior

`FRESH_ONLY` queries exclude stale graph revisions. When graph state is unavailable or stale, retrieval can continue through other permitted channels and must report degradation rather than fabricate graph evidence.

Community and PPR results are derived orientation/ranking signals. They do not create evidence, trust or publication authority.

## Failure and recovery

A failed graph build does not replace the active good revision. The revision lifecycle separates requested, built, active, stale and failed states.

Graph projections are rebuildable from canonical/source state. The integration recovery fixture deletes projection rows, nodes, edges and relationship assertions, rebuilds the same deterministic source artifact, and requires normalized semantic graph equivalence; generated database UUIDs are not treated as graph meaning. Backup manifests classify graph nodes/edges and community projections as derived state; after restore, run the supported projection rebuild and verify graph-domain health with `pnpm akp doctor --format human`.

## Example

A change-impact request can seed a CODE symbol, follow a typed dependency path into SOFTWARE_CATALOG and EPISTEMIC context, and return the affected rule or decision with the exact projection revisions and edge provenance used. The caller can then inspect the cited authority instead of treating the path score as truth.

## Limitations

Graph coverage depends on available projection providers and source structure. The current Graphify adapter covers code extraction but does not make every language/runtime relation provable.

Derived graph history is retained for reproducibility and recovery; AKP does not delete historical edges merely to make a stale condition disappear.
