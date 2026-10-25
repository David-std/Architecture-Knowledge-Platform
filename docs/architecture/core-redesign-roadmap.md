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

- [x] Verify source import and generated compiler paths persist/retrieve the same intact source projection; source Markdown **cannot** depend on LLM availability.
- [x] Define single typed SourceArtifact → SourceMarkdown → KnowledgeUnit mapping with source hash, page/table/row/span locators. Audit publication/approval transitions and avoid writing machine extracts as approved claims.
- [x] Fix proven omissions and delete superseded duplicate paths in the same commit. Use append-only schema migration and one-time backfill if persisted source contract changes.
- [x] Integrate real PDF/MD/DOCX/scanned fixture tests: page/table preservation, corrupt PDF, unconfigured OCR, source revision changes.
- **Done when:** no source facts lost silently, no duplicate source authority and both compiler modes have equivalent source completeness.

### S1.1–S1.10 implementation audit (2026-10-11)

This implementation and coverage audit is now supported by a **bounded S1 acceptance baseline**, not a claim of universal document fidelity. On exact code SHA `12749df7a0708dbb278fbc6cc6b24efcd2dbc322`, all five CI jobs and all 14 required workflows concluded `success`, including the real Docling/Tesseract OCR end-to-end job, PostgreSQL/MinIO/API source-revision and compiler-mode tests, and same-SHA release assurance. The previous SHA `6756b9c99bb7428c9330376ff7eb40189ebc34c9` remains historical evidence only. A documentation-only sign-off SHA needs its own required workflow completion before the final PR checkpoint is marked accepted.

- **S1.1 (trace):** source ID, raw digest, MinIO key, structured artifact, human review and source read paths are recorded in the source-to-context trace and integration tests.
- **S1.2 (compiler independence):** the single verified faithful Markdown projection precedes the optional compiler. Two isolated real raw-file ingests prove OFF versus loopback-mocked ON equivalence; this does not measure semantic generation quality.
- **S1.3 (typed source):** source artifact identity, extractor/configuration and structural digest, persisted Markdown hash, locator replay and separate `source_projection_units` are implemented. Neither machine extracts nor these units are approved Git knowledge.
- **S1.4 (explicit failures):** OCR-required routing fails when unavailable; partially blank PDFs record page-specific warnings, while wholly empty Markdown/DOCX/PDF results now fail with `DOCUMENT_EXTRACTION_EMPTY` before persistence. Corrupt stored structured digests also fail closed. The active deterministic text path now labels invalid UTF-8 replacement as lossy machine extraction rather than `EXACT_TEXT`. General OCR accuracy and all degraded page layouts remain unmeasured.
- **S1.5 (tables and order):** deterministic DOCX now preserves interleaved paragraph/table order, respects only explicitly marked native headers, and keeps all data rows in headerless tables. Merged Word cells warn `DOCX_TABLE_1_MERGED_CELL_UNCERTAIN` and downgrade from `EXACT_TEXT`, rather than misrepresenting the reconstructed grid as exact; ragged Markdown rows retain all cells. The shared renderer preserves neutral headerless columns and keeps locator comments out of claim text. Representative tests are not a general-purpose document-quality guarantee.
- **S1.6 (passages):** revision-scoped source units preserve exact UTF-16 character spans and SHA, including content past the operator preview. `source:read`, wrong-source and stale-revision denials have PostgreSQL/API coverage.
- **S1.7 (revisions):** a new source is `STAGED` until its original SHA, structured artifact, complete Markdown, indexed passages and machine evidence persist in one lease-fenced transaction. A valid changed-byte revision at the same scoped URI makes the prior source `SUPERSEDED`; the source reads fence the latest artifact generation, and directly source-cited approved knowledge becomes `STALE_BLOCKED` (not eligible for retrieval) without rewriting Git; derived context packets are invalidated both for the changed vault and for federated scopes containing that vault. A URI-scoped advisory lock and submitted-job order protect against stale completion. A real API/worker/PostgreSQL/MinIO E2E checks changed hash, old read/unit denials, current indexed evidence and stale-review approval 409. Wider concurrent scheduling and all damaged-provider scenarios remain unmeasured.
- **S1.8 (migration/removal):** migrations 091/092 and guarded one-artifact backfill are tested, including corrupt/refused/idempotent cases. After full in-repository caller inventory, six unconsumed flattened parser modules, their initializer and lone obsolete test were removed; the actual adapter has replacement tests. API compatibility `Artifact` remains intentionally. The tracked hygiene classification was deterministically regenerated from 933 to 925 actual Git files without weakening its strict validator. Same-SHA release CI is required.
- **S1.9 (fixture diversity):** controlled fixtures include plain/ragged MD, DOCX with interleaved/headerless/merged tables, a real two-page digital PDF plus blank third page and corrupt PDF, a real raster OCR scan, wholly empty MD/DOCX/PDF, embedded code, long text beyond preview, a wrong supplied title, and intentional Docling `PARTIAL_SUCCESS` / local-model `NO_MATERIAL`. The deterministic extractor now emits semantic version `0.3.1` without changing provider defaults. General degraded-media accuracy is not inferred from representative fixtures.
- **S1.10 (ON/OFF):** persisted-stage and real ingest parity tests verify Markdown bytes/hash and locators with a mocked loopback model; no claim that the mock proves generation quality.

**S1 exit gate — accepted on code baseline `12749df7`, documentation SHA pending:** all S1.1–S1.10 items below have executable, bounded proof. Same-SHA CI run [38205611881](https://github.com/David-std/Architecture-Knowledge-Platform/actions/runs/38205611881) passed all five jobs; [release assurance 38205611875](https://github.com/David-std/Architecture-Knowledge-Platform/actions/runs/38205611875) passed and all 14 required workflow conclusions are successful. Python: 64 passed (4 deselected); API integration: 150 passed (2 skipped), with the actual changed-source, compiler OFF/ON and reviewed-publication regressions individually passing. OCR E2E emitted `{"status":"PASSED","extractor":"docling"}` and closed API/DB naturally. Controlled-format page, table and passage tests establish no _silent_ loss for tested fixtures: empty/partial/unsupported extraction fails or warns explicitly. Unmeasured arbitrary document layouts, OCR character error rate, model-generated answer quality, out-of-order stress and provider comparisons are **not** recast as proven. No model/embedding/provider default was promoted; approved Git still requires human review. Confirm full same-SHA workflows again after this documentation update, then sign off the stage in PR metadata. S2 implementation has not started.

### S2 — Evidence precision and compact context, not new heuristics

- [ ] Use exact answer-bearing source spans on new independent positive/negative multilingual holdouts (not F3 tuning).
- [ ] Compare **one** maintained reader/verifier to a published specialized alternative, while holding candidates/model budget constant. Keep failing question class taxonomy, not corpus-specific rules.
- [ ] Measure full-vault/manual-search vs compact packet vs selected excerpts with **real model tokens** and answer accuracy held constant; remove approximation claims or label them.
- [ ] Remove rejected shadow/translation alternatives and aliases after proof of zero consumers; do not keep renamed legacy implementations.
- **Done when:** evidence gate passes prespecified precision, FAR and latency plus measured token saving with no loss of answer coverage.

### S2 baseline infrastructure audit (2026-10-13)

**Status: IN PROGRESS; no S2 gate success claimed.** The prior S1 acceptance is unchanged and PR #38 remains draft/unmerged.

- **S2.1 (shared operation):** HTTP, MCP and the context facade already converge on the same `/v1/search` and `/v1/context` endpoints and `queryKnowledge` path, rather than a separate MCP ranking engine. Pure ranking and evidence assembly still reside in the large `apps/api/src/routes/search.ts` module; moving pure use-case ownership to `packages/retrieval` remains pending a baseline-preserving refactor.
- **S2.2 (new holdout foundation):** `evals/registered/s2-source-span-holdout.json` freezes 4 domain-disjoint synthetic sources with 24 original units and 48 balanced English/Spanish answerable/no-answer questions (24/24). A committed Git blob and explicit oracle substring/strata/threshold validation run as a real CI check. This is **author-constructed and not independently adjudicated**. Do not tune to these publicly visible labels; further independent review and realistic sample-size planning remain necessary.
- **S2.4 (measurement code, not performance):** `packages/evaluation/src/s2-source-span.ts` accepts independently recorded candidates, exact UTF-16 source offsets and decisions; it separately reports answer-bearing unit Recall@1/5/10, strict gold-span coverage, no-answer false admission, p95, reader degradation and optional actual pinned-tokenizer counts. Empty or partial executions cannot be passed as a release result. `scripts/s2-score-observations.ts` refuses empty, unpinned or forged-source run metadata.
- **S2.3, S2.5–S2.11 (still open):** a paired real manual/Obsidian baseline, independent human gold review, bounded candidate/reader comparison, production quote-sufficiency or fail-closed regression changes, actual model-token comparison, continuation/access filter stress, and removal of measured-rejected alternatives require evidence. No retrieval policy, model or provider default has been changed to obtain an artificial metric.

**S2 remains blocked at the measurement gate** until candidate and answer correctness evidence, properly stratified uncertainty, exact token budgets and paired task-completion results are collected. A passing CI validates infrastructure and contracts, not the S2 user-outcome thresholds.

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

### Architecture extensions parked before S2 promotion (2026-10-25, NOT implemented)

**Recorded decision:** [ADR 0005](../adr/0005-multilingual-retrieval-untrusted-sources-classification.md) was researched against existing AKP implementations and outside documentation. It does not replace S0–S5 or authorize default provider changes. Current code already contains `OpenAICompatibleQueryTranslator` + `QueryTransformerPort`, E5 multilingual vectors, active KnowledgeProfile revisions and original-backed ContextPackets. These are reuse points, not proof of complete user journeys.

- [ ] **S2 bilingual answerability:** preregister a new EN/ES mixed-source evaluation including EN→ES, ES→EN, same-language, code/IDs, negation, missing attribute, citations, real `LAYERED` reader and complete-answer quality. Compare existing original query, translated query variants and existing multilingual E5 **without hard language filtering**, using same ACL and original revision. Measure positive retention, negative false support and task completion, not only top-k rank.
- [ ] **CRITICAL cross-surface source-to-tool security:** inventory real tool executors and ContextPacket consumers; run harmless synthetic malicious-source and false-financial-fact adversarial tests with sandboxed tools, checking authorization, tool-argument taint, side effects, revocation and benign false refusals. The existing untrusted-text structural test **does not** close this item.
- [ ] **FOLLOW_UP classification proposal contract:** propose categories from the **active, revisioned KnowledgeProfile** using existing extractor/worker/compiler; separate detected document type, semantic kind, language, source authority, ACL/sensitivity and injection-risk signals. Add `UNKNOWN`/other, multi-label uncertainty and reversible non-destructive virtual organization. No classifier score may publish knowledge, grant ACL, set reviewer status or enable a payment.
- [ ] **FOLLOW_UP provider comparison, not default:** benchmark simple profile/deterministic, multilingual embedding shortlist + constrained model, and optional Llama 4 Scout if deployment/license fit. The anecdotal ~77% is unverified for AKP, and vendor benchmarks do not substitute for per-class confusion matrix, abstention/coverage, FP/negative risk and EN/ES accuracy.
- [ ] **Cutover/policy:** only after source-disjoint acceptance, build one versioned contract/migration under the current B5 rules; avoid a second durable taxonomy/retriever. Keep gates unchanged pending evidence.

**Governance:** `S2 OPEN · E5 SHADOW · S3–S5 BLOCKED`; new design/security tasks recorded, not checked complete by adding this documentation.
