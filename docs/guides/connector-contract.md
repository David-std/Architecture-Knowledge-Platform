# Connector Contract Guide

## What this feature is

The connector contract describes what an external integration can actually guarantee. A connector is not considered equivalent to another connector merely because both can fetch text.

Each connector declares an access mode, permission fidelity, synchronization fidelity, deletion behavior, freshness expectations, source authority, identity mapping, write-back capability, data residency, replay/audit support and current health. Planner and workspace policy can then distinguish a live permission-preserving source from a workspace-wide mirror or a metadata-only reference.

Supported access modes are `MIRROR_INDEXED`, `REMOTE_FEDERATED`, `REFERENCE_LIVE` and `HYBRID_CACHE`.

## Access modes

| Mode               | Primary read                 | Local content | Live provider          | Offline behavior                         |
| ------------------ | ---------------------------- | ------------- | ---------------------- | ---------------------------------------- |
| `MIRROR_INDEXED`   | local index                  | full mirror   | not required for reads | supported within mirror freshness policy |
| `REMOTE_FEDERATED` | remote query                 | none          | required               | unavailable                              |
| `REFERENCE_LIVE`   | pointer + live expansion     | none          | required               | unavailable                              |
| `HYBRID_CACHE`     | bounded cache + revalidation | bounded cache | normally required      | explicit stale policy only               |

## When to use it

Use this contract whenever AKP ingests, references, queries or acts on a system outside its canonical Git/raw-source boundary.

Use `MIRROR_INDEXED` when authorized content must be searchable locally and offline behavior matters. Use `REMOTE_FEDERATED` when the provider should enforce request-time scope. Use `REFERENCE_LIVE` for safe pointers whose detail is loaded only when explicitly expanded. Use `HYBRID_CACHE` when a bounded local cache is revalidated against a live provider.

## Configuration

A connector descriptor identifies the source system, object types and versioned `ConnectorCapabilities`.

Permission fidelity is explicit: `SOURCE_ACL_EXACT`, `SOURCE_ACL_MAPPED`, `WORKSPACE_WIDE` or `NONE`. Synchronization fidelity is `APPEND`, `UPSERT` or `MIRROR`. Deletion propagation is `IMMEDIATE`, `EVENTUAL` or `NONE`.

Configuration also records whether incremental cursor/webhook delivery exists, freshness SLA when known, source authority, identity mapping, write-back level, residency, replayability, rate limits and health.

The active Knowledge Profile may reject a connector whose capability or permission fidelity is insufficient for the workspace.

## Normal workflow

1. Register the connector descriptor and operator-owned credentials separately.
2. Validate endpoint/network policy and the active profile's connector policy.
3. Establish the connector checkpoint or live-query boundary.
4. Authenticate each delivery or request and preserve the external object identity.
5. Apply events idempotently and advance checkpoints only after durable processing.
6. Preserve permission metadata and source authority on the resulting projection/reference.
7. Propagate deletion or staleness according to the declared capability.
8. Expose freshness and degradation to retrieval and workspace callers.
9. Route any durable knowledge derived from connector content through normal evidence, promotion and review.

Write-back is never inferred from read access. `BOUNDED_ACTIONS` and `FULL` must be explicitly declared and separately authorized.

## Security and governance boundaries

Connector content is untrusted input even when transport authentication succeeds. Signatures authenticate an event source; they do not make the payload approved knowledge.

Authorization must constrain connector-derived candidates before ranking. A connector with `WORKSPACE_WIDE` or `NONE` permission fidelity cannot be advertised as source-ACL equivalent.

Webhook delivery validates timestamp, signature, replay identity, body size, content type and schema. Endpoint configuration rejects unsafe network targets according to deployment policy. Provider credentials are secrets and must not appear in persisted descriptors, errors or audit payloads.

Prompt text inside a connected message cannot change tools, policy, trust or publication state.

## Degraded and offline behavior

`REMOTE_FEDERATED` and `REFERENCE_LIVE` depend on provider availability. Their absence is reported as unavailable or partial rather than replaced by an unlabelled stale result.

`HYBRID_CACHE` exposes the cache's validation/freshness state. `MIRROR_INDEXED` can continue from its authorized local projection within declared freshness policy.

Offline ContextPackets identify unavailable live channels. A connector that cannot prove current permission or freshness does not silently become authoritative while offline.

## Failure and recovery

Connector inbox events, checkpoints, tombstones and durable projections participate in backup/restore. Checkpoint ordering is process objects durably first, then advance the cursor.

If processing crashes before cursor advancement, replay must be idempotent. Sequence gaps remain visible and later events do not leapfrog them.

Deletion from a source invalidates or tombstones the external projection according to policy. It does not blindly delete approved AKP knowledge; support/freshness maintenance determines whether review is required.

## Example

An issue connector declares `HYBRID_CACHE`, `SOURCE_ACL_MAPPED`, `UPSERT`, eventual deletion and bounded write-back. AKP can use the cached issue for authorized workspace orientation, revalidate it when online and surface staleness when the provider is unavailable. The issue remains owned by the external tracker.

## Jira and Linear read-only adapters

AKP includes provider adapters for Jira Cloud issue references and Linear issue references. The deployed provider path is authenticated, cursor-based polling. Both adapters are read-only and declare `REFERENCE` replication, external residency, mapped/uncertain ACL fidelity, no write-back and no deletion propagation. They preserve provider identity and revision timestamps and publish explicit provider health. Provider-authenticated reads mark their projection metadata as `providerVerified: true`; this means AKP observed the object through the authenticated adapter, not that the ticket content is approved knowledge.

The agent bridge is intentionally weaker. `akp_upsert_external_reference` accepts the identity, URL, revision and bounded metadata an agent obtained through another provider MCP, but the API forces authority to `REFERENCE` and stamps `providerVerified: false`. A relayed copy cannot self-promote to `SYSTEM_OF_RECORD`.

Webhook verification primitives exist and fail closed: Jira requires a deployment-supplied verifier, while the Linear primitive checks HMAC and timestamp freshness. They are not advertised by the provider registration contract because AKP does not currently route provider webhooks into the provider-pull inbox. Likewise, polling does not claim deletion/tombstone fidelity until a deletion reconciliation path is deployed.

CI exercises provider reads, pagination, provenance and the verification primitives with simulated responses. A claim of live Jira or Linear integration additionally requires a sandbox/account run with deployment credentials; simulated-provider coverage is not treated as that evidence.

## Limitations

The generic connector contract does not imply a first-party adapter for every vendor. Permission fidelity and deletion guarantees are limited by what a provider exposes.

A capability declaration is an enforceable planning input, not independent proof that the external provider is correct or available.
