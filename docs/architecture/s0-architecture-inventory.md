# S0 — Audited code map, import surfaces and refactor debt

- Date: 2026-10-08
- Revision inspected: `c2e1552ea66b3b73d909f0ed120da961c1d9a82e` plus the S0 working changes.
- Scope: tracked `apps/` and `packages/` source files, public package manifests, TypeScript import syntax and first-party architectural docs.
- Purpose: **locate and prioritize responsibility violations**, not declare every large file defective, every unused-looking export dead, or every implemented capability valuable.

## Reproduce (no remote services or private corpus required)

```powershell
pnpm boundaries
node scripts/report-architecture-inventory.mjs > .work/s0-inventory-current.json
node scripts/validate-import-surfaces.mjs
node --test scripts/validate-import-surfaces.test.mjs
node scripts/validate-module-boundaries.mjs
```

The inventory reporter is read-only. It must never be used as an automatic deletion script. `.work/` is ignored.

## Static baseline

| Indicator                                                 | Observed | Interpretation                                                                                                           |
| --------------------------------------------------------- | -------: | ------------------------------------------------------------------------------------------------------------------------ |
| Tracked JS/TS/Python source files (`apps/` + `packages/`) |      518 | Includes tests, benchmarks and operational scripts                                                                       |
| Approximate source lines                                  |  197,522 | Counts physical lines, not logical code, comment-free LOC or public API complexity                                       |
| Package manifests                                         |       22 | 5 applications, 17 packages                                                                                              |
| Internal package edges                                    |       49 | Declared internal dependencies; acyclic                                                                                  |
| JS/TS files analyzed for imports                          |      481 | AST static imports/exports + literal dynamic imports/require                                                             |
| Module specifier references                               |    1,863 | Includes relative and external imports                                                                                   |
| Public `@akp/*/subpath` uses                              |       26 | All resolve to **declared package export maps**; valid public interfaces                                                 |
| Cross-root relative imports (test/bench)                  |       15 | Mainly evaluation scripts/fixtures and one worker test; **none of the scanned production sources violated the new gate** |
| Product files at least 650 lines                          |       54 | Decomposition review candidates, not automatic splitting mandate                                                         |
| Identifier-only possible-unconsumed exports               |      566 | **High false-positive potential**, not evidence that 566 exports are dead                                                |

The worker integration test `apps/worker/test/document-artifact.test.ts` directly imports `packages/retrieval/src/chunking.js` to verify render-to-index unitization. Migrating it to the package root would require an otherwise unused worker dependency and possibly a prebuilt artifact; that change failed its test. The cross-module integration test is **recorded as S1 test-placement debt**, not silently converted into a runtime dependency. Cross-root evaluation fixtures remain inventoried rather than hidden in an allowlist. Production source imports now have an executable gate.

### What the new gates prevent

- Imports of undeclared `@akp/*` packages.
- Deep imports through `@akp/*/subpath` unless the target package manifest exports that subpath.
- Runtime source imports that escape one app/package through a relative path.
- Package dependency cycles, imports from packages to apps and new pure-core dependencies on IO modules.

They **do not** detect all duplicated domain rules, runtime dynamic resolution, circular local files, over-broad barrel exports or undeclared dependencies to vendor libraries. Follow-up static/behavioral analysis must not be confused with passing these checks.

## Large modules requiring deliberate owner-by-owner decomposition

| File (current snapshot)                           | Lines | Main concern / stage                                                                     |
| ------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------- |
| `apps/api/src/routes/search.ts`                   | 5,546 | HTTP adapter mixes query planning, retrieval, evidence policy and packet handling; S2/S5 |
| `packages/postgres/src/temporal-truth.ts`         | 2,630 | Persistence and temporal truth breadth; S3/S5                                            |
| `packages/vault-importer/src/index.ts`            | 2,498 | Parsing, identity, storage and projection coupling; S1                                   |
| `apps/worker/src/assurance-worker.ts`             | 2,379 | Many detector/job responsibilities; S4/S5                                                |
| `apps/api/src/routes/reviews.ts`                  | 2,312 | API, publication/review business flow; S3/S5                                             |
| `packages/postgres/src/federated-graph.ts`        | 2,163 | Graph queries, revision policy and persistence; S4/S5                                    |
| `apps/api/src/routes/context-fabric.ts`           | 1,917 | Auth, collaboration and context wiring; S3/S5                                            |
| `packages/retrieval/src/support-verifier.ts`      | 1,835 | Multiple support heuristics/semantics; S2                                                |
| `apps/api/src/routes/sessions.ts`                 | 1,738 | HTTP sessions and coordination; S3                                                       |
| `packages/postgres/src/workspace-coordination.ts` | 1,736 | Claims, fencing and persistence; S3                                                      |
| `packages/retrieval/src/context-packet.ts`        | 1,675 | Full and compact packet assembly; S2                                                     |
| `packages/contracts/src/index.ts`                 | 1,371 | Large contract exports, compatibility ownership; S5                                      |
| `packages/indexing/src/index.ts`                  | 1,304 | Indexing responsibility breadth; S1/S5                                                   |
| `apps/cli/src/main.ts`                            | 1,279 | CLI command dispatch and direct persistence ownership; S5                                |

The line count is a review trigger, **not a hard style gate**. Before splitting a file, identify its invariants, consumers, lifecycle state and current tests; choose one owner and cut over call sites in one change. A split that duplicates behavior across two facades does not improve design.

## Package responsibility map and anomalies

- `@akp/contracts` and `@akp/domain` have no internal dependency edges; keep pure.
- `@akp/application` depends on contracts/domain only: the intended use-case boundary.
- `@akp/retrieval` depends on contracts, yet much execution is currently composed in `apps/api/src/routes/search.ts`. Review whether policy belongs in application/retrieval or HTTP without broadening authorization.
- `@akp/indexing` depends on compiler, retrieval, PostgreSQL, Git and importer: this is a high-fan-in/out orchestration seam. Review in S1 before decomposing.
- `@akp/vault-importer` depends on PostgreSQL and retrieval. Its responsibilities must be verified against extraction, identity and index-publication flow in S1.
- `apps/api` has 14 declared internal package dependencies; likely a composition root, but the 5,546-line search route is a maintainability risk. Prefer use-case services in existing ownership modules, not another API facade.
- `apps/cli` depends directly on PostgreSQL/vault importer despite diagrams calling it an API client. This is a **documented functional/operational exception** to migrate in S5, not a hidden source-level gate exemption.
- Graphify is an external CODE graph extractor and is **not** an alternate document-RAG engine.
- The public `@akp/contracts/knowledge-profile`, `knowledge-profile-compatibility`, `connector-capabilities` and `model-role-policy` exports are deliberate, explicit exports in the manifest, not illicit deep file paths.

## Exports with no visible consumers: classification protocol

The repeatable report uses TypeScript AST for top-level exported symbol declarations and an **approximate** reference scan over tracked TS/JS files. It excludes conventional Next.js route pages/layouts from the first-pass warning. A name not mentioned in another file may still be:

- a public library contract referenced by external consumers;
- a Next.js convention, framework registration, dynamically named action, or schema/serialized callback;
- a type re-exported through a public barrel;
- consumed from generated code or downstream packages absent from this repository;
- needed by test/runtime imports not resolved by a naive identifier search.

Examples to investigate **without immediate deletion**: `apps/worker/src/knowledge-compilation.ts::compileGroundedKnowledgeProposal`, `packages/indexing/src/embedding-generation.ts::createEmbeddingIndexActivator`, `packages/evaluation/src/benchmark.ts::observationsFromGoldCases` and `packages/postgres/src/context-revision-set.ts::currentContextRevisionSet`.

**Disposition:** `CANDIDATE_ONLY`. For each, enumerate import paths, public package exports, type use, generated/runtime references, active callers, tests and deployed APIs before declaring dead. In S5, remove genuinely unconsumed symbols **in the same commit** as their callers/docs; do not create a compatibility alias just to silence typecheck.

## Measured end of S0 vs later work

**Complete within S0:** product objectives from docs, owners/naming/cutover rules, boundary enforcement, source-level import audit, large-file classification, exported-symbol candidate inventory, an executable/reproducible audit path and same-head CI check.

**Explicitly not S0:** measured RAG superiority, external vendor adapter removal, changing default model/vector/OCR provider, schema migrations, multi-agent end-to-end certification, disentangling the search route, or asserting unused exports as dead code. These are S1–S5 activities with their own gates.

Review [core-redesign-execution-spec.md](core-redesign-execution-spec.md) before continuing.
