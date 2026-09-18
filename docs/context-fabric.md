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

### Running a Team Context Node

`TEAM_NODE` is an executable topology, not only a declared mode. `docker-compose.yml` provides the infrastructure a node runs on; `docker-compose.team-node.yml` adds the services that constitute the node itself — one API, one worker and one web surface, built from the same revision by the root `Dockerfile` and pointed at that one infrastructure:

```bash
export AKP_CONTEXT_FABRIC_NODE_ID=team-node-1
export AKP_API_TOKEN=<the web surface service credential>
docker compose -f docker-compose.yml -f docker-compose.team-node.yml up -d --build
```

A one-shot `migrate` service applies the schema before the API and worker start, so the node — not each client — owns its database. The API publishes on `127.0.0.1:8080` and the web surface on `127.0.0.1:3000` by default; override with `AKP_API_PORT` and `AKP_WEB_PORT`, and publish on a routable interface only behind your own transport security.

`AKP_API_HOST` controls the API bind address. It defaults to `127.0.0.1`, so a workstation stays loopback-only unless an operator opts in; the container image sets `0.0.0.0` because its peers cannot reach its loopback.

### Node identity is enforced, not declared

Shared derived state belongs to exactly one node. Because a mode that exists only as an environment variable cannot prevent two writable nodes from interleaving their writes, the node identity is claimed in the database.

- `TEAM_NODE` and `FEDERATED_ORG` require an explicit `AKP_CONTEXT_FABRIC_NODE_ID`. A node that owns other people's derived state is named deliberately; there is no implicit default.
- On startup, the API and the worker claim the database for that identity. Replicas of the same node re-claim freely — identity, not process count, is what the mode constrains.
- A **different** identity is refused with `CONTEXT_FABRIC_NODE_CONFLICT`, and the process does not start. This is what a second node pointed at a shared database looks like, and what restoring a copy of someone else's database and running it as your own looks like.
- Renaming a node is legitimate but deliberate: restart once with `AKP_CONTEXT_FABRIC_NODE_ADOPT=true`. The adoption is recorded, so the previous identity stays visible rather than being silently overwritten.

`GET /v1/context-fabric/capabilities` reports the claim the database carries, not the environment the answering process happens to hold. A node that has not completed its claim reports `node.claimed: false` and `node.sharedDerivedState: false` even when its environment declares `TEAM_NODE`.

## Work context and revision pinning

A workspace session pins a `ContextRevisionSet` at creation. Bootstrap resolves authorized context against that pin and verifies the revision again before returning the packet. Strict coordination writes fail with `CONTEXT_REVISION_CHANGED` after an authority changes instead of silently mixing R1 and R2.

Workspace findings, artifacts, notes, blockers, claims, handoffs, external references and offline drafts are operational state. They are not approved knowledge.

Promotion remains:

`finding/evidence -> promotion request -> review -> human approval -> managed Git publication`

Governed proposal content cannot manufacture a stronger trust authority through frontmatter. In particular, `trust_tier: attested`, `verification_status: attested` or `status: attested` is rejected before a review draft is created. Existing administrative/legacy vault import remains a separate compatibility boundary; attestation must come from an authority outside proposal content, not from the candidate being reviewed.

Normal `AGENT_PROCESS` credentials can read/coordinate and may receive `knowledge:propose`; they do not receive `knowledge:review`, publication, or administrative authority. Their bearer credential is bounded by its own expiry and policy revision. A derived agent also remains subordinate to its recorded human authority root: once that parent principal is no longer active, the child credential is invalid even if the child principal row itself has not yet been revoked. Expired credentials and credentials whose parent authority has been revoked must fail closed on the next request rather than retaining ambient session authority.

## External system-of-record references

`ExternalObjectRef` stores a scoped reference/projection of an authorized external object. Identity is `(vault, provider, object type, external ID)`. The record may carry the source revision, canonical URL, title and bounded metadata, but its authority remains explicitly one of:

- `SYSTEM_OF_RECORD`
- `REFERENCE`
- `MIRRORED_PROJECTION`

An external reference never becomes a source, evidence, claim, rule, or canonical Markdown merely because it is present in a workspace.

## Offline snapshots and drafts

`POST /v1/sessions/:id/offline-snapshot` captures an authorized compact bootstrap packet together with its pinned revision hash, an integrity hash and `ageSeconds` derived from the pinned shared `ContextRevisionSet` timestamp rather than from the instant the HTTP response is created. A client must retain the capture time and revalidate on reconnect. When that pin later becomes stale, the server reports the age of the same pinned shared revision instead of resetting freshness to zero.

Offline coordination changes are queued with a client-generated idempotency key and the exact `baseRevisionSetHash`. On reconnect:

- if the session pin is still current and the base hash matches, the draft may be applied once to the append-only workspace event stream;
- if truth/profile/index authorities changed, the draft becomes `RECONCILE_REQUIRED` and is not auto-applied;
- approved knowledge never uses last-write-wins conflict resolution.

The current server intentionally applies only coordination event types (`FINDING`, `ARTIFACT`, `DECISION_CANDIDATE`, `NOTE`) from offline drafts. Publication still uses the review lifecycle.

## Federation discovery boundary

`context_fabric_peers` and `/v1/context-fabric/peers` are discovery metadata only. Registering a peer performs no network request. A peer can declare a discovery mode and capability manifest, but the current Team Context Fabric contract does not allow a discovered endpoint to become an authorization bypass, remote retrieval source, write boundary, or trust upgrade.

The API returns `boundary: DISCOVERY_METADATA_ONLY` and `networkContactPerformed: false` for peer registration. The node discovery manifest advertises only `CATALOG_ONLY` federation in P2 and the capability flag `federationRemoteQuery` remains false. Therefore peer metadata cannot return or materialize remote knowledge objects in this phase; remote query/import policy belongs to the federation phase and must preserve remote provenance, trust and local authorization.

## Operational verification

Before treating Team Context Fabric as proven, execute the maintained integration suite and remote CI matrix. Evidence must cover at least:

- multi-vault and path-scope isolation, including a private vault that cannot leak into team-wide search without an explicit grant;
- two-agent claim overlap, fencing and durable handoff;
- revision-pinned bootstrap and R1 -> R2 drift detection;
- promotion provenance, denial of agent self-approval and rejection of proposal-authored `ATTESTED` trust escalation;
- human-governed publication;
- agent credential expiry/replay rejection and parent-principal revocation invalidation;
- offline idempotency and stale reconnect reconciliation;
- external-reference separation from canonical knowledge;
- explicit claim release advancing the fence, locking out stale writers and freeing the scope for reacquisition;
- backup/restore of the new PostgreSQL tables and migration upgrade from the validated v0.3 baseline.

For `TEAM_NODE` specifically, configuration evidence is not enough: the guarantees are about a running topology. `scripts/verify-team-node.mjs` probes a live node for readiness, its database claim, single-authority revision agreement across two clients, and its web surface. The `team-node` workflow builds and starts the topology, fails unless API, worker and web remain running, and additionally proves that a second node with a different identity is refused while a replica of the same node is admitted.

## Connector capability contract

Federation/source adapters do not receive trust merely because they implement a fetch call. They declare a versioned `ConnectorCapabilities` contract from `@akp/contracts/connector-capabilities`. The contract records access mode, permission and synchronization fidelity, incremental sync support, deletion propagation, freshness, source authority, write-back, identity mapping, residency, replay/audit behavior, rate limits, degradation policy and current health.

The access modes have different runtime behavior:

| access mode        | primary read                          | local content | live provider required | offline read                      |
| ------------------ | ------------------------------------- | ------------- | ---------------------- | --------------------------------- |
| `MIRROR_INDEXED`   | local index                           | full mirror   | no                     | yes                               |
| `REMOTE_FEDERATED` | remote query                          | none          | yes                    | no                                |
| `REFERENCE_LIVE`   | safe pointer + live expansion         | none          | yes                    | no                                |
| `HYBRID_CACHE`     | bounded cache, then live revalidation | bounded cache | yes                    | yes, within explicit stale policy |

`REFERENCE_LIVE` and `REMOTE_FEDERATED` therefore cannot claim `STALE_READ`: they do not own a local content projection from which such a read could be served. `MIRROR_INDEXED` and `HYBRID_CACHE` may serve bounded stale state only when the connector declares that degradation policy, and the resulting read plan labels that state as stale.

A KnowledgeProfile remains the policy authority. `ConnectorCapabilities` says what the connector can guarantee; `connectorPolicy` says what a vault accepts. In particular, a connector with `WORKSPACE_WIDE` or `NONE` permission fidelity is denied when the profile requires permission fidelity. `SOURCE_ACL_MAPPED` is accepted only when the connector also declares an identity mapping.

`context_fabric_peers` is the first consumer of this shared contract. It is not the definition of the contract: later source connectors reuse the same schema. Registration persists the declared capability set and performs no network contact. Listing peers exposes the derived read plan. Supplying `vaultId` additionally evaluates each peer against that vault's active KnowledgeProfile without changing the peer or upgrading its trust.


## Consultative decision workflow

Architecture decisions use workspace coordination state before they become governed knowledge. The durable flow is:

`candidate → alternatives / objections → human consultation → selection → captured DECISION_CANDIDATE → governed promotion/review → publication → approved or superseded`.

The candidate records the problem, surrounding context, decision drivers, affected quality attributes, affected references, evidence, decision authority, deadlines and a verification plan. Selection additionally records the chosen alternative, explicit consequences, follow-up actions and an optional effective period. Alternatives preserve authorship at principal level. A human-authored alternative enters consultation as `HUMAN_SUBMITTED`; an agent-authored alternative is `AGENT_SUGGESTED` and remains `SUGGESTED` until the human decision authority explicitly marks it considered. The platform therefore never rewrites model output as a human option or infers consensus from co-occurrence.

Selection is fail-closed. The decision authority cannot select an alternative until at least two alternatives are considered, at least one independent human consultation has responded, and every open objection has been resolved. Consultation responses preserve the reviewer principal and position; objections preserve their author, evidence and resolution provenance.

`capture` does not publish a decision. It freezes the consultative snapshot into the existing promotable `DECISION_CANDIDATE` workspace event. Promotion then creates the ordinary governed review and links the candidate to that review. Discussion rows remain coordination/provenance state and are never compiled directly into canonical knowledge.

Approval authority remains the existing review lifecycle. Agent-process credentials may prepare candidates, suggest alternatives, capture the ready snapshot and request promotion when explicitly delegated `knowledge:propose`; they cannot approve publication. The candidate becomes `APPROVED` only inside the same database transaction that finalizes the canonical review publication. Rejection is also atomic with the linked review transition, so a rejected review cannot leave its structured decision candidate in `PENDING_REVIEW`. A replacement decision marks its approved predecessor `SUPERSEDED` in the publication transaction as well, so canonical Git revision authority and decision lifecycle cannot diverge silently.
