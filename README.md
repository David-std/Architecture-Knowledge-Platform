# Architecture Knowledge Platform

![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-24-339933?logo=nodedotjs&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-16-000000?logo=nextdotjs&logoColor=white)
![Fastify](https://img.shields.io/badge/Fastify-5-000000?logo=fastify&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16%20%2B%20pgvector-4169E1?logo=postgresql&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)
![MCP](https://img.shields.io/badge/Model%20Context%20Protocol-1.30-6B5BFF)

Architecture Knowledge Platform (AKP) is a local-first, governed **Context Workspace and Context Fabric** for software teams, humans and AI agents. It connects approved knowledge, software structure, work state, runtime observations and external systems without replacing their authority.

Approved Markdown in managed Git is canonical knowledge. PostgreSQL, lexical/vector indexes, specialized graphs, community/PPR state, ContextPackets and caches are operational or derived state that can be rebuilt.

> **AKP is the context workspace between systems of record and AI agents.** It connects authorized work activity to approved knowledge, code structure, runtime evidence and decisions without turning retrieval output into authority.

## Architecture at a glance

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

The graph domains remain distinct on purpose: a catalog declaration, static code edge, runtime observation, temporal fact and approved knowledge assertion are different evidence classes even when they describe the same system.

## What the platform provides

- Versioned Knowledge Profiles, including a first-party Software Delivery Workspace Profile.
- Shared Team Context with pinned revisions, scoped human/agent principals, work claims, lease/fencing, structured handoffs and offline snapshots.
- Permission-aware exact, lexical and optional semantic retrieval with bounded ContextPackets, progressive disclosure and retrieval traces.
- Specialized Epistemic, Software Catalog, Code, Runtime, Temporal, Work and Community graph domains instead of one ambiguous everything-graph.
- Deterministic code intelligence through a bounded Graphify adapter, plus symbol, path, callers/callees, impact, change-impact, test and evidence queries.
- Bi-temporal truth, point-in-time retrieval, supersession/invalidation and support validation before ranking.
- Optional community/PPR/global/DRIFT retrieval, reranking and query transformations behind explicit policy and benchmark gates.
- Typed bounded reasoning plans with allowlisted operators rather than arbitrary model-generated SQL, Cypher, shell or filesystem writes.
- Governed proposal, review, publication and rollback workflows backed by Git.
- Generic connector contracts, authenticated webhook/inbox ingestion and bounded node federation with preserved remote provenance.
- Role-aware model routing and residency enforcement with explicit degraded behavior.
- Continuous Assurance, operator diagnostics, OpenTelemetry, backup/restore and reproducible evaluation workflows.
- Human surfaces through Web plus API, CLI and MCP interfaces over the same application rules.

## Architecture boundary

AKP keeps three planes separate:

- **Data / context plane** — sources, approved knowledge, projections, specialized graphs and connectors.
- **Workspace coordination plane** — active tasks, claims, findings, blockers, artifacts and handoffs.
- **Governance / control plane** — identity, authorization, profiles, review, publication, temporal truth, audit, model policy and federation policy.

External systems remain systems of record for the objects they own. Workspace state is not approved knowledge, and a derived summary or high retrieval score never creates authority.

## How AKP is used

AKP is task-oriented rather than graph-oriented. A normal human or agent workflow is:

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

A serious task starts by bootstrapping authorized context and pinning a `ContextRevisionSet`. Work findings remain coordination state until an explicit promotion and review turns selected evidence-backed material into approved knowledge.

Typical agent-oriented operations are `BOOTSTRAP`, `SEARCH`, `EXPLAIN`, `CODE`, `IMPACT`, `TEMPORAL`, `GLOBAL`, `VERIFY` and `STATUS`.

AKP does not replace GitHub, Jira/Linear, CI/CD, observability, chat or service catalogs. Those systems keep authority for the objects they own; AKP assembles the authorized, current and supportable context needed to act on them.

## Product surfaces

The same governed application rules are exposed through several surfaces:

- **Web** — workspace home, authoring, search, ingest/jobs, sources, reviews, decisions, work items, services, agent sessions, graph views, evaluations and administration.
- **API** — Fastify HTTP API on port `8080` by default.
- **CLI** — operational and vault commands through `pnpm akp ...`.
- **MCP** — stdio server for AI/coding agents, including the lower-entropy `akp_context` façade.
- **Worker** — durable background processing for compilation, indexing and related jobs.

The Web application runs on port `3000` by default and uses the same API and authorization model as CLI/MCP clients.

## Requirements

- Node.js 24 LTS (`>=24 <25`)
- pnpm 10.34.5
- Python 3.12 for the extractor
- Docker with Compose

An external model API is **not required** for the base platform. The checked-in development configuration starts with:

```text
AKP_LLM_PROVIDER=disabled
AKP_VECTOR_ENABLED=false
```

Model-backed compilation, semantic retrieval and other optional provider capabilities can be enabled later. Provider availability never grants publication authority.

## First run

### 1. Create local configuration

```powershell
Copy-Item .env.example .env
```

Before provisioning authentication, replace `AKP_API_TOKEN` in `.env` with a non-default random secret of at least 24 characters.

The default development scope targets the local bootstrap space:

```text
00000000-0000-0000-0000-000000000003
```

The example scope is intentionally read-oriented. Expand permissions only when the local workflow actually requires them.

### 2. Start local infrastructure

```powershell
docker compose up -d --build --wait postgres minio extractor
```

This starts:

- PostgreSQL 16 with pgvector on `127.0.0.1:55432`;
- MinIO object storage on `127.0.0.1:19000`;
- MinIO console on `127.0.0.1:19001`;
- the extractor on `127.0.0.1:8090`.

### 3. Install, migrate and provision the local credential

```powershell
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm db:migrate
pnpm auth:provision
pnpm verify:runtime
```

Migrations create the local bootstrap organization, administrator and space. `auth:provision` stores the configured token hash and explicit scopes; it does not store the plaintext token.

### 4. Start AKP

Run the API, worker and Web application in separate terminals:

```powershell
pnpm --filter @akp/api dev
```

```powershell
pnpm --filter @akp/worker dev
```

```powershell
pnpm --filter @akp/web dev
```

Open:

- Web: `http://127.0.0.1:3000`
- API: `http://127.0.0.1:8080`

If no browser session exists, the Web application redirects to `/login`. Paste the configured `AKP_API_TOKEN`; the API exchanges it for an HttpOnly browser session and subsequent Web writes use CSRF protection.

A fresh install is intentionally sparse. AKP does not currently seed a product-demo workspace automatically; import/register real or sample knowledge to make retrieval, work and review surfaces meaningful.

## Import a vault

Vaults are registered/imported explicitly and the source remains read-only. The bootstrap development space is `00000000-0000-0000-0000-000000000003`.

```powershell
pnpm akp vault import `
  --vault-path <path-to-your-vault> `
  --space-id 00000000-0000-0000-0000-000000000003 `
  --read-only
```

Inspect registered vaults and obtain the vault ID:

```powershell
pnpm akp vault list `
  --space-id 00000000-0000-0000-0000-000000000003
```

Vault import and vault authorization are deliberately separate. Grant the local bootstrap administrator access to the imported vault:

```powershell
pnpm akp vault grant-access `
  --user-id 00000000-0000-0000-0000-000000000002 `
  --vault-id <imported-vault-uuid> `
  --role VIEWER
```

Use `CONTRIBUTOR`, `REVIEWER` or `ADMIN` only when the workflow needs those permissions.

Import reports are runtime artifacts and are written under `reports/migration/` unless another report directory is selected.

## Connect an AI agent through MCP

AKP's MCP server uses stdio. An MCP-capable client should launch the server from the repository root with:

```text
pnpm exec tsx apps/mcp/src/server.ts
```

and provide:

```text
AKP_API_URL=http://127.0.0.1:8080
AKP_API_TOKEN=<scoped-token>
```

The agent talks to the same governed API as the Web application. General-purpose clients can prefer `akp_context`; expert MCP tools remain available for specialized operations.

A common agent lifecycle is:

```text
BOOTSTRAP -> CODE/IMPACT -> work locally -> VERIFY
          -> CAPTURE or HANDOFF -> optional PROMOTION
```

Retrieved text is data, not an instruction channel. MCP access does not allow an agent to approve its own proposal, widen its scope or publish canonical knowledge.

## Deployment modes

| Mode                  | Shared writable state       | Intended use                               |
| --------------------- | --------------------------- | ------------------------------------------ |
| `SOLO_LOCAL`          | local workstation           | one developer / private context            |
| `GIT_SYNC_SMALL_TEAM` | derived state remains local | small team sharing canonical Git knowledge |
| `TEAM_NODE`           | one authoritative node      | normal shared-team deployment              |
| `FEDERATED_ORG`       | one authority per node      | independently governed teams/org domains   |

The recommended shared-team topology is a Team Context Node; writable PostgreSQL/pgvector state is never synchronized between laptops.

## Shared deployment

For a shared team installation, use the Team Context Node topology rather than synchronizing writable databases or derived indexes between developer machines.

The checked-in `docker-compose.team-node.yml` overlay runs migration, API, worker and Web services against one shared node authority.

Follow the [Enterprise Deployment Guide](docs/guides/enterprise-deployment.md), [Team Context Guide](docs/guides/team-context.md) and [Workspace Operating Model](docs/guides/workspace-operating-model.md) for production-oriented configuration.

## Quality gates

```powershell
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm audit --audit-level high
pnpm format:check
pnpm security:secrets
pnpm contracts:validate
pnpm docs:validate
pnpm hygiene:validate
pnpm check
pnpm build
pnpm test:integration
```

Runtime, provider and recovery changes also use the relevant maintained benchmark, resilience and restore workflows. A green typecheck alone is not capability evidence.

## Documentation

Start with:

- [Architecture](ARCHITECTURE.md)
- [Current capabilities and limits](docs/status.md)
- [Workspace Operating Model](docs/guides/workspace-operating-model.md)
- [Software Delivery Workspace Profile](docs/guides/software-delivery-workspace-profile.md)
- [Coordination Plane](docs/guides/coordination-plane.md)
- [Connector Contract](docs/guides/connector-contract.md)
- [Retrieval & Context Engineering](docs/guides/retrieval-context-engineering.md)
- [Graph Model](docs/guides/graph-model.md)
- [Temporal Truth](docs/guides/temporal-truth.md)
- [Agent Integration](docs/guides/agent-integration.md)
- [Federation](docs/guides/federation.md)
- [Operations & Recovery](docs/guides/operations-recovery.md)
- [Threat model](docs/security/threat-model.md)
- [Contributing](CONTRIBUTING.md)
- [Release history](CHANGELOG.md)

## Design boundary

Imported vaults, source content, model output and connector payloads are inputs, not product configuration or authority. The generic runtime does not assume a particular organization, corpus, repository layout, course or developer workstation.
