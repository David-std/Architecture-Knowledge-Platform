# Coordination Plane Guide

## What this feature is

The coordination plane is structured shared work state for humans and agent processes. It is separate from canonical knowledge and from the external task system of record.

AKP represents a `WorkContext` through the durable workspace/session aggregate: participants, append-only work events, mutable projections, claims, lease/fencing state, findings, blockers, artifacts, decision candidates and handoffs. This blackboard model lets participants coordinate through inspectable state rather than requiring direct agent-to-agent chat.

A transcript is neither required nor sufficient to reconstruct the task.

## Separation of concerns

```text
SYSTEM OF RECORD TASK
GitHub / Jira / Linear / AKP-native WorkItem
              │
              ▼
┌──────────────────────────────────┐
│ WORKSPACE COORDINATION           │
│ WorkContext · claims · leases    │
│ blockers · findings · artifacts │
│ presence · structured handoffs   │
└───────────────┬──────────────────┘
                │ selected evidence-backed finding
                ▼
        promotion + review
                │
                ▼
DURABLE APPROVED KNOWLEDGE
claims / rules / decisions in Git
```

## When to use it

Use the coordination plane when multiple participants can touch related work, when a task may be resumed later, when a fresh agent must continue from a handoff, or when concurrent writers need explicit ownership of a bounded scope.

Do not use it as a substitute for Git permissions, canonical publication, issue-tracker lifecycle or durable approved knowledge.

## Configuration

A coordination session belongs to an authorized space/vault and pins a `ContextRevisionSet`. Participants have independent principal identities and actions.

Claims identify a bounded resource pattern, purpose, lease expiry and fencing generation. Presence/heartbeat extends live ownership only within policy. Handoffs carry bounded structured state such as summary, completed and remaining work, blockers, changed resources, evidence references and questions.

Agent-process credentials are scoped and independently revocable. Claim ownership does not widen their repository, vault or publication permissions.

## Normal workflow

1. Bootstrap the task and create or join its WorkContext.
2. Read the current journal, claims, blockers and handoffs.
3. Acquire a claim for the smallest write scope that prevents destructive overlap.
4. Append findings, questions, artifacts or status updates to the blackboard while work proceeds.
5. Heartbeat a long-running claim or release it when the scope is free.
6. When another participant continues, create a structured handoff and release/transfer ownership using a new fence.
7. A fresh receiving session reconstructs goal, completed/remaining work, revision, evidence and blockers from durable state without the previous transcript.
8. Promote only selected evidence-backed findings into the governed review path.

## Security and governance boundaries

A claim is coordination ownership, not authorization. Every read and write still passes space/vault/path and principal-action checks.

Lease expiry or a newer fencing generation invalidates the old writer. The prior owner cannot mutate claim-owned coordination state after handoff.

Workspace events such as `HYPOTHESIS`, `FINDING`, `BLOCKER` and `DECISION_CANDIDATE` are not approved facts. Human/agent activity and observed ordering do not manufacture causality.

Normal agents cannot approve promotion requests or publish knowledge simply because they created the underlying finding.

## Degraded and offline behavior

An offline participant can work against a pinned snapshot and queue allowed local coordination drafts with the exact base revision hash. It cannot claim that central presence, claims or connector state are current.

On reconnect, queued drafts are applied only when idempotency and revision checks succeed. Otherwise they become reconciliation work.

If the Team Context Node is unavailable, clients may retain private local work and the last authorized snapshot, but shared claims and presence are unavailable.

## Failure and recovery

Coordination events are append-only audit history; convenience projections can be rebuilt from durable state. Claims use database-backed lease/fencing semantics rather than process memory.

Recovery preserves session revision pins, participant identity, work events and handoffs. A recovered stale claim must not regain authority after its lease/fence has been superseded.

Operator diagnostics should distinguish unavailable coordination infrastructure from an empty task.

## Example

Agent A and Agent B bootstrap the same task. A claims `packages/compiler/**`; B claims `apps/web/**`. B cannot take an overlapping compiler claim. A records a finding and hands it off with evidence and remaining work. A's old fence becomes invalid. A fresh B session can resume from the handoff without reading A's chat transcript.

## Limitations

The coordination plane does not schedule arbitrary autonomous work or replace a workflow engine. It provides bounded shared state and conflict prevention.

Direct peer-to-peer agent messaging is optional; AKP's maintained contract is the pull-oriented blackboard and durable handoff.
