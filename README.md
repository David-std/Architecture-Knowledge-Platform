# Architecture Knowledge Platform

Architecture Knowledge Platform (AKP) is a local-first, governed context workspace for humans and AI agents. It connects approved knowledge, software structure, work state, runtime observations and external systems without replacing their authority.

Approved Markdown in managed Git is canonical knowledge. PostgreSQL, lexical/vector indexes, specialized graphs, community/PPR state, ContextPackets and caches are operational or derived state that can be rebuilt.

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

## Requirements

- Node.js 24 LTS (`>=24 <25`)
- pnpm 10.34.5
- Python 3.12 for the extractor
- Docker with Compose

## Quick start

```powershell
Copy-Item .env.example .env
docker compose up -d --build --wait postgres minio extractor
pnpm install --frozen-lockfile --strict-peer-dependencies
pnpm db:migrate
pnpm verify:runtime
```

Start the API, worker and Web application in separate terminals:

```powershell
pnpm --filter @akp/api dev
pnpm --filter @akp/worker dev
pnpm --filter @akp/web dev
```

Local services bind to loopback by default. Configure credentials, allowed source roots and optional providers in `.env`; do not commit private values.

For a shared deployment, follow the [Enterprise Deployment Guide](docs/guides/enterprise-deployment.md) and [Team Context Guide](docs/guides/team-context.md) instead of synchronizing writable database files between workstations.

## Import a vault

Vaults are registered explicitly and imported read-only. Use any local path appropriate to the installation:

```powershell
pnpm akp vault import `
  --vault-path <path-to-your-vault> `
  --space-id <authorized-space-uuid> `
  --read-only
```

Import reports are runtime artifacts and are written under `reports/migration/` unless another report directory is selected.

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
