# Team Context Guide

## What this feature is

Team Context is AKP's shared coordination layer for people and agent processes. It keeps approved knowledge, work state and derived retrieval state as separate authority classes.

- Canonical approved knowledge remains governed Markdown in managed Git.
- Workspace sessions, claims, handoffs, findings, drafts and external references are durable coordination state in PostgreSQL.
- Search, vector, graph and context projections are derived state that can be rebuilt.

A workspace session pins a `ContextRevisionSet`. The pin makes handoffs reproducible and lets AKP detect when profile, truth or index authorities changed while work was in progress.

## Mental model

```text
┌─────────────────────────┐
│ SYSTEMS OF RECORD       │
│ GitHub · Jira · CI/CD   │
│ observability · catalog │
└────────────┬────────────┘
             │ authorized projection/reference
             ▼
┌─────────────────────────┐
│ COORDINATION STATE      │
│ claims · blockers       │
│ findings · handoffs     │
└────────────┬────────────┘
             │ explicit promotion + review
             ▼
┌───────────────────────────┐
│ DURABLE APPROVED KNOWLEDGE│
│ claims · rules · decisions│
│ Markdown + managed Git    │
└───────────────────────────┘
```

A `ContextRevisionSet` makes the shared read reproducible; it does not promote coordination state or broaden authorization.

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
7. A handoff addressed to another participant appears in that user's scoped handoff inbox. A newly created agent session can import the durable handoff without access to the prior transcript; the imported event preserves the source goal, source revision, changed resources, evidence, blockers and questions.
8. When a finding should become canonical knowledge, create a promotion request and send it through review. Workspace state itself never becomes approved knowledge automatically.

The Web workspace and MCP `akp_context` façade expose the same underlying boundaries rather than maintaining a second truth system.

## Lifecycle at a glance

```text
┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────────┐
│ READ       │ → │ WORK       │ → │ VERIFY     │ → │ CAPTURE/HANDOFF│
│ bootstrap  │   │ code/tools │   │ support    │   │ durable state  │
└────────────┘   └────────────┘   └────────────┘   └───────┬────────┘
                                                              │
                                                    durable knowledge?
                                                              │
                                                              ▼
┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
│ EVOLVE     │ ← │ PUBLISH    │ ← │ REVIEW     │ ← │ PROMOTE    │
│ next read  │   │ Git+events │   │ human/policy│  │ candidate  │
└────────────┘   └────────────┘   └────────────┘   └────────────┘
```

## Security and governance boundaries

Authorization is evaluated before retrieval expansion. A valid workspace membership does not grant access to every vault or path in the space.

The authorization port has four explicit outcomes: `ALLOW`, `DENY`, `INDETERMINATE` and `BACKEND_UNAVAILABLE`. Protected content is returned only for `ALLOW`; every other outcome fails closed. Backend outage is not converted into ambient space membership or a broader vault scope.

`AGENT_PROCESS` principals are independent child principals. Issuance exposes principal id, parent, session, roles, narrowed scopes, allowed actions, creation time, expiry, revocation state and policy revision. The token secret is returned only at creation; durable storage keeps only its hash. A child cannot reuse a human parent's claim fence, and normal agent credentials do not receive review, publication or administration authority unless explicitly provisioned.

A `ContextRevisionSet` is a reproducibility pin, not an authorization grant. Profile configuration also constrains behavior but does not create runtime authority.

Promotion preserves source session, source revision, target scope, evidence versions and conflict-evaluation state. Candidate content cannot self-declare a stronger trust tier.

Work/activity provenance uses six canonical derivation classes: `SOURCE_EXPLICIT`, `OBSERVED_ORDER`, `CORRELATED`, `INFERRED_HYPOTHESIS`, `HUMAN_APPROVED_CAUSAL` and `DYNAMICALLY_PROVEN`. Ordering, correlation and inferred hypotheses cannot support a causal `CAUSED` assertion. Causality requires an explicit source statement, human-approved causal evidence or dynamic proof. Legacy derivation names remain readable during v0.4 migration but are not the canonical contract.

## Degraded and offline behavior

An offline snapshot carries its pinned revision and integrity hash. Its manifest records node/space/vault identity, profile and policy revisions, knowledge/corpus revisions, available index revisions, creation/expiry time, unavailable live channels and the count of queued local drafts. Live federation and live connector reads are explicitly unavailable while the packet is offline. Stale snapshots remain identifiable as offline/stale and do not silently return current-looking context.

Offline coordination drafts include the exact base revision hash. On reconnect they can be applied only when the pin is still current; otherwise they move to reconciliation instead of using last-write-wins.

Optional retrieval channels may degrade explicitly, but a revision or authorization change that makes strict continuation unsafe fails closed.

## Failure and recovery

Claim scopes are NFC-normalized, reject backslashes, duplicate separators and traversal segments, and use case-sensitive canonical Git path semantics. If a claim lease expires, a later writer must obtain a new fence. A stale writer cannot continue with the old fencing token.

If a context authority changes mid-operation, strict workflows return `CONTEXT_REVISION_CHANGED` and the participant should bootstrap again.

Use `pnpm akp doctor --format human` to inspect revision parity and operational state. Backup/recovery procedures are documented in the [Operations/Recovery Guide](operations-recovery.md).

## Example

A development agent can bootstrap the workspace, claim the affected service scope, request code-impact context before editing, capture a finding that references affected tests, and hand off with the same revision set if another participant continues. A promotion request is created only when the finding should become shared canonical knowledge.

## Limitations

The built-in authorization adapter is the maintained implementation; an external ReBAC control plane is not assumed.

Writable collaboration is node-owned rather than peer-to-peer database synchronization. Offline drafts are intentionally limited to coordination event types. Publication remains a governed human-review workflow.
