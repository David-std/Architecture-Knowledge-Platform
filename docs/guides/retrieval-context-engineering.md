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

## When to use it

Use `/v1/search` for ranked evidence/document lookup. Use `/v1/context` or the agent façade when a task needs a bounded packet that combines evidence, policy context, conflicts, required actions and continuation handles.

Use temporal, code or impact-specific actions when the question has those semantics rather than relying on a broad conceptual query.

## Configuration

Search requests define query/intent, authorized space/vault scope, minimum trust, mode, limit and optional channel requirements.

`AKP_VECTOR_ENABLED` controls optional vector retrieval. Embedding generations are versioned; a query uses the compatible active generation or degrades explicitly.

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

## Contextual evidence verifier

Admission decides whether a retrieved unit answers the query, so it can be returned as `SUPPORTED` evidence rather than an exploratory candidate. The deterministic verifier matches query cue words and three hard-coded relation verbs. On the domain-disjoint pack in `evals/generic/evidence-admission` it admits a correct unit for 19–26% of answerable questions, never for yes/no or cross-lingual questions, and admits something for 28% of unanswerable ones.

The contextual cross-encoder verifier reads each unit the way a person does: under its title and heading path, with link targets removed and every table row restated with its column headers. A multilingual cross-encoder (`bge-reranker-v2-m3`, pinned ONNX revision) scores the query against that text, and the unit is admitted when the score reaches a threshold calibrated on the development domains. Title and headings matter: without them, a concept whose body never repeats its name, or a claim whose heading carries the proposition, scores close to zero.

| Pack split  | Verifier                      | Answerable recall | False acceptance | Admitted precision | Strict accuracy |
| ----------- | ----------------------------- | ----------------- | ---------------- | ------------------ | --------------- |
| Development | Deterministic                 | 19.2%             | 27.6%            | 53.8%              | 29.3%           |
| Development | Contextual cross-encoder, 0.2 | 83.7%             | 31.0%            | 88.9%              | 78.9%           |
| Held-out    | Deterministic                 | 26.0%             | 28.6%            | 51.0%              | 32.0%           |
| Held-out    | Contextual cross-encoder, 0.2 | 86.0%             | 35.7%            | 73.9%              | 74.2%           |

Enable it explicitly:

```dotenv
AKP_EVIDENCE_VERIFIER_PROVIDER=contextual-cross-encoder
AKP_EVIDENCE_VERIFIER_MODE=ENFORCE
# Optional: defaults to the calibrated 0.2.
AKP_EVIDENCE_VERIFIER_MIN_SCORE=0.2
AKP_EVIDENCE_VERIFIER_MAX_CANDIDATES=32
```

`SHADOW` records the verifier decision beside the deterministic one without changing results. `ENFORCE` admits exactly the candidates the verifier supports, after authorization, trust, lifecycle and temporal filtering; quantity and year requirements of the query remain hard gates, and exact identifier lookups keep their deterministic path. Candidates beyond `AKP_EVIDENCE_VERIFIER_MAX_CANDIDATES` stay exploratory. Only this verifier may run in `ENFORCE`; the extractive QA reader remains a diagnostic.

The model is downloaded once into the local model cache (`AKP_MODEL_CACHE_DIR`), about 570 MB. Scoring runs on CPU, roughly a quarter of a second per candidate on a laptop, so the candidate limit bounds latency. If the model cannot load or score, every candidate records `VERIFIER_ERROR` and the response degrades to exploratory results instead of guessing.

Known limits, measured on the pack: a cross-encoder measures whether a unit is about the requested information, not whether it contains the requested value. It still admits a table when the requested row or column is missing, a unit that names the subject but not the requested company or date, and a relation stated in the opposite direction. Some definitional and cross-lingual questions score below the threshold. These cases are tracked by challenge in the pack report and are the target of the next admission stage.

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
