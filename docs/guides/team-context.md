# Team Context Guide

## What this feature is

Team Context is AKP's shared coordination layer for people and agent processes. It keeps approved knowledge, work state and derived retrieval state as separate authority classes.

- Canonical approved knowledge remains governed Markdown in managed Git.
- Workspace sessions, claims, handoffs, findings, drafts and external references are durable coordination state in PostgreSQL.
- Search, vector, graph and context projections are derived state that can be rebuilt.

A workspace session pins a `ContextRevisionSet`. The pin makes handoffs reproducible and lets AKP detect when profile, truth or index authorities changed while work was in progress.

## When to use it

Use Team Context when more than one participant must work against a common authorized view of a space or vault, when a task needs resumable handoff, or when findings may later be promoted through review.

Use `SOLO_LOCAL` for one local instance. Use `TEAM_NODE` when one shared AKP node owns writable coordination and derived state. Use `FEDERATED_ORG` when separately authorized nodes must use the bounded federation runtime described in the [Federation Guide](federation.md).

Do not use file synchronization to share a writable PostgreSQL directory, vector store, cache or derived graph.

## Configuration

The principal deployment controls are:

- `AKP_CONTEXT_FABRIC_MODE`: `SOLO_LOCAL`, `GIT_SYNC_SMALL_TEAM`, `TEAM_NODE` or `FEDERATED_ORG`.
- `AKP_CONTEXT_FABRIC_NODE_ID`: stable node identity required by shared-node modes.
- `AKP_API_TOKEN` and `AKP_API_TOKEN_SCOPES`: scoped service or operator authority.
- `AKP_MANAGED_REPO`: governed Git repository used for approved knowledge.
- `AKP_PROJECT_ROOTS` and `AKP_INGEST_ROOTS`: explicit local filesystem boundaries.

For a shared node, use the base Compose file together with `docker-compose.team-node.yml`. The database node claim prevents a different node identity from silently sharing the same writable derived state.

## Normal workflow

1. Create or join a workspace session in an authorized space and vault.
2. Bootstrap context. AKP captures the shared revision pin and current principal-aware authorization revision.
3. Claim a bounded work scope. The claim owner receives the fencing authority for that scope.
4. Perform targeted retrieval, impact analysis or code/temporal context requests as needed.
5. Capture findings, artifacts, decision candidates or notes as coordination state.
6. Heartbeat or release the claim. For handoff, include completed work, remaining work, blockers, changed resources, evidence references and open questions.
7. When a finding should become canonical knowledge, create a promotion request and send it through review. Workspace state itself never becomes approved knowledge automatically.

The Web workspace and MCP `akp_context` façade expose the same underlying boundaries rather than maintaining a second truth system.

## Security and governance boundaries

Authorization is evaluated before retrieval expansion. A valid workspace membership does not grant access to every vault or path in the space.

`AGENT_PROCESS` principals are independent child principals. A child cannot reuse a human parent's claim fence, and normal agent credentials do not receive review, publication or administration authority unless explicitly provisioned.

A `ContextRevisionSet` is a reproducibility pin, not an authorization grant. Profile configuration also constrains behavior but does not create runtime authority.

Promotion preserves source session, source revision, target scope, evidence versions and conflict-evaluation state. Candidate content cannot self-declare a stronger trust tier.

## Degraded and offline behavior

An offline snapshot carries its pinned revision and integrity hash. Stale snapshots remain identifiable as offline/stale and do not silently return current-looking context.

Offline coordination drafts include the exact base revision hash. On reconnect they can be applied only when the pin is still current; otherwise they move to reconciliation instead of using last-write-wins.

Optional retrieval channels may degrade explicitly, but a revision or authorization change that makes strict continuation unsafe fails closed.

## Failure and recovery

If a claim lease expires, a later writer must obtain a new fence. A stale writer cannot continue with the old fencing token.

If a context authority changes mid-operation, strict workflows return `CONTEXT_REVISION_CHANGED` and the participant should bootstrap again.

Use `pnpm akp doctor --format human` to inspect revision parity and operational state. Backup/recovery procedures are documented in the [Operations/Recovery Guide](operations-recovery.md).

## Example

A development agent can bootstrap the workspace, claim the affected service scope, request code-impact context before editing, capture a finding that references affected tests, and hand off with the same revision set if another participant continues. A promotion request is created only when the finding should become shared canonical knowledge.

## Limitations

The built-in authorization adapter is the maintained implementation; an external ReBAC control plane is not assumed.

Writable collaboration is node-owned rather than peer-to-peer database synchronization. Offline drafts are intentionally limited to coordination event types. Publication remains a governed human-review workflow.
