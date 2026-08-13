# Competitive capability audit

## Scope and evidence policy

This report executes the competitive audit required by section 19A of Unified
Goal V2. It compares the current Architecture Knowledge Platform (AKP) with the
nine mandatory reference repositories capability by capability.

- Audit date: **2026-08-10** (`America/Bogota`); AKP execution evidence was
  refreshed on **2026-08-12**.
- AKP revision inspected: `530a0192e2ca4c39b890118c77d1ffe897e5089a`.
- Functional AKP baseline: commit
  `7daa261c446100b50bc985d60f199299291dfe2e`, tag
  `v0.1.17-knowledge-baseline`.
- AKP execution evidence comes from [`VALIDATION_REPORT.md`](VALIDATION_REPORT.md),
  [`PROJECT_STATE.md`](PROJECT_STATE.md), checked-in tests and implementation.
- Reference evidence comes from shallow, no-checkout clones under the ignored
  `.cache/references/` directory, pinned to the exact HEAD commits below.
- Reference source trees, selected implementation files and tests were
  inspected. Their dependency installations, full applications and full test
  suites were **not executed** by this audit.
- A test file in a reference repository is evidence that a scenario is encoded,
  not evidence that the test passed in this environment.
- No cross-project benchmark used a shared corpus, hardware profile, model or
  threat harness. Categories that require such parity remain
  `UNKNOWN_NOT_REPRODUCED`.

The only assessment values used are:

- `WORSE_THAN_REFERENCE`
- `ROUGHLY_COMPARABLE`
- `BETTER_WITH_EVIDENCE`
- `UNKNOWN_NOT_REPRODUCED`

`BETTER_WITH_EVIDENCE` is deliberately narrow. It describes one mechanism for
which AKP has executed evidence and the inspected reference lacks an equivalent
mechanism at its pinned revision. It is never an overall product ranking.

## AKP executed baseline used by this audit

| Evidence            | Executed result                                                                                                               | Local evidence                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean quality gates | Node 20 frozen install, high-severity audit, format, typecheck, dependency boundaries, unit tests and production build passed | [`VALIDATION_REPORT.md`](VALIDATION_REPORT.md)                                                                                                                                                                       |
| API integration     | 28 tests passed across security/governance and review-publication suites                                                      | [`apps/api/test/security.integration.test.ts`](apps/api/test/security.integration.test.ts), [`apps/api/test/review-publication.integration.test.ts`](apps/api/test/review-publication.integration.test.ts)           |
| Python extraction   | Ruff passed and 12 pytest cases passed locally under Python 3.14.0                                                            | [`apps/extractor`](apps/extractor)                                                                                                                                                                                   |
| Corpus projections  | 555 documents, 6,138 hierarchical units, 4,078 embeddings and 1,192 relations                                                 | [`PROJECT_STATE.md`](PROJECT_STATE.md)                                                                                                                                                                               |
| MCP                 | Generic client enumerated and exercised 20/20 tools with an explicit VaultRegistry scope                                      | [`scripts/mcp-smoke.ts`](scripts/mcp-smoke.ts), [`apps/mcp/src/server.ts`](apps/mcp/src/server.ts)                                                                                                                   |
| Retrieval           | Logic-only offline harness executed 19 generic cases/slices over the exact ten-run matrix; no production default was selected | [`RETRIEVAL_BENCHMARK.md`](RETRIEVAL_BENCHMARK.md), [`reports/retrieval/offline-benchmark.json`](reports/retrieval/offline-benchmark.json)                                                                           |
| Recovery            | Backup v3 restored PostgreSQL, MinIO, Git bundle and the exact 16-migration inventory                                         | [`scripts/backup.ps1`](scripts/backup.ps1), [`scripts/restore-smoke.ps1`](scripts/restore-smoke.ps1)                                                                                                                 |
| Publication         | Isolated Git worktrees, optimistic checks, approve/reject/rollback and cleanup were exercised                                 | [`packages/git-store/test/isolated-drafts.test.ts`](packages/git-store/test/isolated-drafts.test.ts), [`apps/api/test/review-publication.integration.test.ts`](apps/api/test/review-publication.integration.test.ts) |

These results establish a controlled local baseline. They do not establish
internet-facing, multinode or long-duration behavior. The current retrieval
report is logic-only synthetic evidence, not broad quality proof.

## Pinned primary-source inventory

Counts below come from `git ls-tree` over each pinned HEAD. The test count is a
path heuristic (`test`, `tests`, `__tests__`, `.test.*` or `.spec.*`), not a
claim that those tests pass.

| Reference                       | Default branch and HEAD                                                                                                                               | Latest visible tag and target                                               | License inspected at HEAD                                                                                                                                                 |                          Tree evidence |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------: |
| `nashsu/llm_wiki`               | `main` — [`fa2652eb8186635c2b251007d0a46b0614528a7d`](https://github.com/nashsu/llm_wiki/tree/fa2652eb8186635c2b251007d0a46b0614528a7d)               | `v0.6.8`; annotated tag peels to `b4b544abe0dd4c75cd630ef464c41678a5f31cb8` | [GPL-3.0 text](https://github.com/nashsu/llm_wiki/blob/fa2652eb8186635c2b251007d0a46b0614528a7d/LICENSE); GitHub API returned `NOASSERTION`, so the file is authoritative | 450 files; 137 test paths; 2 workflows |
| `green-dalii/obsidian-llm-wiki` | `main` — [`1f9a18559729f366df10ba593dfd54fef1b59cc0`](https://github.com/green-dalii/obsidian-llm-wiki/tree/1f9a18559729f366df10ba593dfd54fef1b59cc0) | `1.26.2` → `940122bc4b708ae9a4a0e59fd1d994515c86ee84`                       | [Apache-2.0](https://github.com/green-dalii/obsidian-llm-wiki/blob/1f9a18559729f366df10ba593dfd54fef1b59cc0/LICENSE)                                                      |  581 files; 290 test paths; 1 workflow |
| `frankchu91/mindbase`           | `main` — [`62f301eb1099f1e8b1e6f0e5ad191dfb2c4e4489`](https://github.com/frankchu91/mindbase/tree/62f301eb1099f1e8b1e6f0e5ad191dfb2c4e4489)           | `v0.4.0` → `2c19592a1edcb98532dd995a179fb2e2eaf03a2b`                       | [MIT](https://github.com/frankchu91/mindbase/blob/62f301eb1099f1e8b1e6f0e5ad191dfb2c4e4489/LICENSE)                                                                       |  722 files; 140 test paths; 1 workflow |
| `gowtham0992/link`              | `main` — [`643e208adbbe2dfd1c91bf9e8305e6dec2b037a6`](https://github.com/gowtham0992/link/tree/643e208adbbe2dfd1c91bf9e8305e6dec2b037a6)              | `v2.2.1`; annotated tag peels to `ef623f0b1cfceccf9ea7b9fe87ea8a1546cc2fa2` | [MIT](https://github.com/gowtham0992/link/blob/643e208adbbe2dfd1c91bf9e8305e6dec2b037a6/LICENSE)                                                                          |   317 files; 77 test paths; 1 workflow |
| `XBlueSky/cortexes`             | `plugin` — [`0fd54c80f9361c3f9de6df08ea9f3fe30ee73c20`](https://github.com/XBlueSky/cortexes/tree/0fd54c80f9361c3f9de6df08ea9f3fe30ee73c20)           | `v1.3.2`; annotated tag peels to the inspected HEAD                         | [Apache-2.0](https://github.com/XBlueSky/cortexes/blob/0fd54c80f9361c3f9de6df08ea9f3fe30ee73c20/LICENSE)                                                                  |  229 files; 58 test paths; 3 workflows |
| `mohammadmaso/kherad`           | `main` — [`2a8d6992b87a33760688e1f956653c21a6292294`](https://github.com/mohammadmaso/kherad/tree/2a8d6992b87a33760688e1f956653c21a6292294)           | No tag returned                                                             | [Apache-2.0](https://github.com/mohammadmaso/kherad/blob/2a8d6992b87a33760688e1f956653c21a6292294/LICENSE)                                                                |  366 files; 13 test paths; 0 workflows |
| `masumi-network/Citadel`        | `main` — [`cc8fc026297b64f39f387b96e30da63f77ad57fb`](https://github.com/masumi-network/Citadel/tree/cc8fc026297b64f39f387b96e30da63f77ad57fb)        | `v0.4.0` → `2e844bf7249e664a2df61efb218868b0c52e8e4b`                       | [Apache-2.0](https://github.com/masumi-network/Citadel/blob/cc8fc026297b64f39f387b96e30da63f77ad57fb/LICENSE)                                                             | 428 files; 84 test paths; 11 workflows |
| `ZeroDot1/LLMWikiNG`            | `main` — [`e8508d586534799fc47cd82370a6e55cd75db319`](https://github.com/ZeroDot1/LLMWikiNG/tree/e8508d586534799fc47cd82370a6e55cd75db319)            | No tag returned                                                             | [AGPL-3.0](https://github.com/ZeroDot1/LLMWikiNG/blob/e8508d586534799fc47cd82370a6e55cd75db319/LICENSE)                                                                   |   226 files; 27 test paths; 1 workflow |
| `OrangeproAI/orangepro-mcp`     | `main` — [`b7c05e1a27a8d151502eb4c86eeaa8d28229dd31`](https://github.com/OrangeproAI/orangepro-mcp/tree/b7c05e1a27a8d151502eb4c86eeaa8d28229dd31)     | `v0.2.22` → `2b2e1f45fd101a3c228a0c89598fedc9395a7e51`                      | [MIT](https://github.com/OrangeproAI/orangepro-mcp/blob/b7c05e1a27a8d151502eb4c86eeaa8d28229dd31/LICENSE)                                                                 |  773 files; 591 test paths; 1 workflow |

AKP has no root `LICENSE` file at the inspected revision. That is an unresolved
distribution decision, not a competitive score. License compatibility must be
reviewed before copying implementation code; this audit recommends ideas and
interfaces, not source-code transplantation.

## Capability-by-capability assessment

### 1. Multimodal ingest

our_capability: AKP executes text/Markdown, PDF page text, safe local HTML and
image metadata extraction. Unsupported media returns an explicit capability
status. It does not execute OCR/vision, DOCX/PPTX transformation or audio/video
transcription.

our_evidence:

- [`apps/extractor/app/main.py`](apps/extractor/app/main.py)
- [`apps/extractor/app/extractors/pdf.py`](apps/extractor/app/extractors/pdf.py)
- [`apps/extractor/app/extractors/image.py`](apps/extractor/app/extractors/image.py)
- [`apps/extractor/tests`](apps/extractor/tests)

reference: `nashsu/llm_wiki`.

reference_evidence:

- [image extraction command](https://github.com/nashsu/llm_wiki/blob/fa2652eb8186635c2b251007d0a46b0614528a7d/src-tauri/src/commands/extract_images.rs)
- [browser clipper core](https://github.com/nashsu/llm_wiki/blob/fa2652eb8186635c2b251007d0a46b0614528a7d/extension/clipper-core.js)
- [source-watch UI](https://github.com/nashsu/llm_wiki/blob/fa2652eb8186635c2b251007d0a46b0614528a7d/src/components/settings/sections/source-watch-section.tsx)

assessment: `WORSE_THAN_REFERENCE`.

gap: AKP lacks visual evidence extraction, browser capture, watched source
folders and the reference's broader packaged format surface.

implementation: Retain immutable SHA-256 storage and add capability adapters
for OCR/vision, Office formats and capture. Do not pretend that image metadata
or an audio/video contract is content extraction.

test_or_benchmark: Add golden locator tests for scanned PDFs, figures, tables,
DOCX/PPTX and timestamped media; compare factual retention and locator accuracy.

remaining_risk: Provider OCR/vision can silently drop layout or invent captions;
human review and original-page locators remain mandatory.

### 2. Durable jobs

our_capability: PostgreSQL jobs have state transitions, leases, heartbeats,
retry backoff, cancellation, quarantine/failure states and lease-owner fencing.

our_evidence:

- [`apps/worker/src/worker.ts`](apps/worker/src/worker.ts)
- [`packages/postgres/src/index.ts`](packages/postgres/src/index.ts)
- [`db/migrations/001_init.sql`](db/migrations/001_init.sql)
- [`db/migrations/005_provenance_and_job_fencing.sql`](db/migrations/005_provenance_and_job_fencing.sql)

reference: `nashsu/llm_wiki`.

reference_evidence:

- [real-filesystem persistence/restore tests](https://github.com/nashsu/llm_wiki/blob/fa2652eb8186635c2b251007d0a46b0614528a7d/src/lib/ingest-queue.integration.test.ts)
- [queue tests](https://github.com/nashsu/llm_wiki/blob/fa2652eb8186635c2b251007d0a46b0614528a7d/src/lib/ingest-queue.test.ts)

assessment: `ROUGHLY_COMPARABLE`.

gap: Both trees encode persistence and recovery, but no shared fault-injection
run compares ordering, throughput, duplicate suppression or lost-heartbeat
behavior.

implementation: Keep the database-backed queue and fencing. Adopt the
reference's user-visible queue diagnostics, not its desktop-local storage as
the team backend.

test_or_benchmark: AKP's integration suite passed stale-lease reclaim; add
repeated kill/restart tests at every state boundary and a multiworker contention
campaign.

remaining_risk: Single-node local success does not prove multinode fencing or
exactly-once side effects across PostgreSQL, MinIO and Git.

### 3. Crash recovery

our_capability: AKP reclaims expired worker leases, abandons uncertain expired
idempotency claims, preserves isolated drafts, compensates failed publication
and performs an isolated backup restore.

our_evidence:

- [`apps/api/test/security.integration.test.ts`](apps/api/test/security.integration.test.ts)
- [`apps/api/test/review-publication.integration.test.ts`](apps/api/test/review-publication.integration.test.ts)
- [`packages/git-store/src/index.ts`](packages/git-store/src/index.ts)
- [`scripts/restore-smoke.ps1`](scripts/restore-smoke.ps1)

reference: `nashsu/llm_wiki` and `gowtham0992/link`.

reference_evidence:

- [queue restore round-trip](https://github.com/nashsu/llm_wiki/blob/fa2652eb8186635c2b251007d0a46b0614528a7d/src/lib/ingest-queue.integration.test.ts)
- [Link backup tests](https://github.com/gowtham0992/link/blob/643e208adbbe2dfd1c91bf9e8305e6dec2b037a6/tests/test_backup_core.py)

assessment: `ROUGHLY_COMPARABLE`.

gap: AKP exercises more storage boundaries, while the references encode mature
local recovery paths; none were run in the same crash schedule.

implementation: Preserve fail-closed idempotency and compensation. Add an
operator-visible recovery ledger and deterministic chaos schedule.

test_or_benchmark: Existing restart-lease and restore gates passed. Required
next evidence is kill-after-side-effect testing for raw store, draft commit,
merge, reindex and audit append.

remaining_risk: A process may die after an external side effect and before the
database records it; the local baseline does not eliminate every split-brain
window.

### 4. Compiled knowledge

our_capability: AKP uses a typed `CompilationPlan`, explicit dispositions,
deterministic validation, critical probes, impact manifests and reviewed Git
publication.

our_evidence:

- [`packages/compiler/src/index.ts`](packages/compiler/src/index.ts)
- [`apps/worker/src/worker.ts`](apps/worker/src/worker.ts)
- [`packages/policy/test/approval.test.ts`](packages/policy/test/approval.test.ts)

reference: `nashsu/llm_wiki` and `frankchu91/mindbase`.

reference_evidence:

- [nashsu ingest implementation tree](https://github.com/nashsu/llm_wiki/tree/fa2652eb8186635c2b251007d0a46b0614528a7d/src-tauri/src)
- [MindBase compile context tests](https://github.com/frankchu91/mindbase/blob/62f301eb1099f1e8b1e6f0e5ad191dfb2c4e4489/packages/core/src/compile/context.test.ts)

assessment: `UNKNOWN_NOT_REPRODUCED`.

gap: Structural safeguards are inspectable, but no common source corpus and
human grading protocol measures semantic retention, contradiction preservation
or compilation usefulness.

implementation: Retain the two-step plan/validation boundary. Borrow bounded
compile-context techniques only after fitting them to Source → Evidence → Claim
provenance.

test_or_benchmark: Run all compilers on the same public sources and grade fact
retention, unsupported additions, identity duplication, update precision and
review effort.

remaining_risk: Green structural validation can coexist with weak or misleading
compiled prose.

### 5. Lexical retrieval

our_capability: AKP executes exact/alias lookup, PostgreSQL full-text retrieval,
typed filters, fallback token matching and RRF fusion.

our_evidence:

- [`apps/api/src/routes/search.ts`](apps/api/src/routes/search.ts)
- [`packages/retrieval/src/rrf.ts`](packages/retrieval/src/rrf.ts)
- [`packages/retrieval/test/rrf.test.ts`](packages/retrieval/test/rrf.test.ts)

reference: `gowtham0992/link`.

reference_evidence:

- [1,176-case results, configurations and negative experiments](https://github.com/gowtham0992/link/blob/643e208adbbe2dfd1c91bf9e8305e6dec2b037a6/benchmarks/RESULTS.md)
- [recall benchmark tests](https://github.com/gowtham0992/link/blob/643e208adbbe2dfd1c91bf9e8305e6dec2b037a6/tests/test_recall_benchmark.py)

assessment: `WORSE_THAN_REFERENCE`.

gap: AKP's four cases are insufficient beside the reference's 1,176-case
offline benchmark and documented failed ablations.

implementation: Preserve exact-first routing; adopt a larger versioned dataset,
held-out slices and negative experiment ledger.

test_or_benchmark: Expand AKP's dataset across framework identifiers,
cross-language queries, no-answer cases and disputed evidence before tuning.

remaining_risk: The current `lexical+graph` recommendation may be overfit to four
cases.

### 6. Vector retrieval

our_capability: AKP stores deterministic 64-dimensional embeddings in pgvector,
has a provider port and vector search, but keeps vectors outside the default
route pending evidence.

our_evidence:

- [`packages/retrieval/src/embeddings.ts`](packages/retrieval/src/embeddings.ts)
- [`apps/api/src/routes/search.ts`](apps/api/src/routes/search.ts)
- [`db/migrations/004_hybrid_freshness_governance.sql`](db/migrations/004_hybrid_freshness_governance.sql)
- [`RETRIEVAL_BENCHMARK.md`](RETRIEVAL_BENCHMARK.md)

reference: `XBlueSky/cortexes`.

reference_evidence:

- [evaluation adapters](https://github.com/XBlueSky/cortexes/blob/0fd54c80f9361c3f9de6df08ea9f3fe30ee73c20/cortex-vec/src/cortex_vec/eval/adapters.py)
- [evaluation runner](https://github.com/XBlueSky/cortexes/blob/0fd54c80f9361c3f9de6df08ea9f3fe30ee73c20/cortex-vec/src/cortex_vec/eval/run.py)
- [fusion/graph tests](https://github.com/XBlueSky/cortexes/blob/0fd54c80f9361c3f9de6df08ea9f3fe30ee73c20/cortex-vec/tests/test_fusion_graph.py)

assessment: `WORSE_THAN_REFERENCE`.

gap: AKP has no demonstrated semantic model lift, cross-language vector quality
or production embedding generation. Deterministic hash embeddings exercise the
adapter; they are not semantic-quality evidence.

implementation: Keep vector retrieval benchmark-only and provider-neutral.
Adopt real semantic embeddings only through a versioned generation and measured
activation decision.

test_or_benchmark: Compare lexical, vector and fused modes on a substantially
larger held-out bilingual dataset, including identifier-regression gates.

remaining_risk: Enabling the current vector channel by configuration could give
a false impression of semantic quality.

### 7. Graph retrieval

our_capability: AKP compiles typed document relations, seeds graph expansion
from retrieval hits and fuses graph neighbors through RRF.

our_evidence:

- [`packages/vault-importer/src/index.ts`](packages/vault-importer/src/index.ts)
- [`apps/api/src/routes/search.ts`](apps/api/src/routes/search.ts)
- [`apps/api/src/routes/knowledge.ts`](apps/api/src/routes/knowledge.ts)

reference: `green-dalii/obsidian-llm-wiki`.

reference_evidence:

- [PPR cascade tests](https://github.com/green-dalii/obsidian-llm-wiki/blob/1f9a18559729f366df10ba593dfd54fef1b59cc0/src/__tests__/core/ppr-cascade.test.ts)
- [Monte Carlo PPR tests](https://github.com/green-dalii/obsidian-llm-wiki/blob/1f9a18559729f366df10ba593dfd54fef1b59cc0/src/__tests__/core/monte-carlo-ppr.test.ts)
- [recall evaluation script](https://github.com/green-dalii/obsidian-llm-wiki/blob/1f9a18559729f366df10ba593dfd54fef1b59cc0/scripts/eval-recall.ts)

assessment: `WORSE_THAN_REFERENCE`.

gap: AKP lacks evaluated PPR/multihop ranking and has only four local benchmark
queries. Typed edges improve explainability but do not prove ranking quality.

implementation: Evaluate PPR as an optional rank stream. Preserve relation type,
provenance and permission filters instead of moving authoritative retrieval into
an Obsidian plugin.

test_or_benchmark: Add linked-neighbor stress cases, disconnected-component
cases and adverse hub tests; measure recall and citation precision before any
graph boost becomes a default.

remaining_risk: Dense low-authority wikilinks can amplify irrelevant hubs or
leak cross-space neighbors if filters regress.

### 8. Context packaging

our_capability: AKP persists task-specific ContextPackets with corpus/index
revisions, channel explanations, trust/lifecycle filters, citations, conflicts,
gaps, exact token budgets, hashes and continuation handles.

our_evidence:

- [`packages/contracts/src/index.ts`](packages/contracts/src/index.ts)
- [`packages/retrieval/src/context-packet.ts`](packages/retrieval/src/context-packet.ts)
- [`packages/retrieval/test/context-packet.test.ts`](packages/retrieval/test/context-packet.test.ts)
- [`apps/api/src/routes/search.ts`](apps/api/src/routes/search.ts)

reference: `frankchu91/mindbase`.

reference_evidence:

- [bounded compile-context tests](https://github.com/frankchu91/mindbase/blob/62f301eb1099f1e8b1e6f0e5ad191dfb2c4e4489/packages/core/src/compile/context.test.ts)
- [MCP context implementation](https://github.com/frankchu91/mindbase/blob/62f301eb1099f1e8b1e6f0e5ad191dfb2c4e4489/apps/mcp/src/context.ts)

assessment: `BETTER_WITH_EVIDENCE`.

gap: This assessment is limited to revision/provenance-bearing packet structure
and executed budget/continuation behavior. It does not claim better answer
quality or better total agent experience.

implementation: Retain ContextPacket as the stable agent contract. Adopt useful
reference context selection ideas without collapsing task context into a single
global `context.md`.

test_or_benchmark: AKP's packet unit tests and runtime persistence passed. Add
packet-level evidence recall, token utility and continuation-completion metrics
on a larger held-out set.

remaining_risk: A structurally complete packet can still select the wrong
evidence; packet correctness depends on retrieval and provenance quality.

### 9. MCP interoperability

our_capability: AKP exposes 18 schema-described tools over stdio and
authenticated Streamable HTTP, with a CLI using the same API use cases. A
generic stdio client exercised the full catalog's status/search path.

our_evidence:

- [`apps/mcp/src/server.ts`](apps/mcp/src/server.ts)
- [`apps/mcp/src/http.ts`](apps/mcp/src/http.ts)
- [`scripts/mcp-smoke.ts`](scripts/mcp-smoke.ts)
- [`contracts/mcp-tools.json`](contracts/mcp-tools.json)

reference: `frankchu91/mindbase` and `ZeroDot1/LLMWikiNG`.

reference_evidence:

- [MindBase tool registrations](https://github.com/frankchu91/mindbase/blob/62f301eb1099f1e8b1e6f0e5ad191dfb2c4e4489/apps/mcp/src/tools/index.ts)
- [MindBase MCP E2E test](https://github.com/frankchu91/mindbase/blob/62f301eb1099f1e8b1e6f0e5ad191dfb2c4e4489/apps/server/test/mcp-tools-e2e.test.ts)
- [LLMWikiNG MCP route and permission wrapper](https://github.com/ZeroDot1/LLMWikiNG/blob/e8508d586534799fc47cd82370a6e55cd75db319/backend/api/routes/mcp.py)

assessment: `ROUGHLY_COMPARABLE`.

gap: Protocol surfaces are inspectable, but reference catalogs were not
handshaken here and AKP's HTTP transport lacks a separately recorded current
generic-client matrix across multiple clients.

implementation: Keep tools thin and client-neutral. Prefer bounded domain tools
over copying reference tool count as a quality target.

test_or_benchmark: Maintain 18/18 catalog smoke, add authenticated Streamable
HTTP handshake/cancellation/continuation tests and a negative permission matrix.

remaining_risk: Tool enumeration does not prove every write tool is safe under
retries, disconnects and mixed client protocol versions.

### 10. Review workflow

our_capability: AKP creates one isolated Git worktree per review, validates
drafts, records comments/decisions, enforces optimistic revisions and a
publication lock, merges, reindexes, rejects, requests changes and rolls back.

our_evidence:

- [`packages/git-store/src/index.ts`](packages/git-store/src/index.ts)
- [`apps/api/src/routes/reviews.ts`](apps/api/src/routes/reviews.ts)
- [`packages/git-store/test/isolated-drafts.test.ts`](packages/git-store/test/isolated-drafts.test.ts)
- [`apps/api/test/review-publication.integration.test.ts`](apps/api/test/review-publication.integration.test.ts)

reference: `mohammadmaso/kherad`.

reference_evidence:

- [merge-request API](https://github.com/mohammadmaso/kherad/blob/2a8d6992b87a33760688e1f956653c21a6292294/apps/api/src/routes/merge-requests.ts)
- [conflict resolver](https://github.com/mohammadmaso/kherad/blob/2a8d6992b87a33760688e1f956653c21a6292294/apps/web/src/components/mr/conflict-resolver.tsx)
- [Git engine tests](https://github.com/mohammadmaso/kherad/blob/2a8d6992b87a33760688e1f956653c21a6292294/packages/core/src/git/engine.test.ts)

assessment: `ROUGHLY_COMPARABLE`.

gap: AKP has executed backend lifecycle proof; Kherad has a substantially richer
editorial UI, inline diff/comment and conflict-resolution surface.

implementation: Preserve isolated worktrees and publication fencing. Adapt
autosave, inline review and conflict UX without adopting a shared mutable draft
worktree.

test_or_benchmark: AKP's five publication cases passed. Add two-editor conflict,
comment-anchor stability, rebase and interrupted-merge scenarios.

remaining_risk: Git merge plus projection update remains a compensated workflow,
not a distributed atomic transaction.

### 11. RBAC

our_capability: AKP implements organization/space membership, seven roles,
permission checks, path prefixes, credential scope snapshots and denial of
pathless metadata to path-scoped identities.

our_evidence:

- [`apps/api/src/auth.ts`](apps/api/src/auth.ts)
- [`apps/api/test/auth-space.test.ts`](apps/api/test/auth-space.test.ts)
- [`apps/api/test/security.integration.test.ts`](apps/api/test/security.integration.test.ts)
- [`db/migrations/010_token_scopes_and_idempotency_claims.sql`](db/migrations/010_token_scopes_and_idempotency_claims.sql)

reference: `masumi-network/Citadel`, `mohammadmaso/kherad` and
`ZeroDot1/LLMWikiNG`.

reference_evidence:

- [Citadel Node/Central promotion policy](https://github.com/masumi-network/Citadel/blob/cc8fc026297b64f39f387b96e30da63f77ad57fb/docs/adr/0007-seat-capture-promotion-write-policy.md)
- [Kherad permissions tests](https://github.com/mohammadmaso/kherad/blob/2a8d6992b87a33760688e1f956653c21a6292294/packages/core/src/permissions/check-permission.test.ts)
- [LLMWikiNG MCP permission checks](https://github.com/ZeroDot1/LLMWikiNG/blob/e8508d586534799fc47cd82370a6e55cd75db319/backend/api/routes/mcp.py)

assessment: `UNKNOWN_NOT_REPRODUCED`.

gap: AKP's local tests passed, but no shared cross-tenant harness executed the
references and AKP has no database row-level security or enterprise identity
provider.

implementation: Retain server-side space/path re-intersection. Add RLS as
defense in depth before remote multi-tenant deployment; do not infer isolation
from UI visibility.

test_or_benchmark: Run the same confused-deputy, revoked-membership,
cross-space-search and raw-object access suite against every exposed transport.

remaining_risk: An omitted application filter can still bypass application-only
tenant isolation.

### 12. Staleness and invalidation

our_capability: AKP stores freshness metadata, traverses typed dependencies,
marks downstream nodes stale or blocked, filters blocked material from search,
creates Error Book entries and requires explicit verification to clear state.

our_evidence:

- [`apps/api/src/routes/governance.ts`](apps/api/src/routes/governance.ts)
- [`apps/api/src/projections.ts`](apps/api/src/projections.ts)
- [`apps/api/src/routes/search.ts`](apps/api/src/routes/search.ts)
- [`apps/api/test/security.integration.test.ts`](apps/api/test/security.integration.test.ts)

reference: `gowtham0992/link` and `frankchu91/mindbase`.

reference_evidence:

- [Link review/expiry implementation](https://github.com/gowtham0992/link/blob/643e208adbbe2dfd1c91bf9e8305e6dec2b037a6/mcp_package/link_core/memory.py)
- [MindBase contradiction/gap tool](https://github.com/frankchu91/mindbase/blob/62f301eb1099f1e8b1e6f0e5ad191dfb2c4e4489/apps/mcp/src/tools/find-contradictions.ts)

assessment: `BETTER_WITH_EVIDENCE`.

gap: The favorable assessment is only for executed recursive typed-dependency
invalidation and retrieval blocking. Link has richer personal-memory expiry,
which this classification does not cover.

implementation: Preserve immediate cascade invalidation and scheduled lint.
Adapt user-facing review dates without weakening source-driven invalidation.

test_or_benchmark: AKP integration tests passed source retirement, two-hop
staleness, stale blocking and Error Book regression creation.

remaining_risk: Missing or incorrectly typed dependency edges cause false
negatives; scheduled lint cannot repair an absent trail automatically.

### 13. Contradiction handling

our_capability: AKP persists contradiction clusters with members, authority,
scope, status, resolution and reviewer; unresolved clusters are included in
ContextPackets and resolution is audited.

our_evidence:

- [`apps/api/src/routes/governance.ts`](apps/api/src/routes/governance.ts)
- [`db/migrations/004_hybrid_freshness_governance.sql`](db/migrations/004_hybrid_freshness_governance.sql)
- [`apps/api/src/routes/search.ts`](apps/api/src/routes/search.ts)
- [`apps/api/test/security.integration.test.ts`](apps/api/test/security.integration.test.ts)

reference: `green-dalii/obsidian-llm-wiki` and `frankchu91/mindbase`.

reference_evidence:

- [contradiction marker tests](https://github.com/green-dalii/obsidian-llm-wiki/blob/1f9a18559729f366df10ba593dfd54fef1b59cc0/src/__tests__/core/contradicted-marker.test.ts)
- [duplicate/merge lint tests](https://github.com/green-dalii/obsidian-llm-wiki/blob/1f9a18559729f366df10ba593dfd54fef1b59cc0/src/__tests__/wiki/lint/duplicate-detection.test.ts)
- [MindBase contradiction tool](https://github.com/frankchu91/mindbase/blob/62f301eb1099f1e8b1e6f0e5ad191dfb2c4e4489/apps/mcp/src/tools/find-contradictions.ts)

assessment: `BETTER_WITH_EVIDENCE`.

gap: The assessment is limited to the executed explicit cluster lifecycle and
packet propagation. It does not prove stronger automatic contradiction
detection.

implementation: Keep contradictions as first-class unresolved knowledge. Add
candidate detection only as a review queue; never auto-overwrite one claim with
another.

test_or_benchmark: AKP executed create, surface and resolve flows. Add semantic
paraphrase, scope-dependent truth and authority-conflict datasets.

remaining_risk: Detection recall remains weak without a larger semantic
candidate stage; false positives can create reviewer fatigue.

### 14. Code evidence

our_capability: AKP scans repository identity and immutable commit locators,
emits structural signals as `NO_SIGNAL`, and refuses to promote regex matches to
verified evidence without deterministic links.

our_evidence:

- [`packages/project-adapter/src/index.ts`](packages/project-adapter/src/index.ts)
- [`packages/project-adapter/test/evidence-tier.test.ts`](packages/project-adapter/test/evidence-tier.test.ts)
- [`apps/api/src/routes/projects.ts`](apps/api/src/routes/projects.ts)

reference: `OrangeproAI/orangepro-mcp`.

reference_evidence:

- [local operations](https://github.com/OrangeproAI/orangepro-mcp/blob/b7c05e1a27a8d151502eb4c86eeaa8d28229dd31/src/local/operations.ts)
- [dynamic proof trust tests](https://github.com/OrangeproAI/orangepro-mcp/blob/b7c05e1a27a8d151502eb4c86eeaa8d28229dd31/tests/local/autoProve.test.ts)
- [Java proof integration](https://github.com/OrangeproAI/orangepro-mcp/blob/b7c05e1a27a8d151502eb4c86eeaa8d28229dd31/tests/local/javaProveIntegration.test.ts)

assessment: `WORSE_THAN_REFERENCE`.

gap: AKP lacks symbol/dependency graphs, deterministic test-to-symbol links,
runtime coverage ingestion and mutation-kill proof.

implementation: Keep `NO_SIGNAL` fail-closed semantics and add OrangePro only
through an optional `ProjectAdapter`. Do not make it the canonical knowledge
store or copy its evidence tier without its proof oracle.

test_or_benchmark: Add public fixture repositories for Java, .NET, Angular and
Vue with known symbol/test/impact truth, then integrate runtime and mutation
evidence.

remaining_risk: Structural presence can still be misread by consumers as
architectural intent despite the explicit tier and limitation.

### 15. Evaluation

our_capability: AKP computes recall, precision, MRR, nDCG, citation precision,
unsupported-answer rate and latency across 11 retrieval configurations, stores
runs and gates critical failures.

our_evidence:

- [`packages/evaluation/src/index.ts`](packages/evaluation/src/index.ts)
- [`apps/api/src/routes/evaluation.ts`](apps/api/src/routes/evaluation.ts)
- [`evals/generic/retrieval/basic.jsonl`](evals/generic/retrieval/basic.jsonl)
- [`RETRIEVAL_BENCHMARK.md`](RETRIEVAL_BENCHMARK.md)

reference: `gowtham0992/link` and `XBlueSky/cortexes`.

reference_evidence:

- [Link benchmark results and caveats](https://github.com/gowtham0992/link/blob/643e208adbbe2dfd1c91bf9e8305e6dec2b037a6/benchmarks/RESULTS.md)
- [Link recall-quality runner](https://github.com/gowtham0992/link/blob/643e208adbbe2dfd1c91bf9e8305e6dec2b037a6/scripts/eval_recall_quality.py)
- [Cortexes evaluation runner](https://github.com/XBlueSky/cortexes/blob/0fd54c80f9361c3f9de6df08ea9f3fe30ee73c20/cortex-vec/src/cortex_vec/eval/run.py)

assessment: `WORSE_THAN_REFERENCE`.

gap: AKP has broad metric code but only four gold cases. Link includes 1,176
recall cases plus poisoning/hygiene evaluations; Cortexes has adapter-oriented
evaluation and long-source tooling.

implementation: Prioritize dataset quality and held-out slices over adding more
metrics. Preserve losing configurations and caveats in versioned reports.

test_or_benchmark: Add source-grounding judgments, no-answer accuracy, exact
identifier and bilingual slices; separate development and test sets.

remaining_risk: Repeated tuning against the same four cases can make every
metric look stable while generalization degrades.

### 16. Security

our_capability: AKP has scoped tokens/sessions, space/path authorization,
idempotency fencing, ingest-root controls, path normalization, sanitization,
rate limits, secret scanning, local binds and audited operations.

our_evidence:

- [`apps/api/src/auth.ts`](apps/api/src/auth.ts)
- [`apps/api/test/security.integration.test.ts`](apps/api/test/security.integration.test.ts)
- [`scripts/scan-secrets.mjs`](scripts/scan-secrets.mjs)
- [`SECURITY_REPORT.md`](SECURITY_REPORT.md)

reference: `gowtham0992/link`, `masumi-network/Citadel` and
`ZeroDot1/LLMWikiNG`.

reference_evidence:

- [Link poisoning evaluation](https://github.com/gowtham0992/link/blob/643e208adbbe2dfd1c91bf9e8305e6dec2b037a6/scripts/eval_memory_poisoning.py)
- [Citadel security tests](https://github.com/masumi-network/Citadel/blob/cc8fc026297b64f39f387b96e30da63f77ad57fb/tests/test_security_scan.py)
- [LLMWikiNG security tests](https://github.com/ZeroDot1/LLMWikiNG/blob/e8508d586534799fc47cd82370a6e55cd75db319/tests/test_security.py)

assessment: `UNKNOWN_NOT_REPRODUCED`.

gap: AKP's 21 local security/governance cases passed, but references were not
run under the same adversarial suite. AKP also lacks RLS, enterprise identity,
encrypted backups and an external penetration review.

implementation: Retain local fail-closed controls and add layered storage
enforcement before network exposure. Reuse reference attack scenarios, not
their claims.

test_or_benchmark: Create a common attack corpus for prompt injection, poisoned
memory, SSRF, confused deputy, revoked credentials, path escape and backup
secret leakage.

remaining_risk: Application-only tenant enforcement and local threat testing do
not justify an internet-facing multi-tenant deployment.

### 17. Backup and restore

our_capability: AKP creates a manifest-bound backup of PostgreSQL, MinIO and the
managed Git repository, verifies hashes and exact migrations, and restores into
isolated services.

our_evidence:

- [`scripts/backup.ps1`](scripts/backup.ps1)
- [`scripts/restore-smoke.ps1`](scripts/restore-smoke.ps1)
- [`docs/runbooks/local-operations.md`](docs/runbooks/local-operations.md)
- [`VALIDATION_REPORT.md`](VALIDATION_REPORT.md)

reference: `ZeroDot1/LLMWikiNG` and `gowtham0992/link`.

reference_evidence:

- [LLMWikiNG backup service](https://github.com/ZeroDot1/LLMWikiNG/blob/e8508d586534799fc47cd82370a6e55cd75db319/backend/services/backup.py)
- [LLMWikiNG backup tests](https://github.com/ZeroDot1/LLMWikiNG/blob/e8508d586534799fc47cd82370a6e55cd75db319/tests/test_backup.py)
- [Link backup tests](https://github.com/gowtham0992/link/blob/643e208adbbe2dfd1c91bf9e8305e6dec2b037a6/tests/test_backup_core.py)

assessment: `UNKNOWN_NOT_REPRODUCED`.

gap: AKP's multi-store restore passed, but reference restore suites were only
inspected. No common corruption, partial archive or cross-version recovery
campaign was run.

implementation: Keep fixed artifact manifests and isolated restore. Add
retention, encryption and periodic off-machine restore drills.

test_or_benchmark: Execute corrupted-chunk, missing-object, wrong-migration,
rotated-secret and older-version restores with measured recovery objectives.

remaining_risk: A local backup stored with the host does not protect against
host loss, ransomware or credential compromise.

### 18. Observability

our_capability: AKP emits trace IDs, spans and metrics through an OpenTelemetry
API bridge; exposes liveness/readiness and persists audit events and job/index
health.

our_evidence:

- [`packages/observability/src/index.ts`](packages/observability/src/index.ts)
- [`packages/observability/test/bridge.test.ts`](packages/observability/test/bridge.test.ts)
- [`apps/api/src/server.ts`](apps/api/src/server.ts)
- [`apps/api/src/routes/audit.ts`](apps/api/src/routes/audit.ts)

reference: `masumi-network/Citadel`, `ZeroDot1/LLMWikiNG` and
`nashsu/llm_wiki`.

reference_evidence:

- [Citadel activity/audit implementation tree](https://github.com/masumi-network/Citadel/tree/cc8fc026297b64f39f387b96e30da63f77ad57fb)
- [LLMWikiNG audit service](https://github.com/ZeroDot1/LLMWikiNG/blob/e8508d586534799fc47cd82370a6e55cd75db319/backend/services/audit.py)
- [nashsu activity/queue implementation tree](https://github.com/nashsu/llm_wiki/tree/fa2652eb8186635c2b251007d0a46b0614528a7d/src)

assessment: `UNKNOWN_NOT_REPRODUCED`.

gap: AKP's hooks and health checks execute locally, but no collector/exporter,
alert policy, trace retention or cross-reference observability benchmark was
run.

implementation: Keep vendor-neutral OpenTelemetry hooks; add an actual collector
profile, SLOs and stuck-job/index alerts before claiming operational coverage.

test_or_benchmark: Run trace propagation across API → worker → extractor → Git
and inject dependency latency/failure while verifying alert and audit linkage.

remaining_risk: A no-op telemetry provider produces valid trace IDs without
delivering durable operational visibility.

### 19. Human UX

our_capability: AKP has web routes for search, packet/provenance inspection,
sources/ingest, jobs, reviews, knowledge, graph, evals, login and admin health;
Obsidian remains the direct reading companion.

our_evidence:

- [`apps/web/app`](apps/web/app)
- [`apps/web/lib`](apps/web/lib)
- [`README.md`](README.md)
- [`VALIDATION_REPORT.md`](VALIDATION_REPORT.md)

reference: `mohammadmaso/kherad`, `nashsu/llm_wiki` and
`green-dalii/obsidian-llm-wiki`.

reference_evidence:

- [Kherad editor](https://github.com/mohammadmaso/kherad/blob/2a8d6992b87a33760688e1f956653c21a6292294/apps/web/src/components/editor/editor.tsx)
- [Kherad conflict resolver](https://github.com/mohammadmaso/kherad/blob/2a8d6992b87a33760688e1f956653c21a6292294/apps/web/src/components/mr/conflict-resolver.tsx)
- [nashsu desktop UI tree](https://github.com/nashsu/llm_wiki/tree/fa2652eb8186635c2b251007d0a46b0614528a7d/src)
- [Obsidian plugin entry](https://github.com/green-dalii/obsidian-llm-wiki/blob/1f9a18559729f366df10ba593dfd54fef1b59cc0/src/main.ts)

assessment: `WORSE_THAN_REFERENCE`.

gap: AKP's route smoke proves availability, not editor polish, autosave, inline
comments, rich conflict resolution, native Obsidian ergonomics or desktop
capture.

implementation: Improve review/provenance UX and later add a thin Obsidian
client calling API/MCP. Do not duplicate retrieval and policy inside the plugin.

test_or_benchmark: Add browser E2E for full ingest/review/conflict/accessibility
flows and conduct task-based usability studies with curators and students.

remaining_risk: A technically complete backend may remain unusable for
nontechnical reviewers, weakening the human-review control.

### 20. Agent UX

our_capability: AKP provides 18 bounded MCP tools, CLI commands, ContextPackets,
structured errors, continuation handles and a thin repository router.

our_evidence:

- [`apps/mcp/src/server.ts`](apps/mcp/src/server.ts)
- [`apps/cli/src/main.ts`](apps/cli/src/main.ts)
- [`scripts/mcp-smoke.ts`](scripts/mcp-smoke.ts)
- [`AGENTS.md`](AGENTS.md)

reference: `frankchu91/mindbase`, `gowtham0992/link` and
`masumi-network/Citadel`.

reference_evidence:

- [MindBase MCP tool registry](https://github.com/frankchu91/mindbase/blob/62f301eb1099f1e8b1e6f0e5ad191dfb2c4e4489/apps/mcp/src/tools/index.ts)
- [Link MCP contract tests](https://github.com/gowtham0992/link/blob/643e208adbbe2dfd1c91bf9e8305e6dec2b037a6/tests/test_mcp_contract.py)
- [Citadel MCP tests](https://github.com/masumi-network/Citadel/blob/cc8fc026297b64f39f387b96e30da63f77ad57fb/tests/test_mcp_server.py)

assessment: `WORSE_THAN_REFERENCE`.

gap: AKP has a smaller proven interaction repertoire and lacks the references'
packaged client distribution, capture hooks, memory lifecycle ergonomics and
longer-running agent workflows.

implementation: Keep the 18-tool surface cohesive; add workflow resources,
client fixtures and session continuity based on observed user tasks rather than
tool-count competition.

test_or_benchmark: Run multi-client agent tasks for evidence lookup, source
submission, review, retry, insufficient knowledge and continuation under fixed
token budgets.

remaining_risk: A tool may be protocol-correct yet difficult for agents to
select or sequence reliably.

## Assessment distribution

Across the 20 mandatory categories:

| Assessment               | Count | Categories                                                                                                             |
| ------------------------ | ----: | ---------------------------------------------------------------------------------------------------------------------- |
| `WORSE_THAN_REFERENCE`   |     8 | multimodal ingest, lexical retrieval, vector retrieval, graph retrieval, code evidence, evaluation, human UX, agent UX |
| `ROUGHLY_COMPARABLE`     |     4 | durable jobs, crash recovery, MCP interoperability, review workflow                                                    |
| `BETTER_WITH_EVIDENCE`   |     3 | context packaging, staleness/invalidation, contradiction handling                                                      |
| `UNKNOWN_NOT_REPRODUCED` |     5 | compiled knowledge, RBAC, security, backup/restore, observability                                                      |

The distribution is intentionally negative. AKP's favorable findings concern
three narrow governance/context mechanisms. They do not cancel its substantial
gaps in source capture, retrieval evidence, code proof, benchmark scale and
human/agent ergonomics.

## Adopt, adapt and reject consequences

| Reference                       | Adopt or adapt                                                                         | Reject or defer                                                                                                | Current assessment consequence                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `nashsu/llm_wiki`               | watched sources, web capture, visual extraction and visible queue recovery             | desktop runtime as the team authority                                                                          | `WORSE_THAN_REFERENCE` in multimodal and human capture                                                         |
| `green-dalii/obsidian-llm-wiki` | thin Obsidian UX and benchmarked PPR candidate                                         | graph boost before grounding evidence                                                                          | `WORSE_THAN_REFERENCE` in graph evaluation and Obsidian UX                                                     |
| `frankchu91/mindbase`           | bounded compile context and useful MCP workflow patterns                               | global context file as the only task contract; tool count as quality                                           | `BETTER_WITH_EVIDENCE` only for AKP's revision/provenance packet; agent breadth remains `WORSE_THAN_REFERENCE` |
| `gowtham0992/link`              | large offline benchmarks, negative ablations, poisoning/hygiene cases and lifecycle UX | direct score comparison across unrelated corpora                                                               | `WORSE_THAN_REFERENCE` in evaluation maturity                                                                  |
| `XBlueSky/cortexes`             | raw map/span navigation, resumable distillation plans and adapter evaluation           | provider-specific vector dependency as canonical storage                                                       | `WORSE_THAN_REFERENCE` in long-source/vector evaluation                                                        |
| `mohammadmaso/kherad`           | autosave, inline comments, rendered/raw diff and conflict UX                           | shared mutable publication state                                                                               | `ROUGHLY_COMPARABLE` backend review; human UX remains `WORSE_THAN_REFERENCE`                                   |
| `masumi-network/Citadel`        | explicit private/team promotion and audited capture                                    | automatic private-to-central mirroring                                                                         | RBAC/promotion runtime parity is `UNKNOWN_NOT_REPRODUCED`                                                      |
| `ZeroDot1/LLMWikiNG`            | watcher/admin/backup visibility and MCP permission scenarios                           | destructive restore/update behavior without stronger isolation; source copying under AGPL without legal review | operational parity is `UNKNOWN_NOT_REPRODUCED`                                                                 |
| `OrangeproAI/orangepro-mcp`     | optional dynamic proof adapter and strict evidence-tier semantics                      | regex proximity as proof; coupling AKP's canonical store to code analysis                                      | `WORSE_THAN_REFERENCE` in executable code evidence                                                             |

## Priority gaps

1. Grow the four-case gold set into versioned development and held-out suites
   covering every GOAL V2 slice, no-answer, poisoning and grounding.
2. Add bounded raw-map/span navigation and resumable distillation for long
   sources before expanding LLM compilation autonomy.
3. Implement a real semantic embedding generation only behind benchmarked
   activation; keep vectors disabled by default meanwhile.
4. Add an optional dynamic code-proof adapter with symbol, test, runtime and
   mutation evidence; retain `NO_SIGNAL` until proof exists.
5. Improve source capture and review UX: watcher, clipper, OCR/vision, autosave,
   inline comments and conflict handling.
6. Extend failure proof to repeated kill/restart schedules and multinode
   publication/job fencing.
7. Add database RLS, enterprise identity integration, encrypted/off-machine
   backups and external security review before remote multi-tenancy.
8. Install a real OpenTelemetry collector and verify cross-process traces,
   alerts and retention.
9. Decide and document AKP's own software license before any external
   distribution.

## Reproduction commands

Reference clones were created without checkout under an ignored directory:

```powershell
git clone --depth 1 --filter=blob:none --no-checkout --single-branch `
  --branch <default-branch> https://github.com/<owner>/<repo>.git `
  .cache/references/<owner>__<repo>

git -C .cache/references/<owner>__<repo> rev-parse HEAD
git -C .cache/references/<owner>__<repo> ls-tree -r --name-only HEAD
git -C .cache/references/<owner>__<repo> grep -n -E <pattern> HEAD -- <path>
git -C .cache/references/<owner>__<repo> show HEAD:LICENSE
git ls-remote https://github.com/<owner>/<repo>.git `
  refs/tags/<tag> refs/tags/<tag>^{}
```

The exact pinned revisions are in the inventory table. Representative commands
executed successfully against all nine clones; every recursive GitHub tree was
reported as non-truncated before cloning.

AKP evidence can be reproduced with the commands in
[`AGENTS.md`](AGENTS.md). The latest full recorded run is in
[`VALIDATION_REPORT.md`](VALIDATION_REPORT.md). This audit did not rerun the
reference projects, install their dependencies or claim their test suites pass.

## Remaining audit risks

- Reference HEADs can change after this report; links are commit-pinned to keep
  evidence stable.
- Static tree/test inspection cannot establish runtime behavior, performance or
  security.
- Test-path counts are descriptive inventory only.
- Repository licenses permit different forms of reuse and impose different
  obligations. GPL-3.0 and AGPL-3.0 warrant explicit legal review before code
  reuse or network distribution.
- No common corpus or threat harness means five categories correctly remain
  `UNKNOWN_NOT_REPRODUCED`.
- AKP's current offline retrieval benchmark is logic-only synthetic; treating
  it as production-quality evidence would be the largest remaining overclaim.
