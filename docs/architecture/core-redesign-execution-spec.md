# AKP — Core redesign implementation specification and agent continuation contract

- **Version:** 1.0 (2026-10-08), design-controlled working specification.
- **Execution state:** S0 architecture baseline/validation is the first change; S1–S5 are planned and intentionally unimplemented unless their own checks are marked complete.
- **Owner:** Architecture-Knowledge-Platform, repository `David-std/Architecture-Knowledge-Platform`.
- **Branch/PR:** `chore/retrieval-generality-policy`, draft PR #38 targeting `develop`; **do not merge or enable LAYERED by default** as part of this spec.
- **Start here:** [ADR 0004](../adr/0004-core-product-scope-and-simplification.md), [roadmap](core-redesign-roadmap.md), [repository standards](repository-standards.md), [S0 audit](s0-architecture-inventory.md).

> This is an implementation contract for successive engineering agents. It is intentionally specific about states, call sites, test evidence, removals, migration and honest evaluation. Completing a checklist requires verified behavior, not a comment saying done.

## A. Problem, users and product boundary

### A1. Problem

Software teams document decisions in Markdown/Obsidian, code in repositories, coordinate work in issue trackers/PRs and interact with assistants whose chat memory is incomplete and not a shared system of record. Copying a full vault into each agent request duplicates context and consumes tokens, yet retrieving one broadly related paragraph is not enough to make an engineering decision safely.

AKP should centralize **authorized, versioned, accessible context and resumable coordination**, not replace those external tools. Its value proposition must be demonstrated in an end-to-end software-delivery workflow relative to a plain-vault-plus-ticket baseline. A feature is not justified merely by being graph-shaped, model-backed, provider-compatible or benchmarked against itself.

### A2. Personas and responsibilities

| Persona            | Needs                                                                                      | Product-owned state                                                 |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Developer          | Correct current standards, prior decisions, impact/ownership, review context               | View/write permitted workspace findings; propose reviewed knowledge |
| Team lead/reviewer | Authoritative provenance, stale/contradictory decisions, approval and cross-agent progress | Review/publication decisions with explicit authority                |
| Coding agent A     | Minimum relevant authorized context and exclusive bounded work scope                       | Scoped identity, pinned session, work claim, finding                |
| Coding agent B     | Resume A's task without A's transcript and without inheriting A's privileges               | Separate principal, validated handoff and new claim fence           |
| Operator           | Inspect failures, provider utilization, revision parity, policy and resource cost          | Diagnostics, deployment config and recovery procedures              |

### A3. Acceptance journeys (the product must pass all relevant ones)

**J1 Ingest and read.** Add MD/DOCX/PDF/image; preserve immutable source hash, page/table/row locators and faithful readable representation; run OCR when required; retrieve the exact answer-bearing source location. A generated summary is a separate derivative.

**J2 Shared knowledge.** A reviewer approves a proposed rule/decision into managed Git; index and ContextPacket reflect the new revision; an old strict session detects drift; a withdrawn/superseded decision does not reappear as active.

**J3 Coordinated task.** Given ticket/goal and permitted repository, Agent A bootstraps, obtains a work claim, searches/code-impacts, records tests/findings and hands off. Agent B obtains its own credential/claim, resumes with the handoff and current authorized context. The old fence fails.

**J4 External work.** Jira/Linear/GitHub records remain authoritative remotely. AKP holds references, bounded metadata, permission and freshness status. A revoked principal cannot access references via another channel; a provider outage is labelled, not silently turned into current truth.

**J5 Efficiency.** For the same engineering question and model, compare a plain vault/manual search and full ContextPacket against query-scoped compact packets: track actual model input tokens, latency, citations and answer quality; avoid claiming savings when precision falls.

**J6 Operability.** A small Team Node can ingest, serve Web/API/MCP, recover after worker interruption and rebuild derived projections; model/vector providers may be disabled without losing authoritative knowledge.

### A4. Explicit non-goals

- Replacing GitHub, Jira, Linear, CI/CD, observability, or making AKP another full ticket tracker.
- Guaranteed global RAG accuracy, invisible agent autonomy or using model agreement as knowledge approval.
- Microservice decomposition by graph domain or every LLM provider.
- A model-generated universal Markdown summary as the only source document.
- Making every graph, community, PPR, DRIFT, NLI, QA or OCR provider a default.
- Two permanent code paths (`legacy` and `new`) for identical behavior.

## B. Architecture and state contracts

### B1. Authority classes (never collapse)

1. **Immutable SOURCE**: raw content addressed by hash and one or more source-located `DocumentArtifact`/faithful Markdown projections.
2. **Approved KNOWLEDGE**: reviewed Markdown under managed Git with authority, lifecycle and revision.
3. **WORK**: mutable PostgreSQL coordination (sessions, fences, handoffs, blockers, findings).
4. **EXTERNAL**: provider-owned object identity, revision, ACL fidelity, freshness and deletion semantics.
5. **DERIVED**: pgvector/FTS, community/typed graph indexes, LLM claims, scores and ContextPackets that can be recreated.

Read scope is checked before graph/semantic expansion; knowledge authority is checked before admission. A file reference, embedding score, source title or quote does not imply answer sufficiency.

### B2. Team Node topology

Keep an API + worker + extractor + web with PostgreSQL/pgvector, raw store and managed Git as a modular monolith. MCP and CLI should be thin entry points to the same owned use cases; distinguish administrative CLI-only tasks while migrating, then make the true boundaries enforceable. One Team Node controls shared mutable coordination and derived indexes; clients do not synchronize live PostgreSQL directories through filesystems.

### B3. Trust, identity and concurrency rules

- Every request has an explicit space/vault/path scope, principal identity and effective authorization revision.
- Strict work uses a pinned `ContextRevisionSet`; stale pin must error, not blend source versions.
- Independent child-agent principals never inherit approval/publish actions merely because a parent issued credentials.
- Work claims use database leases/fencing; new ownership cannot reuse old tokens.
- A connector statement is untrusted external data until independently reviewed where needed.
- Generated prose cannot write raw-source locations, alter privileges or claim source-of-record authority.
- User-provided prompt text inside a document remains untrusted source content.

### B4. Distinct pipeline contracts

`SOURCE_BYTES → EXTRACTED_DOCUMENT_ARTIFACT → FAITHFUL_SOURCE_MARKDOWN → INDEXED_SOURCE_UNITS → RETRIEVED_SOURCE_SPANS → COMPACT_CONTEXT_PACKET`.

Independently:
`SOURCE_ARTIFACT + PRIOR_APPROVED_KNOWLEDGE → LLM_PROPOSED_KNOWLEDGE → VALIDATE → REVIEW → PUBLISH_GIT → REINDEX`.

Neither LLM proposals nor graph summaries should replace the source projection. Work findings are neither source nor approved knowledge. Every emitted claim needs a source/evidence reference or must be explicitly marked unsupported.

### B5. Contract changes and data migration

For every behavior requiring schema/API change, agents must record:

- Current persisted state, owner, active readers, writers, indexes, caller routes and possible external clients.
- One target contract and the exact data transformation/backfill, including hash/revision source mapping.
- Release/cutover boundary, explicit errors for unsupported old format and post-cutover cleanup.
- Tests proving retry safety, authorization, source fidelity and rollback/rebuild before deletion.
- **Do not add indefinite aliases**; for applied DB schema changes, use append-only migrations and a bounded one-time upgrade.

## C. Engineering quality rules

### C1. Dependencies and boundaries

- `packages/contracts` and `packages/domain` contain no infrastructure dependencies.
- `packages/application` owns domain use-case logic; retrieval handles pure evidence logic; IO lives in persistence/adapters.
- No package imports an application; no source module escapes its app/package with relative imports.
- Only declared `package.json exports` may be used for deep `@akp/*` import paths.
- External libraries require a named user journey, version/lock, maintenance rationale, code and model-weight licenses, deployment cost/residency and measured feature evidence.
- `pnpm boundaries` must run dependency-cruiser, module graph gate and import-surface gate. Never bypass it by ignoring existing violations indefinitely.

### C2. Naming/layout

- `kebab-case` files; TypeScript `PascalCase` types/classes, `camelCase` functions/values, `UPPER_SNAKE_CASE` constants; Python snake_case functions and PascalCase classes.
- Name operations by business event/intention (`acquireWorkClaim`, `publishReviewedKnowledge`, `mapSourceLocator`), not `handleV2`, `smartManager` or `newPipeline`.
- Avoid giant route handlers: HTTP adapters validate/authenticate, then call a cohesive application operation. Do not move 5,000 lines verbatim into a `service.ts`.
- Prefer one clear package entry point, narrowly exported contracts and locally testable pure functions. Avoid package-internal absolute paths and model-specific assumptions in shared code.
- Add one focused test for every new invariant and one negative/adversarial test for trust/ACL/revision/answer sufficiency.
- Tool/CI output is evidence only for the tests actually executed; no claim of live production confidence from mocked integrations.

### C3. Removal requirements

Do not create `LegacyThingAdapter` or two implementations that both persist state. Before deleting code:

1. Find all direct, dynamic, CLI/MCP and external consumers; identify persistence/exported contracts.
2. Preserve meaningful behavior tests and select one replacement.
3. Migrate callers and persisted state; ensure reproducible backups where appropriate.
4. Delete superseded implementation, flags, types, tests, docs and exports **in the same cutover**.
5. Run negative cases, the module gate and all affected typechecks.
6. Document rollback as restoring/rebuilding from authoritative data, not indefinite dual-write.

## D. Stage S0 — Product boundary, architecture constraints and exact inventory

**Owner objective:** make architecture standards executable and classify technical debt before broad behavior changes.

**Inputs:** `README.md`, `ARCHITECTURE.md`, `docs/context-fabric.md`, workspace/agent/connector guides, all module manifests/source imports, PR #38 and CI.

**S0 tasks:**

- [x] S0.1 Reconstruct J1–J6 and the plain Markdown/Obsidian baseline. ADR 0004 is the product-scope decision.
- [x] S0.2 Document authority classes, module owners, naming and refactor/cutover practices.
- [x] S0.3 Gate manifest-level cycles, invalid internal edges and pure-module layering with regression tests.
- [x] S0.4 Audit TS source imports and gate undeclared package subpaths or relative production-source module escapes.
- [x] S0.5 Inventory large modules and candidate exports, classify false positives, and document the known worker-test cross-module integration as S1 test-placement debt (no artificial production dependency).
- [x] S0.6 Confirm **CI success on the exact S0 implementation SHA** `6b54e2b38d6e117c4a7751d3fdde193ce52d5309`, including architecture controls. Later documentation/coding commits require their own same-SHA CI before being declared verified.
- [x] S0.7 Draft PR #38 description embeds S0–S5 checkbox statuses and links this specification, with original PR text preserved.

**Artifacts:** `docs/adr/0004-core-product-scope-and-simplification.md`, `docs/architecture/{repository-standards,core-redesign-roadmap,s0-architecture-inventory,core-redesign-execution-spec}.md`, `scripts/{validate-module-boundaries,validate-import-surfaces,report-architecture-inventory}`, test files, `pnpm boundaries`.

**Quality evidence:** `pnpm boundaries`, `pnpm docs:validate`, `pnpm hygiene:validate`, `pnpm retrieval:generality:validate`, affected unit tests/typechecks, PR CI exact SHA. S0 does not claim source fidelity or RAG accuracy improvement.

**Verified S0.6 CI record (2026-10-08):** `6b54e2b38d6e117c4a7751d3fdde193ce52d5309`, GitHub Actions `ci` run `37869858647` (`success`; including `pnpm check`, formatting, docs/hygiene, build, integration), with the other triggered required workflows also successful. Optional workflows that were skipped are not counted as passed tests. This closes S0.6 for that implementation SHA only; a future documentation or implementation commit requires its own CI and does not establish S1 behavior.

**Exit:** S0 tasks complete and initial technical debt is explicitly assigned to S1–S5; no default behavior changed. Next agent begins at S1 with the documented source path.

## E. Stage S1 — Single faithful source-to-context path

**User-facing promise:** upload a document and subsequently retrieve specific current passages (including OCR when needed), with their original locations and without trusting a generated paraphrase.

**Baseline code:** `apps/extractor/app/registry.py`, `apps/extractor/app/adapters/deterministic.py`, `ocr_local.py`, `docling_native.py`, `apps/worker/src/document-artifact.ts`, `compilation-stage.ts`, `knowledge-compilation.ts`, `packages/vault-importer/src/index.ts`, `packages/indexing/src/*`, `packages/retrieval/src/chunking.ts`. Prior [ingestion audit](ingestion-chunking-audit.md) documents fixed preview and partial Docling failures but **does not prove full deployed end-to-end fidelity**.

### S1 backlog (ordered)

- [ ] S1.1 Trace **source record IDs/hash/object key/document artifact ID** from user request through worker, MinIO and review; identify exact persistence and authority of the extracted Markdown with LLM disabled and enabled. Inspect real DB query paths, not only mapper unit tests.
- [ ] S1.2 Determine whether both `GENERATIVE` and `SOURCE_SUMMARY_FALLBACK` persist a faithful source projection. If not, make faithful source generation a **single common source stage** before any optional generative knowledge plan. The generative path should _augment_, never replace, this source path.
- [ ] S1.3 Define one SourceProjection contract: canonical source artifact ID, SHA256, extractor and version/config hash, Markdown hash, structured blocks, section IDs, page/table/row/character locators, extraction status/warnings, revision and trust tier. Avoid second competing truth store.
- [ ] S1.4 Ensure incomplete pages and failed OCR/parse are explicit errors or partial records according to contract, never successful empty Markdown. OCR-required routes must reject unconfigured OCR.
- [ ] S1.5 Keep tables faithful: headerless tables preserve every row, ragged rows preserve cells, equations/figures expose uncertainty, comments/locator metadata never become retrievable claims.
- [ ] S1.6 Ensure indexed source units retain path/title/heading and enough original spans for quote replay. A long document must not silently index only a UI preview.
- [ ] S1.7 Rebuild/reindex derived generations on source revision changes; no stale old-generation admission; preserve read-only imported vaults and review-aware managed-Git behavior.
- [ ] S1.8 Implement only the minimal necessary migration. Remove replaced legacy parser/rendering branches and test paths after cutover; document exact failure mode and recovery.
- [ ] S1.9 Test plain MD, DOCX with table, digital multi-page PDF, rasterized scan requiring OCR, empty/corrupt source, embedded code snippet, title mismatch, long-text > UI preview and deliberate provider partial failure.
- [ ] S1.10 Run integration path with compiler disabled and configured local/mock compiler **against the same source**, and compare faithful Markdown hashes/locators. Mocked compiler verifies wiring, not generative content quality.

### S1 success criteria

- Original raw bytes and source SHA remain verifiable. Every produced quote can map to one source block/row and current revision.
- No page, table row or critical fact disappears without explicit extraction warning/failure.
- Source fidelity identical across compiler ON/OFF; all model-generated knowledge explicitly source-linked, marked derived and subject to review.
- No duplicate source writers or compatibility renderer remains at end of migration.
- Regression + relevant extractor tests pass; no model/embedding default promotion.

### S1 delivery notes for agent

Record exact code paths, proposed contract shape, DB migration/backfill if used, affected callers, table/OCR fixtures, private documents excluded from Git and invocation of all tests. If extraction quality requires a provider choice, benchmark it by document class before changing defaults. **Do not begin S2 until source provenance is dependable.**

## F. Stage S2 — Retrieval precision and context efficiency

**User-facing promise:** agents can answer engineering questions based on current approved knowledge and exact source passages while consuming less repeated context than a whole vault, without inventing answers from merely related snippets.

### Metrics are distinct

- `Recall@k` of _answer-bearing source units_ during candidate generation, not merely gold documents.
- `Admitted evidence precision`: percentage of admitted cited spans that directly answer requested slots, including correct subject, relation, value, version, polarity, unit and time.
- `False admission rate` on unanswerable and adversarial queries, compared to current baseline.
- `Final answer grounded correctness` and abstention, which require evaluation of the answer emitted by the same fixed agent/model.
- `Token efficiency`: actual tokenizer counts for matched tasks, mean/median/p95 and reference compression ratio, paired with precision, recall, citation survival and task completion.
- `Latency/cost`: stage-level p50/p95, actual reader invocations, model residency and total resource consumption.

The existing frozen F3 review provided **AI 51/72 ANSWERS**, 16 related, 5 wrong; Wilson lower 59.49% is a simple-sample approximation despite stratification. Negative 0/18 is not proof of zero false admissions in future queries. These results are not valid acceptance for a changed model or corpus.

### S2 backlog

- [ ] S2.1 Define a single typed retrieval operation invoked by HTTP/MCP; API authenticates and scopes, retrieval owns pure ranking/evidence assembly. Avoid two semantic decision engines.
- [ ] S2.2 Build a fresh source-span holdout with balanced English/Spanish, precise values/versions, ambiguous names and negative/adversarial cases; freeze before comparing. Preserve private benchmark text locally.
- [ ] S2.3 Establish Obsidian/manual search + AKP current baseline with exact versioned source corpus, allowed time/model/context budget.
- [ ] S2.4 Diagnose stage failures: index miss, fused rank displacement, wrong unit, missing parent/source rows, reader “RELATED” error, answer assembling from an unsupported quote, missing ACL/revision.
- [ ] S2.5 Test at most one promising established retrieval/reader alternative at a time, reusing the same authorized pool and budget. Do **not** add heuristic concept lists, alias exceptions, second vector DB or a new framework without comparative gain.
- [ ] S2.6 Enforce quote **sufficiency** for requested slot(s), not merely verbatim matching. Exact citation, answerability and authenticity are separate conditions.
- [ ] S2.7 Preserve fail-closed semantics on reader errors; report degradation and allow authorized exploratory results only where route semantics permit.
- [ ] S2.8 Compare full and compact `ContextPacket`, source extractive selection and optional grounded LLM summary using one **actual target-model tokenizer**. The default `char/4` estimator must be labelled approximate.
- [ ] S2.9 Ensure truncated primary evidence triggers a continuation/gap; never silently replace it with higher-ranked but unsupported summary.
- [ ] S2.10 Remove measured-rejected alternate verifier, translation or QA code, flags and dual behavior after checking consumers and tests. Maintain a reproducible record of removals and release notes.
- [ ] S2.11 Prove permission, freshness and temporal filters also constrain graph/aggregate/expanded and continuation candidates; no cross-vault inference via hidden nodes.

### S2 gate

Set acceptance thresholds **before holdout**; preserve PR owner `precision ≥0.80` and Wilson95 simple lower `≥0.70` as diagnostics while adding design-aware confidence intervals for stratified sampling. FAR `≤0.10` and no worse than deterministic baseline, p95 ≤25 seconds and degraded-call rate ≤5% remain provisional prior criteria; do not silently move them to pass. Require adequate positive/negative sample size and independent review or transparently labeled AI adjudication. More importantly, **answer correctness and task success** cannot regress merely to reduce tokens.

## G. Stage S3 — Shared agents, tickets, handoff and knowledge freshness

**User-facing promise:** a task survives a different agent's context window and can be resumed without copied conversation, while concurrent edits and stale instructions are rejected.

### Core path

`authorized WorkItem/goal → ContextRevisionSet bootstrap → relevant knowledge and source-of-record references → claim/fence → CODE/IMPACT/SEARCH → verified edits/tests → finding + evidence → structured handoff → new agent principal + claim → propose durable knowledge → review → managed-Git publish → next bootstrap`.

### S3 backlog

- [ ] S3.1 Choose a realistic two-agent code-change task involving a ticket, repository and at least one approved engineering rule. Distinct agents must have distinct principals and bounded actions.
- [ ] S3.2 Bootstrap both agents against revision-controlled authorized context, including work, knowledge and source-of-record refs. Verify stale/revoked credentials fail.
- [ ] S3.3 Confirm non-overlapping claims succeed; overlapping claims, expired fences and stale owner retry fail deterministically.
- [ ] S3.4 Capture structured handoff: goal, completed work, changed resources, remaining tasks, blockers, test outcomes, evidence references, open questions and revision pin.
- [ ] S3.5 Resume with another agent without prior transcript; check that no hidden message history or blanket context grant is required.
- [ ] S3.6 Run a concurrent publication/revision change and ensure strict agent operations detect drift and rebootstrap rather than mix revisions.
- [ ] S3.7 Validate governance: agent-origin finding cannot self-publish as a rule, must preserve source and review; approval refreshes index and packet for next participant.
- [ ] S3.8 Investigate duplicate orchestration between API, Web and MCP. Move business actions into existing application boundary and remove obsolete route logic in cutover; preserve API contracts.
- [ ] S3.9 Exercise worker restart, replay/idempotency, offline drafts and recovery of queued handoff/coordination messages.
- [ ] S3.10 Pair with manual workflow (ticket + Markdown vault + copied prompt) to measure resume completeness, context re-entry time, token cost, unauthorized exposure and documentation freshness.

### S3 gate

All steps succeed with independent principals; wrong principal cannot release/heartbeat claim, stale context cannot mutate strict workflow, second agent has complete bounded task state, and approved docs become retrievable at a pinned current revision. Same-version API/MCP/Web behavior verified without duplicate business authority.

## H. Stage S4 — Remove unsupported optional capabilities and harden licensing

**User-facing promise:** a small supported installation with predictable dependencies; all extra providers exist only when useful for a supported journey and fully licensed for the deployment.

### S4 backlog

- [ ] S4.1 Inventory **actual runtime activation** from safe counters/config audits, not only `requirements/pyproject`, source adapter classes or CI mocks. Observe provider selection frequency, failure/fallback, per-document type and cost without retaining private content.
- [ ] S4.2 Record which current team/deployment explicitly uses Marker, Chunkr OSS/cloud, Docling, OCR, Graphify, NLI/QA, translation, graph community/global, federation and remote model routes.
- [ ] S4.3 For parser overlap evaluate deterministic/Tesseract/Docling/Marker/Chunkr on the _same_ controlled documents: page integrity, CER/WER for scans, table cells, equation loss, source locators, cost, p95 latency, network residency and failure transparency.
- [ ] S4.4 Audit **separate licenses for code, weights, models, downloaded datasets and SaaS plans**; record version, license ID/URL, commercial/network/copyleft obligations and source residency. Do not equate optional adapter availability with permission to redistribute weights.
- [ ] S4.5 Keep at most one preferred provider per validated class, plus a necessary deterministic/fail-closed alternative. OCR may require Tesseract when structural extraction is unavailable; do not silently turn off OCR to avoid licensing.
- [ ] S4.6 Retire unused Marker/Chunkr or other providers only after tracing CLI/API schema, registry routing, Docker profiles, tests, docs, configs and deployed consumers. In one cutover delete the adapter/runtime module, dependency extra, registry option, public flags, docs and invalid tests. Include upgrade notes if contracts changed.
- [ ] S4.7 Require explicit real-sandbox evidence for live Jira/Linear promises. Simulated CI validates semantics only; keep read-only contract and provider-owned ticket lifecycle until authorized write-back has a concrete user journey.
- [ ] S4.8 Evaluate `Community/PPR/GLOBAL/DRIFT` and federation on real relevant questions. If no measured incremental benefit over hybrid base, retire product surfacing instead of preserving permanently mounted “optional” complexity.
- [ ] S4.9 Graphify remains an isolated CODE feature if used for impact; do not route ordinary document questions through code graphs and do not mislabel Graphify “knowledge graph retrieval”.

### S4 gate

No abandoned runtime adapter or dangling optional config appears in the shipped artifact; optional environments report exactly configured capabilities; no undisclosed cloud transfer; licenses reviewed and attributable to exact installed versions; defaults become smaller, and real user journeys remain covered.

## I. Stage S5 — Consolidation, architecture enforcement and release

**User-facing promise:** clear ownership, small public surface, one implementation per behavior and a maintainable product release.

### S5 backlog

- [ ] S5.1 Re-run `scripts/report-architecture-inventory.mjs`, compare S0 large-file/modules/export candidates and identify which deep coupling was actually removed. Do not judge success only by fewer lines.
- [ ] S5.2 Decompose `apps/api/src/routes/search.ts` by explicit responsibilities and tested operations, not mechanical file-size fragmentation. Auth/revision guard remains in application/API, pure ranking in retrieval, SQL in postgres; remove old route logic after migrating tests.
- [ ] S5.3 Review large temporal, graph, assurance, vault importer, review, session and indexing files with the same owner map. Prioritize documented duplicate behavior or violated domain boundaries over line count.
- [ ] S5.4 Inspect source-level exported symbols with TypeScript references, public re-exports, reflection and downstream contract consumers before deletion. The S0 identifier-only report is **candidate-only**; no bulk prune.
- [ ] S5.5 Consolidate operational CLI database dependencies via a deliberate administrative application boundary. If an operation intentionally requires local DB, document that as a separate operator entry point rather than pretending it is an HTTP-only client. Remove superseded implementation after tests.
- [ ] S5.6 Review public API/MCP action naming, request/response schemas and user-facing docs together; remove abandoned legacy flags and duplicated response shapes by a versioned release, not by indefinite alias retention.
- [ ] S5.7 Verify dependency lockfile alignment, license/SBOM, secret scan, contracts, docs, code format, package boundaries, typechecks, lint, unit/integration/browser/MCP tests, migration upgrades, rebuild after restore and real Team Node.
- [ ] S5.8 Audit data migration and rollback by restoring/rebuilding from authoritative Git/raw bytes/work tables. A rollback must not require leaving dual writers alive indefinitely.
- [ ] S5.9 Update README/architecture diagrams/feature status to distinguish: supported default, configured optional, mocked only, measured and unmeasured.
- [ ] S5.10 Obtain explicit owner review for merging the redesigned product or changing default RAG/OCR/model provider. Draft PR #38 cannot substitute a passing architectural gate for retrieval acceptance.

### S5 gate

Source-level architecture reflects the documented module graph, no known critical duplicate authority remains, all active integrations have run-mode/contract/license evidence, backups and upgrade paths are proven, and all supported user journeys run in one reproducible Team Node profile. Unverified features must be removed from the main promise or marked experimental.

## J. Agent execution protocol and handoff contract

### J1. Before editing

1. Read `AGENTS.md`, `README.md`, `ARCHITECTURE.md`, `docs/status.md`, this specification, roadmap, ADRs and security/operations docs.
2. Confirm current GitHub account is `David-std`, remote is `David-std/Architecture-Knowledge-Platform`, branch is expected and PR is draft. Never overwrite or merge another person's work.
3. Read the exact open stage and checkboxes; do not leap to speculative new features because a prototype seems interesting.
4. Draw the **current** data/control flow from source, not from diagrams alone. Show actual callers, DB rows, external endpoints, API/MCP contracts and disabled optional providers.
5. Freeze a minimal behavior test for the specific desired change. Identify tests that do **not** cover it.
6. Record source file owners, impact on private data, license requirements, target metrics and removal/migration obligations.

### J2. During editing

- Make one cohesive change (or documented migration pair) and verify negative cases before moving to the next.
- Keep raw/approved/work/external/derived authority classes separate.
- Do not copy private evaluation text into Git or log output. Do not tune generic RAG heuristics to answer a known holdout query.
- Do not add extra `*Manager` / `*Port` / `*Adapter` / `v2` wrappers just to avoid updating call sites. If old behavior is incompatible, design a bounded migration and delete replaced code.
- Do not introduce another framework, database, semantic model or remote provider unless the stage's benchmark actually needs it.
- Avoid modifying 100 files based on a speculative static warning. Check runtime consumers and local changes first.

### J3. Before reporting success

Always report four distinct statuses:

1. **Implemented** — paths and commit SHA that changed.
2. **Tested** — exact commands, count/result and what they do not test.
3. **Measured** — benchmark, sample size, model/corpus frozen revision, interval and limitations; if absent write `NOT_MEASURED`.
4. **Deployment/CI** — exact pushed SHA, actual workflow status, defaults/merge state and unresolved failures.

Never call simulated integration “live validated” or say `human reviewed` when an AI judged it. A successful unit suite is not product accuracy.

### J4. Per-change removal/migration handoff template

```text
Stage ID:
User journey improved:
Current behavior / owner:
Target behavior / single owner:
Files and downstream consumers:
Persisted state and source-of-truth:
Contracts affected (Web/API/MCP/CLI/DB):
Security/revision/authorization considerations:
Explicit one-time migration/reindex:
Old implementation, flags and tests deleted:
Rollback/rebuild from authoritative data:
Acceptance tests:
Independent baseline and measurement:
Git commit SHA / CI exact-SHA status:
Open risks / next step:
```

### J5. When stopping between stages

Update **both** `docs/architecture/core-redesign-roadmap.md` and the PR #38 checklist. Mark checks only when there is corresponding code/test/measurement proof. Leave the exact next file, command and dependency in the handoff. A locally clean branch or a documentation claim is not evidence that CI finished. Preserve S0 inventory numbers as a comparison baseline without treating them as hard file-count budgets.

## K. Commands and evidence discipline

```powershell
# Identity and worktree
git status --short --branch
git log -1 --oneline
gh api user --jq .login
gh api repos/David-std/Architecture-Knowledge-Platform/pulls/38 --jq '{head:.head.sha,draft:.draft,state:.state}'

# Mandatory architecture and docs
pnpm format:check
pnpm boundaries
node scripts/report-architecture-inventory.mjs > .work/s0-inventory-current.json
pnpm docs:validate
pnpm hygiene:validate
pnpm retrieval:generality:validate

# Project quality
pnpm typecheck
pnpm check
pnpm build
pnpm contracts:validate
pnpm security:secrets

# Stage-specific checks
pnpm --filter @akp/retrieval test
pnpm --filter @akp/api typecheck
pnpm --filter @akp/worker test
# For extraction: uv sync --locked; uv run --locked ruff check .;
# uv run --locked mypy app; uv run --locked pytest

# Clean review and push only after checks
git diff --check
git status --short
```

Long-running integration tests, DB migrations, real provider sandbox runs and A/B inference require isolated infrastructure and shall be triggered only when the stage needs them. Avoid repeated expensive model inference without a decision it will settle. Check GitHub CI and distinguish pending/in-progress from passing.

## L. Open decisions, handoff at S0 boundary

1. **S1 source projection lifecycle:** current fallback makes a full Markdown draft; generative route compiles proposals. Determine the source-faithful representation persistence in both modes before altering lifecycle. No blind data migration.
2. **S2 supported default:** keep `LAYERED` off as default until a new held-out evaluation demonstrates precision/recall/FAR/latency. Existing F3 AI grading explicitly failed numeric acceptance.
3. **S3 priority:** the supported Team Context behavior may already be broad, but value relative to manual vault/issue tracking is not independently demonstrated. Build J3 first, not more event types.
4. **S4 optional adapters:** Graphify CODE is a separate capability; Marker/Chunkr removal remains contingent on usage, fidelity and license. Jira/Linear simulated-only until live sandbox verification.
5. **S5 legacy removal:** remove obsolete aliases/duplicate code only with complete call-site inventory and one migration; no new permanent compatibility shims.
6. **CI/branch:** PR #38 stays draft until the owner explicitly authorizes merge. If external CI remains pending, mark it pending, not passed.

## M. References and status policy

Authoritative implementation clues: `docs/architecture/runtime-flows.md`; `docs/guides/{workspace-operating-model,team-context,coordination-plane,agent-integration,connector-contract,retrieval-context-engineering,code-context}.md`; `docs/architecture/{ingestion-chunking-audit,retrieval-flow-audit,modules,repository-standards}.md`; `docs/security/threat-model.md`; `docs/runbooks/local-operations.md`.

The spec is intentionally **not** a declaration that all planned capabilities are production-ready. Every stage still needs code-level inspection, targeted tests and separate evidence. Scope reduction is an outcome only when redundant implementations and configuration disappear from the deployed product.
