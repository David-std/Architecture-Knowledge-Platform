# Graph Model Guide

## What this feature is

AKP maintains a federated graph substrate as derived, rebuildable context state. It does not replace governed Markdown, source evidence or external systems of record.

The graph keeps domains distinct: `EPISTEMIC`, `SOFTWARE_CATALOG`, `CODE`, `RUNTIME`, `TEMPORAL`, `WORK` and `COMMUNITY`. Nodes are revisioned identities; edges carry typed relations and provenance describing derivation, source/evidence references, revision, time and optional confidence.

## When to use it

Use graph queries when a task needs bounded multi-hop relationships, change impact, dependency paths, cross-domain context or structural evidence that is not represented well by plain lexical retrieval.

Use direct source/truth retrieval when a single authoritative fact is enough. A graph score or path is supporting context, not an authority upgrade.

## Configuration

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

Provenance records how an edge was derived, such as source-explicit, deterministic extraction, static resolution, runtime observation or model inference. A derived or model-inferred edge does not become canonical truth merely because it exists in a graph.

## Degraded and offline behavior

`FRESH_ONLY` queries exclude stale graph revisions. When graph state is unavailable or stale, retrieval can continue through other permitted channels and must report degradation rather than fabricate graph evidence.

Community and PPR results are derived orientation/ranking signals. They do not create evidence, trust or publication authority.

## Failure and recovery

A failed graph build does not replace the active good revision. The revision lifecycle separates requested, built, active, stale and failed states.

Graph projections are rebuildable from canonical/source state. Backup manifests classify graph nodes/edges and community projections as derived state; after restore, run the supported projection rebuild and verify graph-domain health with `pnpm akp doctor --format human`.

## Example

A change-impact request can seed a CODE symbol, follow a typed dependency path into SOFTWARE_CATALOG and EPISTEMIC context, and return the affected rule or decision with the exact projection revisions and edge provenance used. The caller can then inspect the cited authority instead of treating the path score as truth.

## Limitations

Graph coverage depends on available projection providers and source structure. The current Graphify adapter covers code extraction but does not make every language/runtime relation provable.

Derived graph history is retained for reproducibility and recovery; AKP does not delete historical edges merely to make a stale condition disappear.
