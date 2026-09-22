# Workspace Operating Model

## What this feature is

AKP is the governed context workspace between systems of record and humans or agents. It does not replace GitHub, Jira, Linear, incident systems, CI/CD, chat, calendars or service catalogs. It keeps three authority classes explicit:

- systems of record own their external objects and lifecycle;
- workspace coordination owns active work state such as claims, blockers, findings, handoffs and drafts;
- approved AKP knowledge owns reviewed claims, rules and decisions published through managed Git.

Derived search indexes, graphs, summaries and ContextPackets are rebuildable context. They help people and agents act on work, but they do not become canonical merely because they rank highly.

The first-party operating model is software-delivery oriented. It connects goals and work items to repositories, pull requests, builds, deployments, tests, incidents, decisions, services and authorized context without flattening those objects into one generic graph.

## When to use it

Use the workspace operating model when a task spans more than one knowledge source or participant, when work must survive a handoff, or when a change needs context from software structure, current decisions, runtime evidence or external work items.

Typical workflows are:

- start work on a ticket or goal;
- implement a bounded change;
- review a pull request or proposed knowledge change;
- make or supersede an architecture decision;
- investigate an incident;
- prepare or assess a deployment.

Use the underlying system of record directly for lifecycle operations that AKP does not own.

## Configuration

Bind a workspace to an authorized space and vault, an active Knowledge Profile and the appropriate connector policies. External objects use scoped `ExternalObjectRef` records with an explicit authority class instead of being copied into a competing ticket or incident lifecycle.

Shared work runs through a Team Context Node when multiple participants need one writable coordination authority. Serious tasks pin a `ContextRevisionSet`; strict operations revalidate that pin before returning or mutating coordination state.

Connector capability, permission fidelity, freshness and source authority influence what the workspace may expose or treat as current. They do not grant publication authority.

## Normal workflow

1. Resolve the source-of-record work item or create an AKP-native work context when no external object owns the task.
2. Bootstrap authorized context and pin the revision set.
3. Inspect applicable rules, decisions, service/catalog orientation, code impact and recent work history.
4. Acquire a bounded work claim when concurrent writers could overlap.
5. Record findings, blockers, artifacts and questions in coordination state while work proceeds.
6. Hand off structured state when another human or agent continues.
7. For review, surface affected code/services, tests, decisions, contradictions and evidence.
8. For a durable decision or finding, create a governed promotion/review candidate.
9. Publish approved knowledge through the existing review and managed-Git path.
10. A later bootstrap sees the new approved revision; old strict sessions detect revision drift.

Incident and deployment flows use the same model: source-of-record event, affected services/runtime evidence, recent changes, current rules/decisions, owners, work state and governed follow-up knowledge.

## Security and governance boundaries

Authorization constrains candidate generation before ranking or traversal. Workspace membership, connector reachability and graph adjacency are not authorization grants.

A system-of-record projection keeps its external authority. Coordination findings and agent hypotheses remain work state. Only reviewed publication can create approved AKP knowledge.

Observed activity order or correlation is not causality. Causal relations require source-explicit, human-approved or dynamically proven support.

Normal agent principals may read and coordinate within their scoped actions. They cannot approve their own proposal, upgrade trust, publish canonical knowledge or widen their scope through a work claim.

## Degraded and offline behavior

When a live connector, federation peer, graph or reasoning channel is unavailable, the workspace reports the degraded channel rather than silently presenting stale or partial context as complete.

Offline work uses an integrity-addressed snapshot with its revision age and unavailable live channels. Local coordination drafts may queue against that exact base revision. Reconnect applies them only when the revision contract still permits it; otherwise they require reconciliation.

An external system remaining unavailable does not transfer lifecycle ownership to AKP.

## Failure and recovery

Workspace coordination, external references, reviews and audit history are durable state covered by normal backup/restore. Derived context can be rebuilt from durable and canonical sources.

Lease and fencing rules prevent an expired claimant from continuing to mutate claim-owned state. Revision drift returns an explicit conflict in strict flows instead of mixing old and new context.

After recovery, verify the managed Git revision, durable workspace state and rebuilt projections before resuming shared operation.

## Example

A payment-service ticket remains owned by the issue tracker. AKP projects its authorized identity, bootstraps current architecture decisions and code impact, and lets an agent claim the relevant repository scope. The agent records a test-backed finding and hands the task to a reviewer without sharing its transcript. If the finding should become durable guidance, it enters review and only then becomes approved Markdown.

## Limitations

AKP is not a replacement issue tracker, chat system, observability backend or CI/CD controller. Vendor-specific actions depend on configured connector capabilities.

The workspace can correlate declared, static and runtime observations, but disagreement is surfaced rather than automatically resolved into one truth.
