# Research adoption and competitive evidence matrix

## Purpose and truth boundary

This report compares the Architecture Knowledge Platform (AKP) with the nine
repositories required by GOAL V2. It is an engineering decision record, not a
marketing scorecard.

- Audit date: **2026-08-26** (`America/Bogota`); reference snapshots remain
  pinned to their recorded commits.
- AKP repository base commit: `2130594b405ba9891da411d3b72ef5f620f5a430`.
- AKP evidence also includes uncommitted working-tree changes. Until those
  changes are committed, the base commit alone cannot reproduce the current
  platform.
- Reference evidence comes from local, read-only clones fixed to the exact
  commits listed below and from links to the corresponding GitHub blobs.
- Reference repositories were inspected, but their complete applications and
  test suites were **not executed** in this audit. A README statement is never
  treated as executed behavior.
- `BETTER_WITH_EVIDENCE` is used only for a narrowly defined mechanism where
  AKP has executed or directly inspectable evidence. It is not an overall
  superiority claim.

The only competitive classifications used are those mandated by GOAL V2:

- `WORSE_THAN_REFERENCE`
- `ROUGHLY_COMPARABLE`
- `BETTER_WITH_EVIDENCE`
- `UNKNOWN_NOT_REPRODUCED`

## AKP evidence baseline

The following observations were reproduced against the current runtime unless
an exception is stated explicitly.

| Evidence                   | Reproduced result                                                                                                                                                                                                                                                              | Local implementation                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic stdio MCP client   | `PASSED`; 21/21 required tools listed; `akp_status` and `akp_search` returned structured results                                                                                                                                                                               | [`scripts/mcp-smoke.ts`](scripts/mcp-smoke.ts), [`apps/mcp/src/server.ts`](apps/mcp/src/server.ts)                                                                              |
| Streamable HTTP MCP        | Implementation binds to `127.0.0.1`, requires a bearer token, and exposes `POST /mcp`; a generic-client handshake was recorded on 2026-07-29, but this transport was not relaunched during this report-only audit                                                              | [`apps/mcp/src/http.ts`](apps/mcp/src/http.ts)                                                                                                                                  |
| Imported corpus            | 557 documents, 6,144 hierarchical units, 4,080 embeddings and 1,192 relations reported by the runtime verifier (run-specific projection counts)                                                                                                                                | [`packages/vault-importer/src/index.ts`](packages/vault-importer/src/index.ts)                                                                                                  |
| Read-only vault import     | Latest run `COMPLETED_WITH_WARNINGS`: 548 Markdown files, 361 operational documents, 187 raw documents, 1,030 wikilinks and 100 unresolved wikilinks                                                                                                                           | [`packages/vault-importer/src/index.ts`](packages/vault-importer/src/index.ts)                                                                                                  |
| Typed graph                | 262 of 1,192 stored relations have a type other than `related_to`; frontmatter mappings include `supports`, `contradicts`, `requires`, `implements`, `validated_by`, `supersedes` and `derives_from`                                                                           | [`packages/vault-importer/src/index.ts`](packages/vault-importer/src/index.ts), [`packages/domain/src/index.ts`](packages/domain/src/index.ts)                                  |
| Retrieval index state      | `DEGRADED` by design because vector retrieval is disabled with `VECTOR_DISABLED_PENDING_BENCHMARK`; exact, lexical and graph revisions match the composite corpus revision                                                                                                     | [`packages/retrieval/src/index.ts`](packages/retrieval/src/index.ts), [`packages/retrieval/src/query-planner.ts`](packages/retrieval/src/query-planner.ts)                      |
| Critical retrieval eval    | Historical run `6ffd70cc-d30e-4714-b74c-7b7f6a49a1a6`: 4/4 vault-fixture cases passed; Recall@10 `1.0`; MRR `0.3875`; nDCG@10 `0.5266485`; citation precision `0.625`; unsupported-answer rate `0`; mean latency `25.42 ms`. The cases are now isolated from the generic pack. | [`vault fixture pack`](evals/fixtures/architecture-knowledge-system/), [`generic pack`](evals/generic/), [`packages/evaluation/src/index.ts`](packages/evaluation/src/index.ts) |
| Governance execution       | Audit ledger contains `knowledge.invalidate`, `knowledge.verify`, `contradiction.create`, `contradiction.resolve`, `review.approve`, `review.reject` and `review.rollback`; one contradiction cluster remains stored as `RESOLVED`                                             | [`apps/api/src/routes/governance.ts`](apps/api/src/routes/governance.ts), [`apps/api/test/security.integration.test.ts`](apps/api/test/security.integration.test.ts)            |
| Review isolation           | Drafts use a separate Git worktree per review and runtime state contains approved, rejected and rolled-back reviews                                                                                                                                                            | [`packages/git-store/src/index.ts`](packages/git-store/src/index.ts), [`packages/git-store/test/isolated-drafts.test.ts`](packages/git-store/test/isolated-drafts.test.ts)      |
| Security boundary coverage | The test source covers invalid credentials, cross-space role projection, path traversal, ingest-root escape, idempotency, recursive invalidation, stale-lease reclaim and source retirement                                                                                    | [`apps/api/test/security.integration.test.ts`](apps/api/test/security.integration.test.ts)                                                                                      |

Important limitations of this baseline:

1. The historical vault-specific gold set had **4 cases**. The current generic
   offline harness has 19 cases/slices and the curated fixture harness has 13
   Level-B cases, but both remain logic-only and are not broad retrieval-quality
   proof.
2. Vector retrieval is intentionally not a default channel; the stored index
   says so explicitly.
3. The current expanded security integration file has more cases than the
   four-case clean-mirror run recorded on 2026-07-29. The 2026-08-26 validation
   run passed the current 30 API integration cases.
4. Two attempts to rerun only the isolated-worktree Vitest on 2026-08-01
   produced no test output and timed out. A prior clean-mirror run passed the
   test, and runtime review records prove exercised flows, but the current
   targeted rerun remains unresolved.

## Pinned primary-source snapshots

| Reference                       | Commit inspected                                                                                                                             | Primary code/evidence inspected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nashsu/llm_wiki`               | [`98786f69684be5e85bc9beb5ada484b6d03edb88`](https://github.com/nashsu/llm_wiki/tree/98786f69684be5e85bc9beb5ada484b6d03edb88)               | [README](https://github.com/nashsu/llm_wiki/blob/98786f69684be5e85bc9beb5ada484b6d03edb88/README.md), [image extraction command](https://github.com/nashsu/llm_wiki/blob/98786f69684be5e85bc9beb5ada484b6d03edb88/src-tauri/src/commands/extract_images.rs), [source-watch configuration tests](https://github.com/nashsu/llm_wiki/blob/98786f69684be5e85bc9beb5ada484b6d03edb88/src/lib/source-watch-config.test.ts), [web clipper](https://github.com/nashsu/llm_wiki/blob/98786f69684be5e85bc9beb5ada484b6d03edb88/extension/clipper-core.js)                                                                      |
| `green-dalii/obsidian-llm-wiki` | [`16ea3b93f1f34408edd8181f3a74a02507c7e7aa`](https://github.com/green-dalii/obsidian-llm-wiki/tree/16ea3b93f1f34408edd8181f3a74a02507c7e7aa) | [PPR evaluation](https://github.com/green-dalii/obsidian-llm-wiki/blob/16ea3b93f1f34408edd8181f3a74a02507c7e7aa/scripts/eval-recall.ts), [PPR cascade tests](https://github.com/green-dalii/obsidian-llm-wiki/blob/16ea3b93f1f34408edd8181f3a74a02507c7e7aa/src/__tests__/core/ppr-cascade.test.ts), [PDF converter tests](https://github.com/green-dalii/obsidian-llm-wiki/blob/16ea3b93f1f34408edd8181f3a74a02507c7e7aa/src/__tests__/core/pdf-converter.test.ts), [plugin entry point](https://github.com/green-dalii/obsidian-llm-wiki/blob/16ea3b93f1f34408edd8181f3a74a02507c7e7aa/src/main.ts)                 |
| `frankchu91/mindbase`           | [`82ec2b5120854d1a44922041978fc258872b54cf`](https://github.com/frankchu91/mindbase/tree/82ec2b5120854d1a44922041978fc258872b54cf)           | [50 MCP registrations](https://github.com/frankchu91/mindbase/blob/82ec2b5120854d1a44922041978fc258872b54cf/apps/mcp/src/tools/index.ts), [bounded compile context tests](https://github.com/frankchu91/mindbase/blob/82ec2b5120854d1a44922041978fc258872b54cf/packages/core/src/compile/context.test.ts), [typed wiki index](https://github.com/frankchu91/mindbase/blob/82ec2b5120854d1a44922041978fc258872b54cf/packages/core/src/graph/index/wiki-index.ts), [contradiction tool](https://github.com/frankchu91/mindbase/blob/82ec2b5120854d1a44922041978fc258872b54cf/apps/mcp/src/tools/find-contradictions.ts) |
| `gowtham0992/link`              | [`f0b1a0194e2ae7c7936b9246e8a191175392fc09`](https://github.com/gowtham0992/link/tree/f0b1a0194e2ae7c7936b9246e8a191175392fc09)              | [benchmark results and caveats](https://github.com/gowtham0992/link/blob/f0b1a0194e2ae7c7936b9246e8a191175392fc09/benchmarks/RESULTS.md), [recall dataset](https://github.com/gowtham0992/link/blob/f0b1a0194e2ae7c7936b9246e8a191175392fc09/scripts/recall_dataset.py), [recall benchmark tests](https://github.com/gowtham0992/link/blob/f0b1a0194e2ae7c7936b9246e8a191175392fc09/tests/test_recall_benchmark.py), [review-gated memory](https://github.com/gowtham0992/link/blob/f0b1a0194e2ae7c7936b9246e8a191175392fc09/mcp_package/link_core/memory.py)                                                         |
| `XBlueSky/cortexes`             | [`e0e23c7117e9ec0963605bc669939d353a3d681c`](https://github.com/XBlueSky/cortexes/tree/e0e23c7117e9ec0963605bc669939d353a3d681c)             | [raw-map implementation](https://github.com/XBlueSky/cortexes/blob/e0e23c7117e9ec0963605bc669939d353a3d681c/cortex-vec/src/cortex_vec/raw_map.py), [distillation plans](https://github.com/XBlueSky/cortexes/blob/e0e23c7117e9ec0963605bc669939d353a3d681c/cortex-vec/src/cortex_vec/distill_plan.py), [evaluation runner](https://github.com/XBlueSky/cortexes/blob/e0e23c7117e9ec0963605bc669939d353a3d681c/cortex-vec/src/cortex_vec/eval/run.py), [raw-map tests](https://github.com/XBlueSky/cortexes/blob/e0e23c7117e9ec0963605bc669939d353a3d681c/cortex-vec/tests/test_raw_map.py)                            |
| `mohammadmaso/kherad`           | [`2a8d6992b87a33760688e1f956653c21a6292294`](https://github.com/mohammadmaso/kherad/tree/2a8d6992b87a33760688e1f956653c21a6292294)           | [product and branch/review model](https://github.com/mohammadmaso/kherad/blob/2a8d6992b87a33760688e1f956653c21a6292294/PRD.md), [merge-request API](https://github.com/mohammadmaso/kherad/blob/2a8d6992b87a33760688e1f956653c21a6292294/apps/api/src/routes/merge-requests.ts), [editor](https://github.com/mohammadmaso/kherad/blob/2a8d6992b87a33760688e1f956653c21a6292294/apps/web/src/components/editor/editor.tsx), [conflict resolver](https://github.com/mohammadmaso/kherad/blob/2a8d6992b87a33760688e1f956653c21a6292294/apps/web/src/components/mr/conflict-resolver.tsx)                                 |
| `masumi-network/Citadel`        | [`fae5d31a8e8ec715fdc17feec3ea39558f571de3`](https://github.com/masumi-network/Citadel/tree/fae5d31a8e8ec715fdc17feec3ea39558f571de3)        | [Node-to-Central policy ADR](https://github.com/masumi-network/Citadel/blob/fae5d31a8e8ec715fdc17feec3ea39558f571de3/docs/adr/0007-seat-capture-promotion-write-policy.md), [promotion engine](https://github.com/masumi-network/Citadel/blob/fae5d31a8e8ec715fdc17feec3ea39558f571de3/kb/promotion.py), [promotion tests](https://github.com/masumi-network/Citadel/blob/fae5d31a8e8ec715fdc17feec3ea39558f571de3/tests/test_promotion.py), [Obsidian sync engine](https://github.com/masumi-network/Citadel/blob/fae5d31a8e8ec715fdc17feec3ea39558f571de3/plugins/obsidian-citadel/src/sync/syncEngine.ts)          |
| `ZeroDot1/LLMWikiNG`            | [`10ef3e4e4163f995603d96104aa0271a67102e35`](https://github.com/ZeroDot1/LLMWikiNG/tree/10ef3e4e4163f995603d96104aa0271a67102e35)            | [40 decorated MCP functions](https://github.com/ZeroDot1/LLMWikiNG/blob/10ef3e4e4163f995603d96104aa0271a67102e35/backend/api/routes/mcp.py), [filesystem watcher](https://github.com/ZeroDot1/LLMWikiNG/blob/10ef3e4e4163f995603d96104aa0271a67102e35/backend/services/watcher.py), [backup/restore service](https://github.com/ZeroDot1/LLMWikiNG/blob/10ef3e4e4163f995603d96104aa0271a67102e35/backend/services/backup.py), [backup tests](https://github.com/ZeroDot1/LLMWikiNG/blob/10ef3e4e4163f995603d96104aa0271a67102e35/tests/test_backup.py)                                                                |
| `OrangeproAI/orangepro-mcp`     | [`ed47af6faf678281160a3654fe87ec632746fceb`](https://github.com/OrangeproAI/orangepro-mcp/tree/ed47af6faf678281160a3654fe87ec632746fceb)     | [local proof operations](https://github.com/OrangeproAI/orangepro-mcp/blob/ed47af6faf678281160a3654fe87ec632746fceb/src/local/operations.ts), [dynamic-proof trust guard](https://github.com/OrangeproAI/orangepro-mcp/blob/ed47af6faf678281160a3654fe87ec632746fceb/tests/local/autoProve.test.ts), [Java proof integration](https://github.com/OrangeproAI/orangepro-mcp/blob/ed47af6faf678281160a3654fe87ec632746fceb/tests/local/javaProveIntegration.test.ts), [local proof documentation](https://github.com/OrangeproAI/orangepro-mcp/blob/ed47af6faf678281160a3654fe87ec632746fceb/docs/local-proof-kit.md)   |

Static counts above are repository observations, not proof that all tools or
tests work. In particular, MindBase registers 50 MCP tool modules and
LLMWikiNG contains 40 `@mcp_server.tool()` decorators at the pinned commits;
neither catalog was handshaken by this audit.

## Capability-by-capability audit

### 1. Multimodal ingest

- **our_capability:** Functional Markdown/text and PDF text extraction;
  image metadata adapter exists, but no executed vision/OCR pipeline was
  demonstrated.
- **our_evidence:** [`apps/extractor/app/extractors/pdf.py`](apps/extractor/app/extractors/pdf.py),
  [`apps/extractor/app/extractors/image.py`](apps/extractor/app/extractors/image.py).
- **reference:** `nashsu/llm_wiki`.
- **reference_evidence:** Tauri desktop, image-extraction command, web clipper,
  PDFium assets and multi-format pathways are present at the pinned commit.
- **assessment:** `WORSE_THAN_REFERENCE`.
- **gap:** No comparable visual-evidence extraction, desktop capture path,
  browser-clip workflow or broad format pipeline has been executed in AKP.
- **implementation:** Keep extraction provider-neutral; add visual locators and
  an explicit `CAPABILITY_NOT_CONFIGURED` state before any vision provider.
- **test_or_benchmark:** Golden PDF with text, table and image; verify page and
  bounding-box provenance and no invented visual description.
- **remaining_risk:** Reference behavior was code-inspected, not run locally.

### 2. Durable jobs

- **our_capability:** Postgres-backed ingest jobs with state, leases,
  heartbeat fields, retry/cancel paths and stale-lease claiming.
- **our_evidence:** [`apps/worker/src/worker.ts`](apps/worker/src/worker.ts),
  [`packages/postgres/src/index.ts`](packages/postgres/src/index.ts).
- **reference:** `nashsu/llm_wiki`, `ZeroDot1/LLMWikiNG`.
- **reference_evidence:** Both contain background/watch workflows, but this
  audit did not reproduce their durability or failure semantics.
- **assessment:** `UNKNOWN_NOT_REPRODUCED`.
- **gap:** There is no equivalent cross-project crash/retry experiment.
- **implementation:** Retain leases and idempotent content-addressed writes;
  add long-stage heartbeat renewal if final recovery tests expose expiry risk.
- **test_or_benchmark:** Kill a worker in each state, wait past lease expiry,
  restart, and assert exactly one terminal result.
- **remaining_risk:** Watchers are not necessarily durable queues, so a direct
  ranking would be misleading.

### 3. Crash recovery

- **our_capability:** Expired job leases can be reclaimed; Git publication has
  compensation/rollback paths; backup/restore scripts exist.
- **our_evidence:** [`apps/api/test/security.integration.test.ts`](apps/api/test/security.integration.test.ts),
  [`packages/git-store/src/index.ts`](packages/git-store/src/index.ts),
  [`scripts/restore-smoke.ps1`](scripts/restore-smoke.ps1).
- **reference:** `mohammadmaso/kherad`, `masumi-network/Citadel`.
- **reference_evidence:** Kherad contains autosaved drafts; Citadel contains
  scheduled jobs and retry-oriented tests. Neither was subjected to the same
  process-kill protocol here.
- **assessment:** `UNKNOWN_NOT_REPRODUCED`.
- **gap:** No common failure-injection harness exists.
- **implementation:** Define a portable restart scenario and persist its event
  trace in CI artifacts.
- **test_or_benchmark:** Interrupted extraction, embedding, Git publication and
  object-store outage with post-restart invariant checks.
- **remaining_risk:** Database and Git publication remain compensating, not a
  single atomic transaction.

### 4. Compiled knowledge

- **our_capability:** Immutable raw source -> structured compilation plan ->
  reviewed Markdown -> Git merge -> incremental index update.
- **our_evidence:** [`packages/compiler/src/index.ts`](packages/compiler/src/index.ts),
  [`apps/api/src/routes/reviews.ts`](apps/api/src/routes/reviews.ts).
- **reference:** `nashsu/llm_wiki`, `green-dalii/obsidian-llm-wiki`,
  `frankchu91/mindbase`.
- **reference_evidence:** All three inspectably maintain persistent Markdown
  knowledge rather than answering only from ephemeral RAG.
- **assessment:** `ROUGHLY_COMPARABLE`.
- **gap:** AKP has stronger explicit review/provenance boundaries but much less
  mature capture and editorial experience; reference quality was not run.
- **implementation:** Preserve the compiler/reviewer separation and improve the
  source-to-draft human workflow.
- **test_or_benchmark:** Same source set, blind curator scoring of factual
  retention, provenance and editorial effort.
- **remaining_risk:** Compilation quality currently has only a small critical
  probe set.

### 5. Lexical retrieval

- **our_capability:** Exact/alias plus PostgreSQL lexical retrieval, selected as
  the default after the local benchmark.
- **our_evidence:** [`packages/retrieval/src/index.ts`](packages/retrieval/src/index.ts),
  eval run `6ffd70cc-d30e-4714-b74c-7b7f6a49a1a6`.
- **reference:** `gowtham0992/link`.
- **reference_evidence:** Link publishes a deterministic 1,176-case benchmark,
  plus a 1,536-query LoCoMo retrieval track and explicit ablations/caveats.
- **assessment:** `WORSE_THAN_REFERENCE`.
- **gap:** AKP's four cases cannot establish robustness by topic, language,
  paraphrase or no-answer slice.
- **implementation:** Expand curator-reviewed queries and add held-out cases.
- **test_or_benchmark:** At minimum the GOAL V2 slices, reported separately,
  with confidence intervals where appropriate.
- **remaining_risk:** Link's memory corpus differs from AKP's architecture
  corpus, so absolute scores must not be compared directly.

### 6. Vector retrieval

- **our_capability:** pgvector adapter and deterministic local embeddings are
  implemented, but vector retrieval is feature-flagged off.
- **our_evidence:** 2,071 units have derived embeddings; index warning is
  `VECTOR_DISABLED_PENDING_BENCHMARK`.
- **reference:** `gowtham0992/link`, `XBlueSky/cortexes`.
- **reference_evidence:** Link records multiple local embedding/reranking
  ablations; Cortexes contains vector adapters and an evaluation runner.
- **assessment:** `WORSE_THAN_REFERENCE`.
- **gap:** No sufficiently broad AKP dataset proves that vectors improve
  cross-language/paraphrase recall without grounding regressions.
- **implementation:** Keep vector disabled until the expanded benchmark passes
  exact-ID, citation, latency and offline gates.
- **test_or_benchmark:** Full matrix with vectors on/off and a no-embedding
  fallback run.
- **remaining_risk:** Deterministic hash embeddings exercise plumbing, not
  semantic quality.

### 7. Graph retrieval

- **our_capability:** Typed relation ingestion and bounded graph retrieval exist.
- **our_evidence:** 262 typed relations; [`packages/graph/src/index.ts`](packages/graph/src/index.ts).
- **reference:** `green-dalii/obsidian-llm-wiki`, `masumi-network/Citadel`.
- **reference_evidence:** The Obsidian plugin contains PPR ranking and a dedicated
  evaluation script; Citadel contains a knowledge mesh and promotion/sync graph.
- **assessment:** `WORSE_THAN_REFERENCE`.
- **gap:** AKP graph-inclusive benchmark configurations raised unsupported
  answers to `0.5` in the four-case smoke set, so graph boost is not default.
- **implementation:** Improve relation authority/weighting before adding any
  PPR-like expansion; import relation types without equating all wikilinks.
- **test_or_benchmark:** Adversarial cycles, weak-link hubs, provenance paths
  and graph-only ablation.
- **remaining_risk:** Reference graph ranking was inspected, not reproduced.

### 8. Context packaging

- **our_capability:** Bounded `ContextPacket` with corpus/index revisions,
  channel reasons, token budget, citations, conflicts, gaps, continuation and a
  deterministic packet hash.
- **our_evidence:** [`packages/retrieval/src/context-packet.ts`](packages/retrieval/src/context-packet.ts),
  [`packages/retrieval/test/context-packet.test.ts`](packages/retrieval/test/context-packet.test.ts).
- **reference:** `frankchu91/mindbase`.
- **reference_evidence:** MindBase has bounded compile-context tests, but no
  inspected equivalent carrying all of AKP's revision, provenance, conflict and
  continuation fields as one agent contract.
- **assessment:** `BETTER_WITH_EVIDENCE`.
- **gap:** This is a narrow contract comparison, not evidence that AKP answers
  are globally better.
- **implementation:** Preserve the packet as the agent boundary and benchmark
  packet utility/grounding, not only retrieval rank.
- **test_or_benchmark:** Token-budget property tests, continuation replay,
  index-mismatch degradation and citation entailment.
- **remaining_risk:** Current smoke client exercises search, not every packet
  profile through an independent MCP client.

### 9. MCP interoperability

- **our_capability:** 21 tools over stdio; Streamable HTTP implementation with
  bearer authentication.
- **our_evidence:** Current stdio generic-client smoke passed 21/21; HTTP code is
  in [`apps/mcp/src/http.ts`](apps/mcp/src/http.ts).
- **reference:** `frankchu91/mindbase`, `ZeroDot1/LLMWikiNG`.
- **reference_evidence:** Pinned code statically registers 50 MindBase tool
  modules and 40 LLMWikiNG decorated functions.
- **assessment:** `UNKNOWN_NOT_REPRODUCED`.
- **gap:** Tool breadth is lower, while comparable protocol behavior and error
  semantics were not executed against the references.
- **implementation:** Add contract tests for every write idempotency rule and
  keep tools thin over shared application use cases.
- **test_or_benchmark:** One generic client per transport; schema validation,
  auth denial, bounded outputs and continuation.
- **remaining_risk:** A tool count is not a quality metric; AKP HTTP MCP still
  needs the final clean-environment handshake.

### 10. Review workflow

- **our_capability:** Proposal, draft validation, submit, approve/reject,
  isolated worktree merge, optimistic base check and rollback.
- **our_evidence:** Runtime includes approved, rejected and rolled-back reviews;
  implementation and regression test are linked in the baseline.
- **reference:** `mohammadmaso/kherad`.
- **reference_evidence:** Kherad has merge-request API/UI, block editor,
  autosave, diff/review and conflict-resolution components.
- **assessment:** `ROUGHLY_COMPARABLE`.
- **gap:** Backend lifecycle is comparable in shape; AKP is clearly behind in
  autosave, comments, rendered diffs, reviewer ergonomics and conflicts.
- **implementation:** Adopt Kherad's user-centered review concepts while
  retaining one isolated worktree per review.
- **test_or_benchmark:** Two concurrent drafts from the same base, reject one,
  merge one, create a conflicting third, resolve, then rollback.
- **remaining_risk:** The current isolated-worktree targeted rerun timed out;
  this must be resolved before final release evidence.

### 11. RBAC

- **our_capability:** Organization/space membership, role and path-prefix scope
  are enforced server-side across core routes.
- **our_evidence:** [`apps/api/src/auth.ts`](apps/api/src/auth.ts),
  [`apps/api/test/security.integration.test.ts`](apps/api/test/security.integration.test.ts).
- **reference:** `mohammadmaso/kherad`, `masumi-network/Citadel`.
- **reference_evidence:** Kherad has bundle/folder roles; Citadel separates seat
  Nodes and Central authority. Their complete enforcement was not reproduced.
- **assessment:** `UNKNOWN_NOT_REPRODUCED`.
- **gap:** No common policy matrix or cross-implementation leakage test exists.
- **implementation:** Finish web sessions and execute the same permission matrix
  via API, web and MCP.
- **test_or_benchmark:** Cross-space reads/writes, path-prefix edge cases,
  private-to-central promotion and token scope revocation.
- **remaining_risk:** Current MCP bearer token is service-oriented; full human
  session lifecycle remains incomplete.

### 12. Staleness and invalidation

- **our_capability:** Explicit dependency traversal, recursive stale states,
  source retirement impact, verification and audit events.
- **our_evidence:** Executed audit actions include invalidation and verification;
  [`apps/api/src/routes/governance.ts`](apps/api/src/routes/governance.ts).
- **reference:** `frankchu91/mindbase`, `gowtham0992/link`.
- **reference_evidence:** MindBase surfaces stale notes; Link supports review
  dates, expiry and supersession. No inspected reference mechanism matched the
  explicit source -> dependent recursive invalidation lifecycle.
- **assessment:** `BETTER_WITH_EVIDENCE`.
- **gap:** The advantage is limited to explicit dependency invalidation; it does
  not prove superior freshness judgment or UI.
- **implementation:** Add scheduled lint execution and impacted-eval automation.
- **test_or_benchmark:** Retire/update a source, assert warning/exclusion of all
  dependents, refresh, review and reactivate.
- **remaining_risk:** Typed dependency completeness determines propagation
  completeness.

### 13. Contradiction handling

- **our_capability:** Persistent contradiction clusters with documents,
  authority/scope, resolution, reviewer, lifecycle changes, packet surfacing and
  audit records.
- **our_evidence:** Three create and three resolve events exist; one cluster is
  persisted as `RESOLVED`; routes and integration scenario are linked above.
- **reference:** `green-dalii/obsidian-llm-wiki`, `frankchu91/mindbase`,
  `gowtham0992/link`.
- **reference_evidence:** The references contain contradicted markers, an
  LLM-judged contradiction cache/tool, or deterministic supersession/review.
  The inspected artifacts do not expose the same explicit cluster lifecycle.
- **assessment:** `BETTER_WITH_EVIDENCE`.
- **gap:** Better lifecycle traceability does not imply better automatic
  contradiction detection.
- **implementation:** Keep detection and adjudication separate; require human
  resolution for normative disputes.
- **test_or_benchmark:** Known contradiction, false positive, scoped exception,
  unresolved packet warning and resolution regression.
- **remaining_risk:** Automatic semantic detection remains weak and should not
  silently create truth.

### 14. Code evidence

- **our_capability:** Repository inventory/locator adapter with evidence tiers;
  heuristic signals are deliberately classified `NO_SIGNAL` rather than proof.
- **our_evidence:** [`packages/project-adapter/src/index.ts`](packages/project-adapter/src/index.ts),
  [`packages/project-adapter/test`](packages/project-adapter/test).
- **reference:** `OrangeproAI/orangepro-mcp`.
- **reference_evidence:** OrangePro contains mutation-kill proof operations,
  trust guards and language-specific integration fixtures.
- **assessment:** `WORSE_THAN_REFERENCE`.
- **gap:** AKP cannot produce `DYNAMICALLY_PROVEN` code behavior.
- **implementation:** Integrate an optional proof adapter with immutable
  repository/commit/path/line locators; never promote regex matches.
- **test_or_benchmark:** Passing baseline + targeted mutant kill + unmocked
  execution, including survived/equivalent-mutant negatives.
- **remaining_risk:** OrangePro's full suite was not run here, but the AKP
  capability is demonstrably absent.

### 15. Evaluation

- **our_capability:** Retrieval configuration matrix, critical gates and stored
  metrics exist.
- **our_evidence:** 4-case run and stored benchmark runs in `eval_runs`.
- **reference:** `gowtham0992/link`, `XBlueSky/cortexes`.
- **reference_evidence:** Link provides much larger deterministic and LoCoMo
  tracks with ablations; Cortexes provides adapter-based corpus evaluation.
- **assessment:** `WORSE_THAN_REFERENCE`.
- **gap:** AKP lacks scale, held-out cases, complete requested slices and a
  packet-quality benchmark.
- **implementation:** Expand gold data before optimizing retrieval algorithms.
- **test_or_benchmark:** Retrieval and packet CLI benchmarks with baseline vs
  candidate comparison and no-answer cases.
- **remaining_risk:** Current perfect Recall@10 is expected to be unstable on a
  four-case dataset.

### 16. Security

- **our_capability:** Loopback defaults, token auth, path normalization,
  ingest-root allowlist, cross-space checks, secret scan and default-token
  revocation are implemented.
- **our_evidence:** [`apps/api/src/auth.ts`](apps/api/src/auth.ts),
  [`scripts/scan-secrets.mjs`](scripts/scan-secrets.mjs), migration
  [`006_revoke_bootstrap_credential.sql`](db/migrations/006_revoke_bootstrap_credential.sql).
- **reference:** `mohammadmaso/kherad`, `masumi-network/Citadel`,
  `ZeroDot1/LLMWikiNG`.
- **reference_evidence:** All have security-related code/tests or policy, but no
  common adversarial suite was executed. LLMWikiNG's pinned tree also contains
  a credential-shaped value in `.agents/mcp_config.json`; its validity is
  unknown and is not reproduced here.
- **assessment:** `UNKNOWN_NOT_REPRODUCED`.
- **gap:** Web session security, rate-limit behavior and malicious Markdown/HTML
  rendering still need final E2E proof.
- **implementation:** Run a shared attack corpus and rotate/remove every
  credential-shaped fixture from tracked files.
- **test_or_benchmark:** SSRF, traversal, XSS, prompt injection, secret leakage,
  token scope and cross-space leakage.
- **remaining_risk:** Static presence of security code is not enforcement proof.

### 17. Backup and restore

- **our_capability:** Backup includes Postgres, object storage, configuration
  metadata and a Git bundle; an isolated restore smoke script exists.
- **our_evidence:** [`scripts/backup.ps1`](scripts/backup.ps1),
  [`scripts/restore-smoke.ps1`](scripts/restore-smoke.ps1).
- **reference:** `ZeroDot1/LLMWikiNG`, `masumi-network/Citadel`.
- **reference_evidence:** LLMWikiNG has archive create/restore code and tests;
  Citadel has mirror scripts/tests.
- **assessment:** `UNKNOWN_NOT_REPRODUCED`.
- **gap:** No shared dataset and post-restore checksum protocol was executed
  across projects.
- **implementation:** Preserve AKP's multi-store backup and verify logical
  invariants, not just archive extraction.
- **test_or_benchmark:** Restore into isolated database, object volume and Git
  clone; rebuild indexes; compare source/document/hash counts.
- **remaining_risk:** Final backup smoke must be rerun against the current
  managed repository revision.

### 18. Observability

- **our_capability:** Structured logs, trace IDs, health/status and audit events
  exist; full OpenTelemetry export has not been demonstrated.
- **our_evidence:** [`packages/observability/src/index.ts`](packages/observability/src/index.ts),
  [`apps/api/src/server.ts`](apps/api/src/server.ts).
- **reference:** `masumi-network/Citadel`, `ZeroDot1/LLMWikiNG`.
- **reference_evidence:** Both expose operational/admin surfaces and extensive
  logs/tests, but no equivalent telemetry scenario was reproduced.
- **assessment:** `UNKNOWN_NOT_REPRODUCED`.
- **gap:** No comparative trace completeness, alerting or stuck-job detection
  benchmark.
- **implementation:** Emit stable trace/span attributes across API, worker,
  extractor, object storage and Git publication.
- **test_or_benchmark:** One ingest/review/search trace plus forced failure and
  operator diagnosis time.
- **remaining_risk:** Health endpoints can be green while an end-to-end flow is
  impaired.

### 19. Human UX

- **our_capability:** Functional but basic Next.js routes for search, source,
  ingest, jobs, reviews, documents, graph, evals and administration; Obsidian
  remains a companion client.
- **our_evidence:** [`apps/web/app`](apps/web/app).
- **reference:** `nashsu/llm_wiki`, `green-dalii/obsidian-llm-wiki`,
  `mohammadmaso/kherad`.
- **reference_evidence:** The references contain a packaged desktop experience,
  a native Obsidian plugin, or a richer editor/review/conflict UI.
- **assessment:** `WORSE_THAN_REFERENCE`.
- **gap:** No polished editor, source watcher, clipper integration, comments,
  autosave, conflict UX or index-health visualization comparable to those
  inspected surfaces.
- **implementation:** Prioritize review/provenance/search explanation UX before
  adding decorative dashboards.
- **test_or_benchmark:** Task-based usability study: ingest, find evidence,
  review conflict and rollback.
- **remaining_risk:** Reference screenshots/code do not prove usability, but the
  missing AKP surfaces are concrete.

### 20. Agent UX

- **our_capability:** Agents receive bounded structured results through 21 MCP
  tools and shared API use cases.
- **our_evidence:** Current generic-client smoke passed all 18 registrations.
- **reference:** `frankchu91/mindbase`, `ZeroDot1/LLMWikiNG`.
- **reference_evidence:** Their pinned trees expose broader static tool catalogs,
  plus agent commands/plugins or admin operations.
- **assessment:** `WORSE_THAN_REFERENCE`.
- **gap:** AKP lacks comparable distribution/onboarding surfaces and some write
  operations do not yet expose explicit idempotency keys.
- **implementation:** Improve discoverability, tool examples, write
  idempotency and packaged client configuration without duplicating business
  logic in skills.
- **test_or_benchmark:** First-task success from a clean generic MCP client,
  bounded-output checks and retry-safe writes.
- **remaining_risk:** More tools can also increase selection error; breadth
  should be adopted only when evaluation supports it.

## Repository-level adoption decisions

| Reference                       | What AKP should adopt or adapt                                                                                 | What AKP should reject or defer                                                                                | Competitive finding                                                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `nashsu/llm_wiki`               | Adapt source-folder watching, clip ingestion, multi-format routing and visual evidence with immutable locators | Do not couple canonical knowledge or retrieval to a desktop runtime                                            | `WORSE_THAN_REFERENCE` for multimodal capture and packaged human UX                                                                     |
| `green-dalii/obsidian-llm-wiki` | Adapt Obsidian-native ergonomics and evaluate PPR as an optional graph ranker                                  | Do not enable PPR/graph boost before AKP's grounding benchmark passes                                          | `WORSE_THAN_REFERENCE` for Obsidian integration and evaluated graph-ranking depth                                                       |
| `frankchu91/mindbase`           | Adopt useful task-oriented MCP concepts and contradiction/gap discovery; retain bounded context                | Reject tool count as a proxy for quality and avoid agent-only business logic                                   | `BETTER_WITH_EVIDENCE` only for revision/provenance-bearing `ContextPacket`; `WORSE_THAN_REFERENCE` in static tool/distribution breadth |
| `gowtham0992/link`              | Adopt benchmark scale, ablations, negative results, development-set caveats and memory-hygiene thinking        | Do not compare its memory scores directly with AKP's architecture corpus                                       | `WORSE_THAN_REFERENCE` in retrieval-evaluation maturity                                                                                 |
| `XBlueSky/cortexes`             | Adapt raw-map, bounded spans, resumable distillation plans and adapter evaluation                              | Never accept auto-proposed gold labels without curator review                                                  | `WORSE_THAN_REFERENCE` in long-source navigation/distillation and vector-eval tooling                                                   |
| `mohammadmaso/kherad`           | Adopt autosave, comments, rendered/raw diff, preview and conflict resolution                                   | Do not replace per-review isolation with an implicit shared working tree                                       | `ROUGHLY_COMPARABLE` backend review shape; `WORSE_THAN_REFERENCE` editorial UX                                                          |
| `masumi-network/Citadel`        | Adapt private Node/team Central separation into explicit space/promotion policy with audit                     | Do not auto-promote private knowledge merely because a classifier says it is relevant                          | `WORSE_THAN_REFERENCE` in implemented promotion/sync breadth                                                                            |
| `ZeroDot1/LLMWikiNG`            | Adapt watcher, admin and backup visibility; study its broader MCP operations                                   | Do not copy credential-shaped tracked examples or restore-overwrite behavior without stronger isolation checks | `WORSE_THAN_REFERENCE` in watcher/admin/tool breadth; runtime quality remains `UNKNOWN_NOT_REPRODUCED`                                  |
| `OrangeproAI/orangepro-mcp`     | Add an optional dynamic-proof adapter and preserve its separation of static signal from mutation-backed proof  | Never relabel regex/test proximity as runtime proof                                                            | `WORSE_THAN_REFERENCE` in dynamic code evidence                                                                                         |

## Quantified conclusion

Across the 20 required capability categories in this audit:

- 8 are `WORSE_THAN_REFERENCE`;
- 2 are `ROUGHLY_COMPARABLE`;
- 3 are narrowly `BETTER_WITH_EVIDENCE`;
- 7 are `UNKNOWN_NOT_REPRODUCED`.

The three favorable findings are deliberately narrow: bounded
revision/provenance-aware context packaging, recursive dependency invalidation,
and explicit contradiction-cluster lifecycle. They do not outweigh the
material gaps in multimodal capture, vector/graph evaluation, code proof,
human UX, agent distribution and benchmark scale.

## Prioritized implementation consequences

1. **Expand evaluation before changing the default retriever.** Grow beyond
   four cases, add every GOAL V2 slice, create held-out cases and preserve
   failed ablations.
2. **Close proof gaps before feature breadth.** Finish/reproduce recovery,
   security, HTTP MCP and backup/restore gates in a clean environment.
3. **Improve source and editorial UX.** Add watcher/capture, richer provenance
   inspection, autosave/comments/conflict handling and an Obsidian-facing thin
   client only after API contracts stabilize.
4. **Introduce dynamic code evidence as an optional adapter.** Preserve
   `NO_SIGNAL` until a real runtime/mutation oracle proves behavior.
5. **Adopt bounded raw-source distillation.** Add raw-map/span continuations and
   resumable plans without creating a second canonical corpus.
6. **Keep vector and graph boosts gated.** Current evidence justifies exact +
   lexical as the default; it does not justify semantic or graph promotion.

## Reproduction notes

Reference snapshots were checked with commands equivalent to:

```powershell
git -C <reference-clone> rev-parse HEAD
git -C <reference-clone> ls-tree -r --name-only HEAD
git -C <reference-clone> grep -n <pattern> HEAD -- <paths>
git -C <reference-clone> show HEAD:<path>
```

Current AKP runtime evidence was checked with:

```powershell
$env:AKP_API_URL='http://127.0.0.1:18080'
$env:AKP_API_TOKEN='<integration-test-token>'
pnpm exec tsx scripts/mcp-smoke.ts

docker compose exec -T postgres psql -U akp -d akp -Atc `
  "select status,revision,metrics::text,completed_at
     from vault_import_runs order by completed_at desc nulls last limit 1;"

docker compose exec -T postgres psql -U akp -d akp -Atc `
  "select id,status,metrics::text,created_at
     from eval_runs order by created_at desc;"

docker compose exec -T postgres psql -U akp -d akp -Atc `
  "select action,count(*) from audit_events group by action order by action;"
```

The integration token value is intentionally omitted. Regenerate this report
after the AKP working tree is committed and the final clean-room validation has
completed; classifications that depend on unexecuted reference behavior must
remain `UNKNOWN_NOT_REPRODUCED` until a common harness is actually run.
