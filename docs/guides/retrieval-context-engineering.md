# Retrieval and Context Engineering Guide

## What this feature is

AKP retrieval combines bounded exact, lexical, optional vector, graph, code, community/PPR and reasoning-assisted channels into source-backed search results and `ContextPacket` outputs.

The system separates candidate generation, policy filtering, ranking/fusion and context assembly. Citations, revision metadata, gaps, conflicts and degradation warnings travel with the result so callers can distinguish evidence from ranking signals.

## When to use it

Use `/v1/search` for ranked evidence/document lookup. Use `/v1/context` or the agent façade when a task needs a bounded packet that combines evidence, policy context, conflicts, required actions and continuation handles.

Use temporal, code or impact-specific actions when the question has those semantics rather than relying on a broad conceptual query.

## Configuration

Search requests define query/intent, authorized space/vault scope, minimum trust, mode, limit and optional channel requirements.

`AKP_VECTOR_ENABLED` controls optional vector retrieval. Embedding generations are versioned; a query uses the compatible active generation or degrades explicitly.

Graph traversal is bounded by hops, fanout, candidates and time. Community/PPR policies bound nodes, iterations, allowed domains/relations, score threshold and per-scope caps.

Context packets enforce token/budget constraints and support compact/full modes plus continuation rather than unbounded vault loading.

## Normal workflow

1. Resolve the caller's authorized vault/path scope.
2. Plan the query from intent and available capabilities.
3. Run enabled candidate channels independently.
4. Filter by lifecycle, trust, authorization, freshness and temporal support.
5. Fuse/rerank bounded candidates.
6. Assemble a context packet with citations, conflicts, gaps, actions and revision metadata.
7. Revalidate captured truth/context revision when strict consistency requires it.

Query transformations and reasoning plans may improve retrieval, but their output is validated before execution and cannot introduce arbitrary SQL/Cypher operators.

## Security and governance boundaries

Authorization filtering precedes graph/vector/community expansion. A high score cannot override scope, lifecycle, trust or support policy.

Retrieved content is untrusted data. Ranking, community membership, PPR and model reasoning do not create canonical facts.

Context packets expose bounded locators/citations and sanitize unsafe local-path/provider details at product boundaries.

## Degraded and offline behavior

Optional channels can fail independently. The response records requested/effective channels and warnings while deterministic permitted channels continue.

If vector generation is absent or incompatible, lexical/graph paths may still serve the request. If strict truth/context revision changes during execution, the operation fails or restarts rather than mixing revisions.

Offline snapshots retain a bounded packet at a pinned revision; stale snapshots disclose staleness and do not masquerade as fresh retrieval.

## Failure and recovery

Vector, graph, community and context-packet state are rebuildable. Durable canonical/source/truth state remains the recovery authority.

After a restore or large source/profile change, rebuild affected projections and use doctor plus retrieval diagnostics to confirm revision parity.

Provider/model unavailability should surface as a safe code/warning, not raw credentials, source content or endpoint details.

## Example

A conceptual question may combine lexical evidence with a community-oriented candidate and an approved graph relation. RRF/reranking determines ordering, but the answer is grounded only in returned citations/support. If the community index is stale, that channel is omitted or flagged rather than granting extra confidence.

## Limitations

Benchmark scores are corpus- and configuration-specific. They do not prove universal superiority over another retrieval architecture.

PPR currently executes on demand and does not have a durable job lifecycle. Cancellation is cooperative for the operation rather than a queued-job cancellation contract.
