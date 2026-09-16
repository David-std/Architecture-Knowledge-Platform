# Context Fabric deployment and coordination

AKP v0.4 keeps three planes separate:

- canonical approved knowledge remains governed Markdown in managed Git;
- shared work coordination lives in durable PostgreSQL workspace state;
- derived retrieval/index state is rebuildable and never becomes canonical by synchronization.

## Deployment modes

`AKP_CONTEXT_FABRIC_MODE` declares the operator-visible deployment mode:

- `SOLO_LOCAL` — one local AKP instance;
- `GIT_SYNC_SMALL_TEAM` — approved Markdown may travel through normal Git workflows, while writable PostgreSQL/vector state remains local to each AKP node;
- `TEAM_NODE` — the recommended shared-team pattern: one authorized AKP API/worker/PostgreSQL node owns shared coordination and derived state;
- `FEDERATED_ORG` — Team Nodes may publish discovery metadata for separately authorized federation. Remote query/import remains disabled until the federation phase supplies its authorization and trust contracts.

Set `AKP_CONTEXT_FABRIC_NODE_ID` to a stable operator-visible node identifier. The API reports the effective mode and supported boundaries at `GET /v1/context-fabric/capabilities`.

Do **not** synchronize a writable PostgreSQL data directory, pgvector database, cache, or derived graph through Git, OneDrive, Syncthing, Dropbox, or another file-synchronization mechanism. Shared derived state belongs to the Team Context Node. Approved knowledge can be reconstructed from governed Git and raw/source records according to the existing backup/recovery contract.

## Work context and revision pinning

A workspace session pins a `ContextRevisionSet` at creation. Bootstrap resolves authorized context against that pin and verifies the revision again before returning the packet. Strict coordination writes fail with `CONTEXT_REVISION_CHANGED` after an authority changes instead of silently mixing R1 and R2.

Workspace findings, artifacts, notes, blockers, claims, handoffs, external references and offline drafts are operational state. They are not approved knowledge.

Promotion remains:

`finding/evidence -> promotion request -> review -> human approval -> managed Git publication`

Normal `AGENT_PROCESS` credentials can read/coordinate and may receive `knowledge:propose`; they do not receive `knowledge:review`, publication, or administrative authority.

## External system-of-record references

`ExternalObjectRef` stores a scoped reference/projection of an authorized external object. Identity is `(vault, provider, object type, external ID)`. The record may carry the source revision, canonical URL, title and bounded metadata, but its authority remains explicitly one of:

- `SYSTEM_OF_RECORD`
- `REFERENCE`
- `MIRRORED_PROJECTION`

An external reference never becomes a source, evidence, claim, rule, or canonical Markdown merely because it is present in a workspace.

## Offline snapshots and drafts

`POST /v1/sessions/:id/offline-snapshot` captures an authorized compact bootstrap packet together with its pinned revision hash and an integrity hash. A client must retain the capture time and revalidate on reconnect.

Offline coordination changes are queued with a client-generated idempotency key and the exact `baseRevisionSetHash`. On reconnect:

- if the session pin is still current and the base hash matches, the draft may be applied once to the append-only workspace event stream;
- if truth/profile/index authorities changed, the draft becomes `RECONCILE_REQUIRED` and is not auto-applied;
- approved knowledge never uses last-write-wins conflict resolution.

The current server intentionally applies only coordination event types (`FINDING`, `ARTIFACT`, `DECISION_CANDIDATE`, `NOTE`) from offline drafts. Publication still uses the review lifecycle.

## Federation discovery boundary

`context_fabric_peers` and `/v1/context-fabric/peers` are discovery metadata only. Registering a peer performs no network request. A peer can declare a discovery mode and capability manifest, but P2 does not allow a discovered endpoint to become an authorization bypass, remote retrieval source, write boundary, or trust upgrade.

The API returns `boundary: DISCOVERY_METADATA_ONLY` and `networkContactPerformed: false` for peer registration. Actual remote query/import policy belongs to the federation phase and must preserve remote provenance, trust and local authorization.

## Operational verification

Before treating Team Context Fabric as proven, execute the maintained integration suite and remote CI matrix. Evidence must cover at least:

- multi-vault and path-scope isolation;
- two-agent claim overlap, fencing and durable handoff;
- revision-pinned bootstrap and R1 -> R2 drift detection;
- promotion provenance and denial of agent self-approval;
- human-governed publication;
- offline idempotency and stale reconnect reconciliation;
- external-reference separation from canonical knowledge;
- backup/restore of the new PostgreSQL tables and migration upgrade from the validated v0.3 baseline.
