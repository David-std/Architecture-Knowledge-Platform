# Federation Guide

## What this feature is

AKP federation lets independently authorized nodes discover peers and, in `FEDERATED_ORG` mode, execute bounded remote queries without merging writable databases or upgrading remote trust.

Supported discovery modes are `CATALOG_ONLY`, `REMOTE_QUERY` and the reserved `MIRROR_BUNDLE`. The current executable federation path is remote query; mirror import is not advertised as an executed capability until its import/revocation semantics are implemented.

## Node boundary

```text
┌──────────────────┐      bounded remote query      ┌──────────────────┐
│ Team Node A      │ ─────────────────────────────▶ │ Team Node B      │
│ local authority  │ ◀───────────────────────────── │ local authority  │
└────────┬─────────┘   provenance + remote revision └────────┬─────────┘
         │                                                    │
         └──────────── local authorization remains ───────────┘

Remote trust is preserved; it is never silently upgraded to local trust.
```

## When to use it

Use federation when separate Team Nodes must remain operationally independent but need explicitly authorized cross-node context. Use ordinary multi-vault retrieval when the data belongs to one node and one authorization authority.

Do not use federation as a database replication mechanism or as a way to bypass local scope rules.

## Configuration

Run participating nodes in `FEDERATED_ORG` with stable node identities. Register peers with endpoint, discovery mode, trust state, Context API version, bounded capability metadata and an optional `credentialRef`. A peer registration is scoped to its persisted `spaceId`; that space and the single `discoveryMode` are the allowed scope/mode contract for outbound use.

`credentialRef` is the name of an environment variable resolved by the API process. The token itself is not stored in PostgreSQL and is not returned by peer APIs.

Peer endpoints reject embedded credentials, query strings and fragments. HTTPS is required except for loopback HTTP development endpoints.

Remote-query schema version 1 carries caller node/request identity, requested space/vault scope, query, budget and optional revision preferences. Before resolving a peer credential or contacting its endpoint, AKP verifies that the requested space matches the peer's persisted scope and that the requested schema version matches the peer's persisted Context API version.

## Normal workflow

1. Register a peer as discovery metadata without implicit network contact.
2. Approve the peer explicitly and configure its credential reference.
3. Issue a bounded remote query or bounded fanout request.
4. The remote node authenticates the credential through its normal authorization path and reuses local search.
5. The response carries node identity, node revision, scope, partial/stale warnings and per-hit remote provenance.
6. The caller verifies request ID, remote node identity, returned scope and schema before accepting the response.
7. Audit records the federation action without persisting the query text or credential.

Fanout runs local search plus at most four explicit peer requests. A failed optional peer yields a partial response; `requireAllPeers` converts peer failure into a global failure.

## Security and governance boundaries

Remote trust and lifecycle values are preserved exactly. The federation contract rejects attempts to upgrade or rewrite them.

Every remote query is authorized by the destination node. Caller-supplied scope is a request, not authority.

Response bytes and wall time are bounded. Peer IDs, secrets and high-cardinality identifiers are not used as telemetry metric labels.

Peer revocation sets the peer to `DISABLED`, removes its credential reference and emits durable audit/outbox evidence. It does not delete the external secret from the operator's secret store.

## Degraded and offline behavior

Repeated failures open a durable circuit breaker with bounded backoff. While open, AKP returns `Retry-After` instead of repeatedly contacting the peer.

Remote responses may be marked partial or stale. A local result remains usable when optional peers fail; a caller that requires all peers must opt into that stricter behavior.

An incompatible federation schema version fails with an explicit version error rather than being treated as a generic payload failure.

## Failure and recovery

Peer health state and credential references are durable PostgreSQL state and are included in the backup contract. Secret material remains external.

After restore, doctor reports open/degraded peer circuits. Operators should revalidate the referenced secret environment and peer endpoint before re-enabling traffic.

A successful query resets failure count and circuit state; invalid schema, identity mismatch, network timeout and bounded-response failures are recorded as safe machine codes.

## Example

A local node can query an approved remote architecture vault for an exact rule while also searching local context. If the remote peer times out, the caller receives local results plus an explicit federation failure when partial results are allowed. No local trust tier is promoted because the remote peer returned a high score.

## Limitations

`MIRROR_BUNDLE` is a registered mode name but is not currently an executed remote import path. AKP therefore does not claim mirror synchronization support.

Federation does not provide global distributed transactions, global ranking authority or automatic trust negotiation. Each node remains responsible for its own authorization and canonical knowledge.
