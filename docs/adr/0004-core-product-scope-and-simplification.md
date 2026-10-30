# ADR 0004 — Shared engineering context is the product; retrieval is a capability

- Status: proposed (architecture redirection started, product-wide removals not yet approved)
- Date: 2026-10-08
- Scope: AKP v0.4+, pre-1.0

## Context

AKP accumulated a broad Context Fabric: ingestion, knowledge compilation, search, specialized graphs, code, temporal/runtime/work projections, coordination, federation, connectors and assurance. A passing capability test does not prove that every channel improves ordinary engineering work. The central product outcome has become less visible than optional subsystems.

Existing contracts already establish governed Git/Markdown knowledge, durable coordination, source-of-record integrations and agent-facing MCP/ContextPackets. A plain Obsidian vault stores files and links, but does not itself provide permission-scoped multi-agent handoffs, revision-pinned evidence, external work context or coordinated publication. AKP must validate its value against **that simple baseline**, not only against previous AKP releases.

Frozen F3 AI review of LAYERED citations: 51/72 ANSWERS, 16 RELATED_NOT_ANSWERING, 5 WRONG; numeric precision criterion unmet. This is AI review, not independent human certification, and does not prove additional graph/OCR tools improve answers.

## Decision

AKP is a **shared, governed engineering knowledge and work-context workspace** for software teams, humans and AI agents. Essential journeys:

1. Import a read-only vault or ingest documents; retain immutable originals, faithful source-located readable projections, and governed knowledge.
2. Find the smallest authorized, current, answer-bearing evidence for a concrete engineering task.
3. Bootstrap an agent against pinned revisions, acquire a work claim, capture findings and hand off to another person/agent without chat transcripts.
4. Evolve shared documentation/decisions through proposal, review, Git publication, invalidation and subsequent retrieval.
5. Connect tickets, PRs, repositories, builds, deployments and runtime observations as **references to external systems of record**, not competing lifecycles.

Keep state classes distinct: **SOURCE** immutable original/extraction; **KNOWLEDGE** reviewed Git Markdown; **WORK** durable coordination; **DERIVED** replaceable indexes/model summaries/ContextPackets; **EXTERNAL** provider-owned records with ACL/freshness limits. Nothing model-generated promotes itself to authority.

**Answer precision**, **workflow outcomes**, **knowledge freshness** and **token efficiency** are separate KPIs. Markdown conversion is not automatically compression. ContextPackets save context bytes only if they preserve answer-bearing source citations.

## Constraints

- Modular monolith and a Team Node as shared write owner; do not add microservices for each AI capability.
- Authorize before retrieving; revisions/truth/citations remain source-bound.
- Preserve Git source-of-truth, work DB and immutable raw store as separate authorities.
- Keep one maintained implementation per accepted behavior. Breaking changes require one explicit migration/cutover and deletion of replaced code and tests; **no indefinite legacy adapters/dual writes**.
- Keep adapters only for actively used supported workflows or independently demonstrated value, with license/model-weight/residency review.
- Experimental capability is not a production default merely because tests pass.

## Consequences

Keep shared coordination, MCP/API/Web, Git publication, source provenance and permission-scoped retrieval. Evaluate advanced graph/global/federation/provider channels as separately justified capabilities. Graphify remains a CODE specialist, not a RAG proof engine. No LAYERED or extraction-default promotion by this ADR.

Implementation sequence: [core-redesign-roadmap.md](../architecture/core-redesign-roadmap.md). Rules: [repository-standards.md](../architecture/repository-standards.md).
