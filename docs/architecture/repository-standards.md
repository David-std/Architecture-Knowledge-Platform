# Repository architecture and maintainability standard

**Status:** working standard for new/refactored code; behavioral changes require tests, measured evidence and explicit migration.

## Ownership

AKP is a **modular monolith** with API, worker, extractor, Web and operational MCP/CLI clients.

| Module                                                              | Owns                                                | Must not own                                             |
| ------------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------- |
| `packages/contracts`                                                | Serializable schemas and public contracts           | SQL, providers, orchestration                            |
| `packages/domain`                                                   | Domain invariants and value concepts                | network, process env, model inference                    |
| `packages/application`                                              | Use-case policies and ports                         | Fastify route code or concrete DB/HTTP                   |
| `packages/retrieval`                                                | Pure ranking, source-span evidence, packet assembly | authorization grants, DB connections or canonical writes |
| `packages/compiler`                                                 | Grounded, reviewable knowledge proposals            | approval or publication                                  |
| `packages/indexing`                                                 | Revision-aware projection maintenance               | source-of-truth decisions                                |
| `packages/postgres`, `git-store`, `object-store`, `project-adapter` | IO implementations/external integrations            | semantic/policy authority                                |
| `apps/api`                                                          | authentication, authorization, HTTP composition     | OCR implementation and duplicate business rules          |
| `apps/worker`                                                       | durable jobs, ingestion, projection and retries     | self-publication of knowledge                            |
| `apps/extractor`                                                    | file parsing/OCR and source locations               | approved claims, vector search                           |
| `apps/mcp`, `apps/cli`, `apps/web`                                  | clients/operator interfaces                         | separate authorization/truth systems                     |

**Existing exception to address:** CLI directly imports `@akp/postgres` and `@akp/vault-importer`, whereas the architecture overview calls it an API client. Identify CLI bootstrap/maintenance tasks before moving them to shared application use cases. This is debt, not justification for duplicate logic.

## Dependencies and enforceable gates

- Pure modules depend only on declared contracts/domain. No package imports an app. Declared internal package graph must have no cycles or missing targets.
- `dependency-cruiser.cjs` validates source-level imports; `scripts/validate-module-boundaries.mjs` validates package manifests and pure-module boundaries. Both run via `pnpm boundaries`, including targeted mutation tests.
- Manifest checks are **not** proof of every implementation-level layering rule. Tighten as callers migrate; never add blanket permanent exceptions for historical violations.
- Use intentional package exports, not arbitrary cross-package deep source imports. New external dependencies require a user journey, measured need, code/model-weight license, deployment/credential residency, test and removal plan.

## Names, responsibilities and code

- File names: `kebab-case.ts` / `kebab-case.py`; types `PascalCase`; functions/variables `camelCase`; constants `UPPER_SNAKE_CASE`.
- Prefer concrete domain verbs: `publishReviewedKnowledge`, `buildContextPacket`, `acquireWorkClaim`. Do not add `processV2`, `newFix`, `commonUtils`, `legacyHandler`.
- One cohesive owner per business behavior; avoid duplicated versions in API, MCP, worker and UI.
- Introduce `*Port` for a necessary testable dependency inversion, not for every class. Name `*Adapter` only for a real external protocol or IO boundary.
- Keep public exports small; avoid giant barrel re-exports and catch-all service files. Split by coherent behavior, not arbitrary line counts.
- Validate untrusted input at the boundary. Typed errors and fail-closed permission/revision/source checks must survive refactors. Do not let generated source text modify policy.

## State and evolution

- One source of authority: reviewed knowledge in managed Git; immutable originals in object store; work claims/handoffs in DB; search/graph/model projections rebuildable.
- Explicitly distinguish extracted source, attributed machine summary, reviewed claim and external reference in contracts/UI/traces.
- Atomic or outbox-backed publication, idempotent durable jobs, bounded fanout/time/memory; maintain exact revision and authorization fences.
- Approximate token budgets cannot be advertised as actual consumption. Benchmark with target model tokenizer and stable answer/citation quality.
- Documentation and contract changes accompany behavior changes in the **same PR**.

## Refactor without permanent legacy

1. Inventory real callers, persisted data, API/MCP/Web clients and deployed consumers. Freeze the behavior worth keeping.
2. Choose one target implementation, state owner, migration and release cutoff.
3. Migrate all owned call sites; remove superseded adapters, config flags, aliases, docs and tests as a **single cutover** where possible.
4. For persistent schema changes, use an append-only migration and validated backfill/reindex. A temporary reader bridge must have a specific deletion release, not indefinite compatibility.
5. If the cutover cannot be done safely, postpone it. Do not add a third adapter as camouflage.
6. Test authorization, revision, source fidelity, concurrency and negative cases; do not claim productivity/precision from a green unit suite.

## PR checklist

What core journey improves? What was removed or simplified? Which module owns the behavior? What are the target metrics and independent baseline? How are security/authority/revisions preserved? What is the migration and rollback procedure? Which focused and CI tests passed?

See [core-redesign-roadmap.md](core-redesign-roadmap.md).
