# AKP core-product redesign — evidence-led reduction roadmap

- **Date:** 2026-10-08
- **Status:** implementation in progress, staged work on draft PR #38; no production-default promotion.
- **Authority:** [ADR 0004](../adr/0004-core-product-scope-and-simplification.md) (proposed); [repository standards](repository-standards.md).
- **Goal:** a maintainable shared knowledge/context workspace for software development teams and coding agents, not a generic graph demo or a document chatbot.

## Product outcome and comparison baseline

**Primary workflow:** A developer or agent starts from an authorized ticket/goal, bootstraps current shared knowledge and relevant repository/PR context, claims a bounded work scope, retrieves cited context without loading the whole vault, makes/verifies changes, hands off resumable state, and promotes durable findings through reviewed Git publication. Other agents then see current approved context without copying chat histories.

**Simple baseline:** an Obsidian/Markdown vault and repository docs with manual search, plus an issue tracker and a fresh agent prompt. AKP earns complexity only by demonstrating a faster, more accurate, fresher and safer end-to-end workflow over that baseline.

Core acceptance measures **must not collapse into one “RAG accuracy” number**:

| Outcome                  | Measurement                                                                                                                 | Evidence required                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Correct task context     | Evidence answer precision, recall of answer-bearing spans, abstention/FAR, citations to current authorized revision         | frozen independent queries, negative cases, source-stratified grading |
| Agent cooperation        | Successfully resume another agent's handoff, overlapping-claim rejection, persisted blockers/findings, permission isolation | API/MCP integration tests and multi-agent workflow exercise           |
| Current documentation    | Approval-to-retrievable-revision time, orphan/expired knowledge, invalidation on source changes                             | publication/outbox + source revision tests                            |
| Reduced repeated context | Actual input tokens, exact model tokenizer, cost/latency, answer/citation coverage compared with raw vault and full packets | paired same-agent same-task A/B                                       |
| External work references | Correct ticket/PR identity, freshness/permission fidelity, deletion/revocation behavior                                     | provider sandbox/account evidence or explicit simulated-only label    |
| Source fidelity          | Page/table/row/heading preservation, locator replay, incomplete extraction rate                                             | format-diverse real/synthetic fixtures, OCR where required            |
| Cost and operations      | Total CPU/GPU/RAM, p95 end-to-end, deployment/recovery steps, model/provider licenses                                       | reproducible operator profile and SBOM/license audit                  |

Previously measured F3 evidence precision **AI 51/72 = 70.83%** (Wilson simple lower 59.49%, not a design-correct interval). Technical 52/90 gold-unit admission is a different endpoint; neither satisfies an end-to-end user-workflow KPI. These figures describe **frozen baseline a4dbdfff**, not the newly added optional PR improvements.

## Supported core / optional / unproven inventory

| Slice                                                                              | Status based on repository/source inspection                                             | Target                                                                  |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Managed Git knowledge, human review, publication/rollback                          | Implemented; tests and documented causal outbox path                                     | **KEEP CORE**, verify deployment and doc freshness                      |
| Team Context session, scoped agent principals, claims/fencing, structured handoffs | Implemented and exercised by tests; live multi-team benefit not measured                 | **KEEP CORE**, make first-party journey the main UX                     |
| API/Web/MCP and compact ContextPacket                                              | Implemented; token estimate fallback is approximate `char/4`                             | **KEEP CORE**, measure actual token savings with stable answer coverage |
| Permission-scoped exact/lexical/vector retrieval                                   | Implemented; vector is optional, default off in example                                  | **KEEP CORE**, validate active deployment profile                       |
| Document Artifact -> faithful Markdown, OCR provider routing                       | Implemented, optional heavyweight providers; historical incomplete Docling page detected | **KEEP CORE**, verify same faithful source path with compiler ON/OFF    |
| Generative knowledge compiler                                                      | Implemented and review-gated, config may disable                                         | **OPTIONAL** proposal enrichment, never substitute immutable extraction |
| Graphify CODE graph                                                                | Integrated and version-pinned, separate from document RAG                                | **KEEP CONDITIONAL** for code-impact flow                               |
| Community/PPR/GLOBAL/DRIFT, temporal/federation/many specialized graph paths       | Interfaces, tests, and some benchmarks exist; everyday task lift not demonstrated        | **NOT DEFAULT**; preserve only where demonstrated, retire independently |
| Marker/Chunkr adapters                                                             | Present and tested, provider extras/service not base-installed                           | **RETIRE CANDIDATES** if zero live consumers and no measured advantage  |
| Alternative QA/NLI, translation, LAYERED new policies                              | Experimental/shadow/opt-in; translation F6 rejected                                      | **NOT DEFAULT**, isolate from core until independent evidence           |
| Jira/Linear adapters                                                               | Read-only simulated CI; real provider account/sandbox validation pending                 | **CONDITIONAL** read-only, show status, no implied write-back           |
| GraphRAG, Graphiti, LlamaIndex, Haystack comparator references                     | Not direct active dependencies                                                           | **DO NOT INSTALL** simply to increase dependency count                  |

## Non-negotiable invariants

1. A source's immutable SHA and locators survive extraction, source Markdown, retrieval and citation.
2. Derived summaries/graph edges and work notes do not become approved knowledge without deliberate review.
3. Team sessions pin source/profile/policy/index revisions; agents cannot bypass scope by traversing graphs or external integrations.
4. Concurrent agent work uses database-backed lease/fencing, not prompt agreements.
5. External tickets/PRs/builds remain provider-owned; AKP caches scoped references and records freshness.
6. Failures must be visible; an unavailable OCR or LLM never fabricates success.
7. No unbounded data, token or provider fan-out; speed savings cannot be purchased by silent answer omission.
8. Replacement removes old implementations/config/test paths after a documented migration, rather than supporting them indefinitely.

## Implementation slices (one behavior change at a time)

### S0 — Architecture boundaries and product scope (FIRST COMMIT)

- [x] Reconstruct primary user journeys from first-party project docs; ADR 0004 and this roadmap.
- [x] Define module ownership/naming/cutover guidance.
- [x] Make package manifest dependency graph and pure-module dependency boundaries executable; enforce in `pnpm boundaries` with failure tests.
- [x] Confirm CI on exact pushed SHA `6b54e2b38d6e117c4a7751d3fdde193ce52d5309`.
- [x] Inventory source-level deep imports, large cross-domain files and exported symbols with no visible consumers; classify without automatic deletion. See [S0 architecture inventory](s0-architecture-inventory.md) and the reproducible report script.
- [x] Publish [the multi-agent execution specification](core-redesign-execution-spec.md), with stage-level acceptance, migrations, tests and handoffs.
- **Verified CI evidence (2026-10-08):** On exact SHA `6b54e2b38d6e117c4a7751d3fdde193ce52d5309`, GitHub Actions `ci` run `37869858647` concluded `success`; its `typescript` job passed `pnpm check`, formatting, docs validation, hygiene, build and integration. All triggered required workflows concluded `success`; opt-in skipped workflows do not count as executed validations. This records S0 implementation evidence, not S1 source fidelity or retrieval precision. Any later SHA needs fresh same-SHA validation.
- **Done when:** the boundary and import-surface gates pass on the exact final CI SHA, the source inventory is repeatable and no production defaults changed.

### S1 — One reliable source-to-context path

- [ ] Verify source import and generated compiler paths persist/retrieve the same intact source projection; source Markdown **cannot** depend on LLM availability.
- [ ] Define single typed SourceArtifact → SourceMarkdown → KnowledgeUnit mapping with source hash, page/table/row/span locators. Audit publication/approval transitions and avoid writing machine extracts as approved claims.
- [ ] Fix proven omissions and delete superseded duplicate paths in the same commit. Use append-only schema migration and one-time backfill if persisted source contract changes.
- [ ] Integrate real PDF/MD/DOCX/scanned fixture tests: page/table preservation, corrupt PDF, unconfigured OCR, source revision changes.
- **Done when:** no source facts lost silently, no duplicate source authority and both compiler modes have equivalent source completeness.

### S1.1–S1.10 implementation audit (2026-10-11)

This reconciliation is an **implementation and coverage audit, not S1 acceptance**. The unmodified baseline `6756b9c99bb7428c9330376ff7eb40189ebc34c9` passed the five CI jobs and all 14 required same-SHA workflows, including the real Docling/Tesseract OCR E2E with natural API/database closure. The next S1 fidelity change (`afb19e564f476322ef1d9efc71edc53870698b69`) repairs an independently reproduced deterministic-DOCX reading-order defect. Its own checks must be evaluated on a subsequent exact final SHA.

- **S1.1 (trace):** source ID, raw digest, MinIO key, structured artifact, human review and source read paths are recorded in the source-to-context trace and integration tests.
- **S1.2 (compiler independence):** the single verified faithful Markdown projection precedes the optional compiler. Two isolated real raw-file ingests prove OFF versus loopback-mocked ON equivalence; this does not measure semantic generation quality.
- **S1.3 (typed source):** source artifact identity, extractor/configuration and structural digest, persisted Markdown hash, locator replay and separate `source_projection_units` are implemented. Neither machine extracts nor these units are approved Git knowledge.
- **S1.4 (explicit failures):** OCR-required routing fails when unavailable, partial/no-text PDF warnings exist, and corrupt stored structured digests make reads fail closed. The active deterministic text path now labels invalid UTF-8 replacement as lossy machine extraction rather than `EXACT_TEXT`. General OCR accuracy and all degraded page layouts remain unmeasured.
- **S1.5 (tables and order):** a real generated interleaved DOCX exposed a defect: the deterministic extractor moved every table after every paragraph. The patch iterates actual body order and tests two interleaved tables, heading-scoped locators and cell preservation. A subsequent S1.5 fix respects explicit DOCX `w:tblHeader` flags and retains all rows when no native header is declared. Merged/ragged layouts and broader format-stratified acceptance evidence remain open.
- **S1.6 (passages):** revision-scoped source units preserve exact UTF-16 character spans and SHA, including content past the operator preview. `source:read`, wrong-source and stale-revision denials have PostgreSQL/API coverage.
- **S1.7 (revisions):** re-ingestion of a verified immutable original, read-time digest quarantine and pinned source-unit reads are tested. Comprehensive changed-source-to-reindex/invalidation equivalence is not yet certified.
- **S1.8 (migration/removal):** migrations 091/092 and guarded one-artifact dry-run/apply backfill are tested, including idempotency and corrupt artifact refusal. The unconsumed legacy `apps/extractor/app/extractors/` flattened modules and sole legacy `test_text.py` have now been removed after a Python runtime/test and repository-code caller inventory; the canonical deterministic adapter has a replacement regression. Public compatibility `Artifact` remains because it serves the API projection. Full repo/module removal inventory and release cutover remain subject to final same-SHA CI.
- **S1.9 (fixture diversity):** synthetic digital two-page PDF, real DOCX, raster OCR, long Markdown, bad identity/hash and damaged projection cases exist. Complex real-world documents, partial-provider failures and exhaustive page/table quality are not proven by the sample.
- **S1.10 (ON/OFF):** persisted-stage and real ingest parity tests verify Markdown bytes/hash and locators with a mocked loopback model; no claim that the mock proves generation quality.

**Open S1 exit gate:** complete format-stratified fidelity and negative-case proof, demonstrate changed-source revision/reindex behavior, inventory superseded code paths and obtain all required CI workflows on the final implementation SHA. S2 remains blocked until these source-integrity criteria are met. No model/provider/production default is promoted.

### S2 — Evidence precision and compact context, not new heuristics

- [ ] Use exact answer-bearing source spans on new independent positive/negative multilingual holdouts (not F3 tuning).
- [ ] Compare **one** maintained reader/verifier to a published specialized alternative, while holding candidates/model budget constant. Keep failing question class taxonomy, not corpus-specific rules.
- [ ] Measure full-vault/manual-search vs compact packet vs selected excerpts with **real model tokens** and answer accuracy held constant; remove approximation claims or label them.
- [ ] Remove rejected shadow/translation alternatives and aliases after proof of zero consumers; do not keep renamed legacy implementations.
- **Done when:** evidence gate passes prespecified precision, FAR and latency plus measured token saving with no loss of answer coverage.

### S3 — Multi-agent working loop and shared docs freshness

- [ ] Walk a real task through ticket reference → bootstrap → claim → CODE/SEARCH → finding → structured handoff → resumed agent → review → Git publication → next bootstrap.
- [ ] Test two concurrent principals, expired fence, revocation, revision conflict, blocked handoff and recovery after worker restart.
- [ ] Simplify MCP action surface and duplicated API/Web business rules; keep a single application use-case owner.
- [ ] Measure multi-agent resume success and documentation staleness against manual Obsidian + issue tracker workflow.
- **Done when:** concrete end-to-end scenario is repeatable and measurable, not just independent endpoint checks.

### S4 — Connector and optional-provider reduction

- [ ] Instrument sanitized capability activation/selection counters by deployment profile, with no source contents or credentials; inventory deployed consumers.
- [ ] Compare deterministic/Tesseract/Docling/Marker/Chunkr by document class, page/table fidelity, latency, RAM, data residency and exact code/weight licenses.
- [ ] Retire unused providers **completely** (package extra, registry registration, schema option, runtime adapter, fixtures, docs), after a communicated breaking version if public API exposed.
- [ ] Jira/Linear remain read-only until sandbox validation; no speculative ticket automation or implied write-back.
- [ ] Keep graph/community/federation only where incremental benefits are measured on a real workflow.
- **Done when:** default installation exposes only proven providers and optional APIs are intentional, not dead promises.

### S5 — Contract consolidation, code health and release

- [ ] Map actual dependencies and source imports, remove unneeded adapters/barrels/dual code paths and name drift.
- [ ] Migrate the CLI persistence exception into a clear administrative use case, then enforce its new boundary; no future permanent exception.
- [ ] Remove redundant experimental scripts/options from supported product surface after coverage and data migration; retain historical results as separate archived evidence where needed.
- [ ] Verify build, typecheck, format, license/SBOM, security, API/MCP docs, CI, disposable-data migration, restore and live Team Node integration verification.
- **Done when:** architecture diagram reflects actual imports, docs reflect shipped/default behavior and users have explicit upgrade notes.

## Change sequencing and removal protocol

For every slice record a small PR/commit note with **current owners and callers → replacement API/state → migration/backfill → cutover → deletion → tests/measurements → rollback**. Avoid implementing parallel legacy and new pipelines as a safety blanket. A data schema can keep a temporary read-backfill interface only during a **named bounded upgrade**, never as a permanent silent fork.

The PR #38 remains a draft and cannot merge automatically. The original F3/F4 owner-acceptance gates stay reported explicitly; this redesign must not relabel failure as success. Broad destructive removals and default promotions need their own verified cutover even when planned here.

## Evidence and references

- Product: [README](../../README.md), [Architecture](../../ARCHITECTURE.md), [Workspace Operating Model](../guides/workspace-operating-model.md), [Team Context](../guides/team-context.md), [Coordination Plane](../guides/coordination-plane.md), [Agent Integration](../guides/agent-integration.md), [Connector Contract](../guides/connector-contract.md).
- Runtime: [runtime-flows.md](runtime-flows.md), [modules.md](modules.md), [retrieval-context-engineering.md](../guides/retrieval-context-engineering.md), [ingestion-chunking-audit.md](ingestion-chunking-audit.md).
- Local private F3 semantic review (not committed): `.work/retrieval-quality-closure/rqc-f3-ai-aggregate-local.json` in integration worktree.
