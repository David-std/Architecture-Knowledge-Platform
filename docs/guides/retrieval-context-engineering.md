# Retrieval and Context Engineering Guide

## What this feature is

AKP retrieval combines bounded exact, lexical, optional vector, graph, code, community/PPR and reasoning-assisted channels into source-backed search results and `ContextPacket` outputs.

The system separates candidate generation, policy filtering, ranking/fusion and context assembly. Citations, revision metadata, gaps, conflicts and degradation warnings travel with the result so callers can distinguish evidence from ranking signals.

## Correctness before ranking

```text
principal + authorized scopes
            │
            ▼
temporal / profile / revision constraints
            │
            ▼
query shape + intent
            │
            ▼
permitted candidate channels
            │
            ▼
exact · lexical · vector · code · graph · temporal · raw
            │
            ▼
support / truth / freshness validation
            │
            ▼
fusion → optional rerank → dedupe/diversity/conflict coverage
            │
            ▼
bounded Evidence-aware ContextPacket
            │
            ▼
final revision-set verification
```

Similarity and ranking answer relevance questions; they do not override authorization, lifecycle, temporal validity or support.

## Structured ingestion and atomic identity

The Markdown parser retains document and multi-block section containers for
parent context. Single-block sections do not need a second copy of the same
body. Long prose, list and code blocks have bounded structural fragments;
their source remains available through the parent unit. A character budget
does not establish compliance with a model's token window: measure the actual
tokenizer input, including any title/heading prefix, before claiming complete
vector coverage.

Markdown tables produce a table parent, source rows and source cells with
one-based table/row/column coordinates. Nonempty rows own retrieval; cells
retain source identity and are not separately embedded. Headers travel as
heading context. Portable artifact page, slide, sheet and table coordinates
are inherited from extraction provenance. A row or header is ranking context,
and cannot donate answer bytes from another selected cell. Unparsed tables
retain their original fallback representation.

Available table and figure captions are source material too. Artifact rendering
preserves each caption in reading order with the item's inherited page or table
locator. A no-grid table keeps its existing text fallback, and a distinct
caption is retained beside that text; equal caption and text are emitted once.
When a caption is rendered as its own unit, it remains bound to that unit's
provenance and cannot authorize an answer from another row, cell or neighboring
unit. Citation spans use exact UTF-16 offsets in the bound Markdown source
frame. Fidelity to the original binary is measured separately.

Fusion preserves each document/unit pair as a separate identity. Document-only
signals attach to a leaf only when the observed leaf channels agree on exactly
one unit; otherwise they remain document-scoped. Reranking uses that same atomic
identity. Retrieving the right document therefore does not substitute for
retrieving the unit containing the answer.

## When to use it

Use `/v1/search` for ranked evidence/document lookup. Use `/v1/context` or the agent façade when a task needs a bounded packet that combines evidence, policy context, conflicts, required actions and continuation handles.

Use temporal, code or impact-specific actions when the question has those semantics rather than relying on a broad conceptual query.

## Configuration

Search requests define query/intent, authorized space/vault scope, minimum trust, mode, limit and optional channel requirements.

`AKP_VECTOR_ENABLED` controls optional vector retrieval. Embedding generations are versioned; a query uses the compatible active generation or degrades explicitly.

`AKP_EMBEDDING_PASSAGE_CONTEXT=body-v1` preserves the original embedding input.
The explicit experimental option `title-heading-v1` prepends the document title
(first 160 Unicode code points) and nearest heading context (last 320 code points)
to each complete passage. It creates a different generation descriptor and
configuration hash; query model, role and prefix stay unchanged. Managed indexing
and read-only vault import use the same recipe. Vector rows retain the canonical
body hash and a separate SHA-256 of the exact prepared input. Metadata changes
invalidate contextual cache reuse and stale contextual vectors cannot appear in
search. No source or approved Markdown is rewritten to add this context.

Run `pnpm benchmark:embedding-context` to compare both recipes with fresh E5
inference on the synthetic domain-disjoint pack. The option remains off by default;
use normal projection regeneration to build it and benchmark before activation.
The provider token limit still applies: this recipe does not repair overlong chunks.
Metadata improves retrieval scope, not answer authority. This experiment does not
establish general source/span precision or precision for unseen question families.

Graph traversal is bounded by hops, fanout, candidates and time. Community/PPR policies bound nodes, iterations, allowed domains/relations, score threshold and per-scope caps. DRIFT uses exact/lexical/vector seeds to orient the active community index, excludes those seed documents from the community expansion, and contributes only the additional truth-valid members through normal fusion. GLOBAL community routing remains a separate corpus-wide mode.

The registered retrieval arena measures DRIFT as its own feature-on configuration alongside GLOBAL community routing and PPR. Those results are comparative evidence only; they do not select a production default, and community summaries remain non-citable derived indexes.

Vector access-path selection is also evidence-gated. AKP has dimension-specific HNSW indexes and a filtered ANN fixture that measures exact-vs-HNSW recall, latency and leakage under vault/path predicates, but the registered real product corpus is still too small to select a production index policy. Production queries therefore provide the authorized/truth-valid filters plus `ORDER BY <=> LIMIT` and leave the physical access path to the PostgreSQL planner. AKP does not label that path `EXACT_SCAN`, `HNSW` or `IVFFlat` unless an observed plan and a representative benchmark justify doing so.

Context packets enforce token/budget constraints and support compact/full modes plus continuation rather than unbounded vault loading.

## Normal workflow

1. Resolve the caller's authorized vault/path scope.
2. Plan the query from intent and available capabilities.
3. Run enabled candidate channels independently.
4. Filter by lifecycle, trust, authorization, freshness and temporal support.
5. Fuse/rerank bounded candidates.
6. Assemble a context packet with citations, conflicts, gaps, actions and revision metadata.
7. Revalidate captured truth/context revision when strict consistency requires it.

Query transformations and reasoning plans may improve retrieval, but their output is validated before execution and cannot introduce arbitrary SQL/Cypher operators.

### Stage diagnostics and evaluation boundaries

`queryKnowledge` exposes an optional application diagnostic sink after scope,
trust and truth filtering. It records the authorized channel units, the full
fused pool, the bounded pool before/after reranking and the returned unit
identities. The context assembler exposes a separate selection sink identifying
token-budget omissions, per-document section limits and missing evidence.
These sinks contain identities, ranks, scores, generation and policy metadata;
they exclude queries, titles, paths, passages and citation text. They are
out-of-band and do not change support policy or packet budgets.

`diagnoseEvidencePipeline` compares those observations with explicit gold
document/unit/span labels. It distinguishes missing source bytes, missing units,
channel/fusion losses, shortlist and rerank losses, admission errors, invalid
spans, context omissions and observed generation failures. A sibling unit cannot
stand in for a gold unit. Missing observations remain unmeasured; incomplete
labels cannot produce admitted-unit precision. An absent or unannotated gold
span cannot produce an exact citation precision claim.

The generalization admission report includes per-unit loss attribution and a
breakdown by failure stage. Its candidates are supplied, so ingestion, retrieval,
ContextPacket and generation remain explicitly unmeasured. The runtime and
registered public matrices capture actual channel/fusion/rerank snapshots, but
their main matrices still seed one unit per source document and lack exhaustive
exact span labels. The registered report additionally rebuilds parsed atomic
units for separate fusion-identity and frozen-pool BGE studies. Their small
product-document slice cannot establish arbitrary-vault retrieval quality,
fresh private E2E, an untouched family-disjoint holdout or 20K/100K distractor
quality. Candidate-depth and assertion-recall measurements remain separate
variables; they do not increase production context budgets.

`pnpm audit:retrieval-unitization` inspects a specified space/vault's current
projection and reports aggregate unit types, table coordinates, character
budgets and generation parity. It requires `DATABASE_URL`, `AKP_AUDIT_SPACE_ID`
and `AKP_AUDIT_VAULT_ID`; `AKP_RETRIEVAL_UNITIZATION_REPORT` optionally saves the
aggregate report. It does not measure exact tokenizer lengths, extraction
fidelity, query recall or source-span precision. Source-to-document fidelity
must be checked separately: an indexed revision cannot prove that every input
file or every distinct source body survived ingestion.

## Evidence admission boundaries and insufficiency

Evidence admission is intentionally separate from relevance ranking. The target architecture has three bounded responsibilities:

1. `StructuralEvidenceGuard` owns hard invariants that a semantic model must not override: authorization, truth/lifecycle state, visible-source span integrity, hidden-comment exclusion, selected table-cell scope, explicitly requested year/number/unit constraints, exact identifier identity, and rejection of question-only or otherwise non-assertive source text.
2. `StructuredPropositionMatcher` owns typed claim/rule/decision matching when a canonical proposition projection exists.
3. `SemanticEvidenceReader` owns ordinary prose and ambiguous semantic support. `ANSWERS` and `CONTRADICTS` require an exact visible source span (or the selected table cells); malformed output, timeout or an unmappable quote fails closed.

These boundaries do not make a relevance score evidence authority. The cross-encoder and other rerankers may order or shortlist candidates, but only admission can return a unit as supported evidence.

The current integrated deterministic path still retains legacy prose authority through `PASSAGE_TEXT_SUPPORT` and `PASSAGE_CUE_SUPPORT`. Their removal has **not** earned promotion: structural-only removal collapses ordinary-prose recall, and the tested source-bound semantic replacements have not yet preserved the required precision/coverage frontier. Keep those legacy reasons until a separately frozen replacement experiment passes development and a fresh family-disjoint holdout. Do not add query- or corpus-specific cue dictionaries to work around an experiment failure.

The source-bound reader contract is available only when explicitly configured. Optional semantic verifier/reranker providers remain disabled by default and must fail safely; a provider error cannot silently enable a different authority path.

### Bounded missing-slot follow-up

AKP also contains a reusable **shadow-only** requested-answer follow-up primitive. It is not a production retrieval-quality default or route behavior.

When the governed answerability result is unsupported, the helper may perform at most one retrieval-only follow-up if the original query has a safe bounded `RequestedAnswerSlot` projection. The follow-up query is built only from the projected relation anchor and bound argument anchors. The slot projection itself never grants support.

After that retrieval, AKP reassesses the returned candidates against the **original user query**, through the normal authorization/truth/admission path. There is no recursive second follow-up. Unsupported why/how/when or free-form prose queries that cannot be projected safely do not trigger this helper. If the bounded second pass still lacks support, the orchestration result is `INSUFFICIENT_KNOWLEDGE`.

The frozen shadow contract achieved perfect contract accuracy, but the later normal-pipeline public experiment produced no correct recoveries and was rejected for no measured advantage. Therefore the helper remains a safe orchestration primitive only: it is not wired as a production route-level recovery policy and must not be presented as a demonstrated retrieval-quality improvement.

## Contextual evidence verifier

Admission decides whether a retrieved unit answers the query, so it can be returned as `SUPPORTED` evidence rather than an exploratory candidate. The current deterministic path still contains semantic cue logic as well as structural guards. The supplied-candidate pack in `evals/generic/evidence-admission` measures admission precision and coverage separately from retrieval; it has source/domain-disjoint splits with overlapping question families. Its results cannot establish a reader default for unseen families.

The contextual cross-encoder scores each unit under its title and heading path,
with link targets removed and table rows restated with their headers. The pinned
multilingual BGE model records an experimental relevance judgment. That score
cannot establish whether the requested relation, value or period is supported,
and cannot admit evidence in the API. The separate registered reranking study
compares the same frozen authorized hybrid pools before and after BGE ordering;
it records gold loss, ranking quality and scoring cost without enabling a
production reranker default.

Enable it explicitly:

```dotenv
AKP_EVIDENCE_VERIFIER_PROVIDER=contextual-cross-encoder
AKP_EVIDENCE_VERIFIER_MODE=SHADOW
# Optional experimental diagnostic threshold; default 0.2.
AKP_EVIDENCE_VERIFIER_MIN_SCORE=0.2
AKP_EVIDENCE_VERIFIER_MAX_CANDIDATES=32
```

`SHADOW` records the verifier decision beside the deterministic one without changing results. `ENFORCE` admits exactly the candidates the verifier supports, after authorization, trust, lifecycle and temporal filtering; quantity and year requirements of the query remain hard gates, and exact identifier lookups keep their deterministic path. Candidates beyond `AKP_EVIDENCE_VERIFIER_MAX_CANDIDATES` stay exploratory. Only `cross-encoder-reader` may run in `ENFORCE`; relevance-only cross-encoder and extractive QA providers remain diagnostics. The API rejects relevance-only enforcement rather than silently accepting it or downgrading the configured mode.

The pinned model is cached in `AKP_MODEL_CACHE_DIR` and scores on CPU. Measure
load and scoring latency on the intended hardware; the candidate limit bounds
work. A provider failure records `VERIFIER_ERROR`. Shadow mode retains the
deterministic decision; enforced reader mode leaves an unsupported natural
language candidate exploratory. Base retrieval works without a paid provider.

The pack includes adversaries with missing rows/columns, wrong entities or
periods and reversed relations. High relevance on those units is a ranking
signal, not an admission result. Evaluate false acceptance and exact source
spans independently of any threshold sweep.

### Reader stage

The `cross-encoder-reader` provider adds the stage that a relevance model cannot provide. The cross-encoder shortlists the highest-scoring candidates, and a language model behind any OpenAI-compatible chat endpoint, such as a local Ollama, llama.cpp or LM Studio server, judges each shortlisted unit: does the passage itself state the requested information, and which exact passage text says so? A judgment counts only when its quote is verbatim body text; the quote is mapped back to its exact original prose characters or original table row, which becomes the inspectable evidence span. A paraphrased or invented quote, or a quote taken from the heading, leaves the candidate exploratory. The passage is sent as delimited data with an instruction to ignore instructions inside it, and decoding is greedy.

```dotenv
AKP_EVIDENCE_VERIFIER_PROVIDER=cross-encoder-reader
AKP_EVIDENCE_VERIFIER_MODE=ENFORCE
AKP_EVIDENCE_READER_BASE_URL=http://127.0.0.1:11434
AKP_EVIDENCE_READER_MODEL=<model name served by the endpoint>
# Optional
AKP_EVIDENCE_READER_API_KEY=
AKP_EVIDENCE_READER_SHORTLIST=4
AKP_EVIDENCE_READER_TIMEOUT_MS=30000
```

The reader sends passage text to the configured endpoint. Use a local endpoint, or a remote one only where sending the vault content is acceptable. Its admission quality depends on the model and must be measured on the admission pack before it is enforced.

Measure a change with:

```powershell
pnpm benchmark:evidence-admission:generalization
$env:AKP_EVIDENCE_ADMISSION_VERIFIER = "contextual-cross-encoder"
$env:AKP_EVIDENCE_VERIFIER_MIN_SCORE = "0.2"
pnpm benchmark:evidence-admission:generalization
```

## Optional extractive evidence reader

The local multilingual QA adapter remains optional and `SHADOW` only. It extracts a span from the authorized atomic passage; an extraction score does not establish that a proposition follows from that span.

The pinned SQuAD2 reader retains its CLS no-answer outcome and compares it with bounded context spans. Question, padding and special tokens cannot become answers. This follows the [Transformers null-answer decoder](https://github.com/huggingface/transformers/blob/v4.57.1/src/transformers/pipelines/question_answering.py). The installed Transformers.js reader discards that outcome after computing its probability, so AKP decodes the model logits explicitly.

Input exceeding the model token window fails explicitly instead of silently truncating a question or evidence. Citation offsets must match the original UTF-16 passage. Without model offsets, a decoded answer must occur exactly once; ambiguous repetitions or Unicode case-folded matches cannot fabricate a locator.

`benchmark:evidence-verifier-shadow` records decisions, reasons, spans and threshold sweeps. Its synthetic examples are development regressions, not independent calibration. A model that returns a thematic span, misses a supported relation, or cannot handle a table remains in shadow until document- and question-family-disjoint evaluation supports promotion.

The BGE reranker/binary-entailment comparison is also a development experiment. Its `HOLDOUT` has disjoint synthetic sources but reuses question families; it cannot establish generalization to unseen families. Reports mark that boundary explicitly. A precision denominator of zero is [undefined](https://scikit-learn.org/stable/modules/generated/sklearn.metrics.precision_score.html), represented as `null`, rather than perfect precision. Span accuracy also remains `null` when selected gold candidates lack complete span annotations; coverage and evaluated counts are reported separately.

## Retrieval trace

Every selected search candidate carries a bounded first-class retrieval trace from candidate generation through fusion, optional reranking and ContextPacket projection. The trace records channel/rank/raw score, the concrete index or model generation when one exists, persisted query-transform provenance, the authorization scope that admitted the candidate, temporal/truth state, fusion contribution, rerank before/after values and the final selection reason.

This trace is operational provenance, not model chain-of-thought. It contains no hidden reasoning tokens or provider deliberation. Channels that do not have a real generation identifier leave that field absent rather than inventing one. HTTP requests that passed the authorization boundary record `ALLOW`; lower-level already-scoped library calls record `SCOPED_INTERNAL` rather than pretending an authorization decision occurred. RRF never uses trace metadata as ranking input.

The full ContextPacket retains the full trace. Its compact agent projection preserves the channel/rank/raw score, generation kind/id, query transform, support, authorization, truth/temporal state, fusion, rerank and final reason, but omits optional provider/model/configuration labels from generation descriptors so operational metadata cannot crowd evidence text out of a small compact budget.

## Security and governance boundaries

Authorization filtering precedes graph/vector/community expansion. A high score cannot override scope, lifecycle, trust or support policy.

Retrieved content is untrusted data. Ranking, community membership, PPR and model reasoning do not create canonical facts.

Context packets expose bounded locators/citations and sanitize unsafe local-path/provider details at product boundaries.

## Degraded and offline behavior

Optional channels can fail independently. The response records requested/effective channels and warnings while deterministic permitted channels continue.

Reranking is optional. If the reranker throws through its provider boundary or emits an invalid score, AKP preserves the already-authorized, truth-valid fused order and records a stable `RERANKER_FALLBACK:*` warning. Raw provider errors are not copied into result metadata. Duplicate baseline candidate identities still fail as an internal invariant violation instead of being hidden as provider degradation.

If vector generation is absent or incompatible, lexical/graph paths may still serve the request. If strict truth/context revision changes during execution, the operation fails or restarts rather than mixing revisions.

Offline snapshots retain a bounded packet at a pinned revision; stale snapshots disclose staleness and do not masquerade as fresh retrieval.

## Failure and recovery

Vector, graph, community and context-packet state are rebuildable. Durable canonical/source/truth state remains the recovery authority.

After a restore or large source/profile change, rebuild affected projections and use doctor plus retrieval diagnostics to confirm revision parity.

Provider/model unavailability should surface as a safe code/warning, not raw credentials, source content or endpoint details.

## Example

A conceptual question may combine lexical evidence with a community-oriented candidate and an approved graph relation. RRF/reranking determines ordering, but the answer is grounded only in returned citations/support. If the community index is stale, that channel is omitted or flagged rather than granting extra confidence.

## Limitations

Benchmark scores are corpus- and configuration-specific. They do not prove universal superiority over another retrieval architecture.

PPR currently executes on demand and does not have a durable job lifecycle. Cancellation is cooperative for the operation rather than a queued-job cancellation contract.

### Benchmark recording provenance

For cached reader experiments, set `AKP_EVIDENCE_READER_MODEL_REVISION` to the
verified model revision/digest and `AKP_EVIDENCE_READER_DEPLOYMENT_FINGERPRINT`
to a recorded fingerprint of the serving revision and inference configuration.
These benchmark-only settings bind cache reuse; they do not enable a runtime
provider or independently verify a remote deployment. Never include credentials.
New reader and cross-encoder recordings use schema version 2. Legacy recordings
must be regenerated rather than relabeled. Cache-hit policy timings are reported
separately from fresh model inference time. See the generalization pack README.
