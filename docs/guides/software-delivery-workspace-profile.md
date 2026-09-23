# Software Delivery Workspace Profile Reference

## What this feature is

The Software Delivery Workspace Profile is AKP's first-party Knowledge Profile for engineering organizations. The platform core remains domain-neutral; this profile supplies a concrete vocabulary and governed workflows so teams can connect knowledge, software, work and runtime evidence without adding product-specific types to the core.

Its object families cover workspace/project/goal, team/person/agent, domain/system/service/component/API/resource, repository/branch/commit/PullRequest/review, issue/WorkItem/incident/change, build/deployment/environment, test/TestRun, runbook/document, Decision/DecisionCandidate, meeting/channel/message/comment and work session/handoff.

Relations include ownership/membership, composition, API consumption, dependencies, implementation, impact, links/resolution/blocking, supersession, discussion/decision/motivation, deployment/testing/observation, change/touch/assignment/review/approval.

## Object model at a glance

```text
Workspace / Project / Goal
        │
        ├── Team / Person / Agent
        ├── Domain / System / Service / Component / API / Resource
        ├── Repository / Branch / Commit / PullRequest / Review
        ├── Issue / WorkItem / Incident / Change
        ├── Build / Deployment / Environment
        ├── Test / TestRun
        ├── Runbook / Document
        ├── Decision / DecisionCandidate
        ├── Meeting / Channel / Message / Comment
        └── WorkTask / WorkSession / Handoff
```

The profile gives these objects portable semantics; connector-specific fields remain adapter concerns.

## When to use it

Use this profile when AKP supports software delivery, architecture, review, incident or deployment work and the generic profile would otherwise force each installation to invent the same vocabulary.

Use a different versioned profile for another domain. Do not mutate this profile's semantics locally without a profile revision, compatibility classification and migration/review process.

## Configuration

Activate the profile through the normal Knowledge Profile lifecycle. Profile revision participates in context/retrieval revisioning and may constrain entity kinds, relation types, evidence, review, freshness, promotion and connector policy.

External systems remain authoritative for objects they own. The profile maps them into stable workspace concepts through `ExternalObjectRef` and connector capability contracts.

Causal relations are stricter than generic links: observed order, correlation and inferred hypotheses remain distinct from source-explicit, human-approved causal or dynamically proven support.

## Normal workflow

The maintained software-delivery flows are:

- Start work: work item or goal -> bootstrap context -> active rules/decisions -> service/catalog orientation -> code impact -> relevant history/handoffs.
- Implement/change: work claim -> edits -> code-graph delta -> tests/runtime evidence -> findings/blockers -> handoff.
- Review: pull request/change -> blast radius -> affected rules/decisions -> test evidence -> contradictions -> reviewer context.
- Decide: DecisionCandidate -> context/drivers/alternatives/trade-offs/evidence -> consultation -> governed selection -> review -> approved Decision -> follow-up verification.
- Incident: incident -> affected services/runtime observations -> recent deploy/change -> runbooks/decisions -> owners -> follow-up work/candidates.
- Deploy: change -> build/tests -> decision/rule gates -> deployment -> runtime observation -> rollback/incident linkage when needed.

A DecisionCandidate records the problem, context, drivers, alternatives, consequences, affected quality attributes/systems/code/work, evidence, authority, contributors/reviewers, status, effective period, supersession and follow-up actions when that information actually exists.

## Security and governance boundaries

Profile vocabulary does not bypass runtime authorization, review or truth validation. A model may propose a DecisionCandidate or missing fields but cannot fabricate alternatives, evidence, consensus or approval.

An agent-suggested alternative remains distinguishable from a source-explicit or human-considered alternative until a human authority accepts it into the decision workflow.

Pull requests, incidents, builds and deployments imported from another product remain projections/references unless AKP is explicitly configured as their system of record.

## Degraded and offline behavior

When code, runtime, connector or federation context is unavailable, the workspace shows that layer as degraded instead of filling it with another graph's observation.

Offline snapshots preserve the profile and context revisions used to assemble the task. Live external state is marked unavailable until revalidation.

A decision review may continue with the evidence actually available only when policy permits partial context; missing required evidence fails closed.

## Failure and recovery

Profile changes use validate -> diff -> impact -> migration plan -> review -> activate. Existing non-empty corpora are never silently reinterpreted under an incompatible semantic profile.

Durable decisions, reviews, external references and coordination state survive backup/restore. Derived code/runtime/work projections can be rebuilt or resynchronized from their authorities.

If publication fails, the existing review/publication recovery mechanism preserves the prior canonical revision rather than creating an independently approved decision state.

## Example

A pull request changes an authentication component. The profile links the PR to the WorkItem, affected code symbols, service, active security decision, tests and deployment evidence. The reviewer sees the distinct catalog, code and runtime observations. A proposed new architecture decision remains a DecisionCandidate until the human review path approves and publishes it.

## Limitations

The profile defines portable software-delivery semantics, not vendor-specific issue or CI fields. Connector adapters map provider-specific data into the profile where fidelity is known.

It does not infer causality from frequent sequence or adjacency, and it does not make every observed work artifact durable knowledge.
