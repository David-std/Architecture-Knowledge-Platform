# Architecture

Architecture Knowledge Platform is a local-first governed Context Workspace and Context Fabric. It preserves one canonical approved knowledge layer while composing multiple explicit operational representations for retrieval, software structure, work, runtime observations and temporal truth.

Approved Markdown in managed Git is canonical knowledge. Immutable source bytes remain separate. PostgreSQL, pgvector, graph projections, code graphs, community/PPR state, ContextPackets and caches are operational or derived state.

## Target architecture

```text
                        ┌─────────────────────────────────┐
                        │ Canonical approved knowledge    │
                        │ Markdown + Git + Evidence       │
                        └────────────────┬────────────────┘
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        │                                │                                │
 Epistemic Graph               Software Catalog Graph              Work / Activity Graph
 claims/rules/decisions        systems/services/APIs               goals/tickets/PRs/incidents
 evidence/provenance           resources/domains/owners            meetings/messages/actions
        │                                │                                │
        ├────────────────────────────────┼────────────────────────────────┤
        │                                │                                │
     Code Graph                       Runtime Graph                   Temporal Graph
 symbols/calls/imports          traces/calls/deployments            facts/events over time
 tests/file/line                test/runtime evidence               valid + recorded time
        │                                │                                │
        └───────────────────────┬────────┴─────────┬──────────────────────┘
                                │                  │
                           PPR / paths       Community / global index
                                │                  │
                                └────────┬─────────┘
                                         │
                               Query / Reasoning Planner
                                         │
                    auth + scope + truth + freshness validation
                                         │
           exact / lexical / dense / late interaction / graph / raw
                                         │
                         fusion + rerank + diversity/conflict
                                         │
                            Evidence-aware ContextPacket
                                         │
       Web / API / MCP / IDE agents / coding agents / human workflows
```

The target is one governed context workspace over several explicit representations, not one universal graph. Every derived path still terminates in an evidence-aware, revision-bearing ContextPacket.

## Product planes

```text
┌──────────────────────────────┐
│ DATA / CONTEXT PLANE         │
│ sources · canonical knowledge│
│ indexes · graphs · connectors│
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│ WORKSPACE COORDINATION PLANE │
│ tasks · sessions · claims    │
│ findings · artifacts · handoff│
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│ GOVERNANCE / CONTROL PLANE   │
│ identity · auth · profiles   │
│ review · truth · audit · ops │
└──────────────────────────────┘
```

The planes describe responsibility, not three separate deployments. The coordination plane is not canonical knowledge, and external systems of record retain authority for the objects they own.

## Authority model

| State                     | Authority               | Examples                                                | Can become canonical automatically? |
| ------------------------- | ----------------------- | ------------------------------------------------------- | ----------------------------------- |
| External system of record | external owner          | issue, PR, build, incident, deployment                  | no                                  |
| Canonical AKP knowledge   | managed Git + review    | approved claims, rules, decisions                       | already canonical                   |
| Workspace coordination    | Team Context state      | claims, blockers, findings, handoffs                    | no                                  |
| Derived context           | rebuildable projections | vectors, graphs, communities, summaries, ContextPackets | no                                  |

## Specialized graph model

AKP deliberately avoids one semantically ambiguous graph. The federated graph substrate keeps these domains distinct:

- **Epistemic** — sources, evidence, claims, rules, decisions, support and contradiction.
- **Software Catalog** — declared systems, services, components, APIs, resources and owners.
- **Code** — symbols, definitions, references, calls, imports, tests and immutable Git locators.
- **Runtime** — observed service calls, deployments, test/runtime evidence and incidents.
- **Temporal** — facts and events with valid-time and recorded-time semantics.
- **Work** — goals, work items, pull requests, sessions, people/agents and activity.
- **Community** — rebuildable community, centrality, PPR and derived-summary projections.

Cross-domain relations are typed and provenance-bearing. Catalog declaration, static code structure and runtime observation may disagree; AKP preserves that disagreement instead of flattening it.

## Explicit cross-domain bridges

```text
RULE --applies_to--> SOFTWARE_COMPONENT
DECISION --implemented_by--> CODE_SYMBOL
SOFTWARE_SERVICE --implemented_by--> REPOSITORY
CODE_SYMBOL --validated_by--> TEST_SYMBOL
RUNTIME_SERVICE --observes--> SOFTWARE_SERVICE
PULL_REQUEST --changes--> CODE_SYMBOL
WORK_ITEM --motivates--> DECISION
INCIDENT --affects--> SOFTWARE_SERVICE
MEETING --discussed--> DECISION_CANDIDATE
TASK --touched--> CODE_SYMBOL
```

Bridge relations retain provenance and derivation so cross-domain context does not collapse different evidence classes.

## Runtime components

- `apps/api` — authenticated use cases, authorization, retrieval/planning and policy enforcement.
- `apps/worker` — durable ingest, compilation, projection, assurance and event consumers with leases/fencing/retry.
- `apps/extractor` — provider-neutral Document Intelligence boundary.
- `apps/web` — human workspace and operator surfaces.
- `apps/mcp` and `apps/cli` — bounded clients of the same application rules.
- `packages/*` — domain, persistence, retrieval, graph, code, evaluation and publication modules.
- `contracts/` — versioned API/event contracts.
- `db/` — append-only migrations.

Dependency boundaries are enforced by repository gates rather than by convention alone.

## Canonical and work flow

```text
external system / registered vault / immutable source
  -> authenticated reference or immutable artifact
  -> authorized retrieval / workspace orientation
  -> work context + pinned ContextRevisionSet
  -> findings / code-runtime evidence / decision candidates
  -> governed promotion candidate
  -> deterministic validation + human review
  -> approved managed-Git publication
  -> durable causal events
  -> rebuild/update derived indexes and specialized graphs
  -> truth/support validation before fusion
  -> bounded ContextPacket for humans and agents
```

Capture is not publication. A model may extract, rank, summarize or propose, but it cannot approve its own proposal, invent authorization, upgrade evidence or execute arbitrary SQL/Cypher/shell/filesystem writes.

## Retrieval and reasoning boundary

```text
principal + authorized scopes
            │
            ▼
temporal / profile / revision constraints
            │
            ▼
query shape + intent
            │
            ▼
permitted candidate channels
            │
            ▼
exact · lexical · vector · code · graph · temporal · raw
            │
            ▼
support / truth / freshness validation
            │
            ▼
fusion → optional rerank → dedupe/diversity/conflict coverage
            │
            ▼
bounded Evidence-aware ContextPacket
            │
            ▼
final revision-set verification
```

Authorization, lifecycle, temporal validity and truth support are correctness boundaries. Optional reranking, PPR or community scores can only reorder or discover candidates that remain valid under those boundaries.

Normal retrieval resolves the principal and permitted scope before candidate expansion. It may combine exact/alias, lexical, optional dense, code/symbol, typed graph, temporal, PPR/community and raw/source channels. Truth/freshness validation happens before fusion/rerank.

Reasoning uses a typed, bounded plan with allowlisted operators. Provider output is untrusted input to that plan; it is not an executable command language.

Every strict task can pin a `ContextRevisionSet`. Meaningful changes in truth/profile/policy/index authority are surfaced rather than silently mixed into the task.

## Team Context Node

```text
 Developer laptop / browser / coding agent
                  │
             HTTPS / MCP
                  │
                  ▼
      ┌─────────────────────────────┐
      │ AKP Team Context Node       │
      │ Web · API · MCP · Worker    │
      │ PostgreSQL + pgvector       │
      │ Raw object storage          │
      │ Governed Git knowledge      │
      └──────────────┬──────────────┘
                     │
             bounded federation
                     │
                     ▼
              Org hub / peers
```

Shared writable coordination and derived state has one node authority. Local clients may keep private overlays, approved snapshots and queued drafts, but they do not maintain competing writable copies of the shared database.

## Deployment and federation

`SOLO_LOCAL`, small-team Git synchronization of canonical files, `TEAM_NODE` and `FEDERATED_ORG` are distinct deployment modes.

A Team Node owns shared writable coordination/derived state; clients do not Git-sync PostgreSQL. Federation keeps peer provenance, trust, revision and scope identity and applies local authorization before merged results become usable context.

Optional model/provider routing follows the most restrictive applicable residency policy. An external fallback cannot relax a `LOCAL_ONLY` source, space, organization or profile boundary.

## Governance flow

```text
source / finding / authored draft
             │
             ▼
       candidate change
             │
             ▼
deterministic validation + evidence
             │
             ▼
       isolated Git diff
             │
             ▼
       human/policy review
        │ approve   │ reject/change
        ▼           └───────────────► candidate state
managed Git publication
        │
        ▼
derived projections rebuild/update
```

Capture is not publication. Model/provider output remains untrusted input until deterministic validation and the configured review boundary accept it.

## Recovery boundary

Durable/canonical state is backed up; derived projections are rebuildable. Restore verification covers PostgreSQL, object storage, managed Git and representative rebuilt context.

Projection IDs may change after rebuild when they are explicitly derived, but deterministic semantic outputs must remain equivalent where the product promises determinism.

## Detailed views

- [C4 model](docs/architecture/c4.md)
- [Module boundaries](docs/architecture/modules.md)
- [Runtime flows](docs/architecture/runtime-flows.md)
- [Database ERD](docs/architecture/database-erd.md)
- [Context Fabric](docs/context-fabric.md)
- [Workspace Operating Model](docs/guides/workspace-operating-model.md)
- [Graph Model](docs/guides/graph-model.md)
- [Retrieval & Context Engineering](docs/guides/retrieval-context-engineering.md)
- [Threat model](docs/security/threat-model.md)
- [Architecture decisions](docs/adr/)
- [Current product status](docs/status.md)
