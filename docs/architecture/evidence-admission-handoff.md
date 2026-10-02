# Evidence admission redesign: handoff (2026-10-02)

State of branch `chore/retrieval-generality-policy` (PR #38), updated after local verification, source-visibility, recording-provenance and selected-table-cell corrections below. The PR remains draft; optional model providers remain disabled by default.

## Problem

The deterministic support verifier (`packages/retrieval/src/support-verifier.ts`) decides whether a retrieved unit answers a question with cue-word dictionaries and three hard-coded relation verbs. Any new phrasing, a Spanish note answering an English question, or a heading that carries the subject leaves a correct unit exploratory, and topical units with numbers pass quantity questions. Retrieval itself also loses or mis-selects answers before admission; see the audits below.

## Implemented

| Area                | Change                                                                                                                                                                                                                                                                                                                                                         | Where                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Measurement         | Domain-disjoint admission pack: 8 domains (EN/ES), 112 units, 261 questions with paraphrases, cross-lingual pairs, table rows and unanswerable traps; development and held-out splits by domain                                                                                                                                                                | `evals/generic/evidence-admission`, `scripts/evidence-admission-pack.ts`, `pnpm benchmark:evidence-admission:generalization` |
| Admission           | Contextual cross-encoder verifier: `bge-reranker-v2-m3` (pinned ONNX) over title, heading path and body, link targets removed, table rows restated with headers; batched verification; calibrated threshold 0.2                                                                                                                                                | `packages/retrieval/src/contextual-evidence.ts`, `answerability.ts`                                                          |
| Admission           | Reader stage: the cross-encoder shortlists the top candidates; an LLM behind any OpenAI-compatible endpoint returns `ANSWERS`, `RELATED_NOT_ANSWERING` or `UNRELATED` with a verbatim answer span; the span is mapped to exact original prose characters or its selected table cells, otherwise the unit stays exploratory; per-candidate failures fail closed | `packages/retrieval/src/evidence-reader.ts`                                                                                  |
| API                 | `AKP_EVIDENCE_VERIFIER_PROVIDER=contextual-cross-encoder` or `cross-encoder-reader`, in `SHADOW`; only `cross-encoder-reader` accepts explicit `ENFORCE`; default remains disabled                                                                                                                                                                             | `apps/api/src/runtime-config.ts`, `server.ts`, `.env.example`                                                                |
| CI                  | Baseline evidence envelope reads the locked Linux Docling version from `uv.lock` package entries                                                                                                                                                                                                                                                               | `scripts/baseline-evidence.ts`                                                                                               |
| Research and audits | Production RAG practices, retrieval flow audit, ingestion and chunking audit                                                                                                                                                                                                                                                                                   | `docs/architecture/evidence-admission-research.md`, `retrieval-flow-audit.md`, `ingestion-chunking-audit.md`                 |

User guide: "Contextual evidence verifier" and "Reader stage" in `docs/guides/retrieval-context-engineering.md`.

## Measured results

Admission pack, product admission path. Earlier rows are the fetched implementation baseline; v4 rows use the current structural span checks. Candidates are already provided, so this is not a retrieval benchmark.

| Verifier                                                            | Split       | Answerable recall | False acceptance | Admitted precision | Strict accuracy |
| ------------------------------------------------------------------- | ----------- | ----------------- | ---------------- | ------------------ | --------------- |
| Deterministic                                                       | development | 19.2%             | 27.6%            | 53.8%              | 29.3%           |
| Deterministic                                                       | held-out    | 26.0%             | 28.6%            | 51.0%              | 32.0%           |
| Contextual cross-encoder 0.2                                        | development | 83.7%             | 31.0%            | 88.9%              | 78.9%           |
| Contextual cross-encoder 0.2                                        | held-out    | 86.0%             | 35.7%            | 73.9%              | 74.2%           |
| Cross-encoder shortlist 4 + reader (qwen2.5:7b-instruct, prompt v2) | development | 69.2%             | 6.9%             | 96.1%              | 74.4%           |
| Cross-encoder shortlist 4 + reader (qwen2.5:7b-instruct, prompt v2) | held-out    | 71.0%             | 0.0%             | 92.3%              | 73.4%           |
| Cross-encoder shortlist 4 + reader (qwen2.5:7b-instruct, prompt v4) | development | 95.2%             | 6.9%             | 93.5%              | 91.0%           |
| Cross-encoder shortlist 4 + reader (qwen2.5:7b-instruct, prompt v4) | held-out    | 91.0%             | 0.0%             | 91.2%              | 86.7%           |

Private Spanish-language vault, real retrieval, 113 questions (95 answerable, 18 unanswerable): deterministic recall 23% and false acceptance 11%; contextual cross-encoder 0.2 recall 87% and false acceptance 6%; at 0.3, recall 85% and no false acceptance.

The cross-encoder measures topical relevance. It still admits a unit when the requested table row, name or date is missing, or the relation runs the other way, and some definitional or cross-lingual answers score below the threshold. The reader stage targets these cases.

Prompt v4 fixes the answerability/truth-polarity confusion: a denial can answer a yes/no question. Held-out negative-answer recall is now 91.7%, but wrong additional units in answerable queries remain. The 128-question held-out split has 100 positives and 28 negatives; its 0 observed false acceptance does not establish universal precision. Splits are source-disjoint, not question-family-disjoint. Qwen 2.5 7B Instruct Q4_K_M was pinned locally to digest `845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e` with a shortlist of four. Only development cases informed the prompt.

The runtime also prevents unrelated numbers/years elsewhere on the same line or unit from satisfying the verified quote. Repeated ambiguous quotes and open questions fail closed. The quote remains an exact source locator, not proof by itself that the requested fact is answered. Runtime configuration now rejects relevance-only cross-encoder `ENFORCE`; offline benchmarks can still evaluate that experimental path to quantify its errors. Provider timeouts include response-body reading, and reader/Docling errors expose safe codes.

Real retrieval over the existing private projection improved gold-document recall at 10 from 75/95 to 78/95, and within the whole candidate pool from 90/95 to 92/95. Recall at 1 fell from 42/95 to 40/95; this is not a uniform ranking improvement. The retained changes preserve indexed accents, vector recall for capable intents, and strict/vector leaf precedence. A prototype putting all OR recall in a zero-weight tail reduced recall at 10 to 70/95 and was discarded. These are document-level retrieval results, not unit-level admission accuracy. Imported files were not modified or reindexed.

## Optional local configuration (not default promotion)

```dotenv
AKP_EVIDENCE_VERIFIER_PROVIDER=contextual-cross-encoder
AKP_EVIDENCE_VERIFIER_MODE=SHADOW
AKP_EVIDENCE_VERIFIER_MAX_CANDIDATES=32
AKP_MODEL_CACHE_DIR=<folder holding onnx-community/bge-reranker-v2-m3-ONNX>
```

Reader stage with a local Ollama (`qwen2.5:7b-instruct`): set the provider to `cross-encoder-reader`, `AKP_EVIDENCE_READER_BASE_URL=http://127.0.0.1:11434` and `AKP_EVIDENCE_READER_MODEL=qwen2.5:7b-instruct`. On a 6 GB GPU, start the server with `OLLAMA_CONTEXT_LENGTH=2048`, `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`.

## Measure

```powershell
pnpm benchmark:evidence-admission:generalization
$env:AKP_EVIDENCE_ADMISSION_VERIFIER = "contextual-cross-encoder"   # or cross-encoder-reader
$env:AKP_EVIDENCE_VERIFIER_MIN_SCORE = "0.2"
pnpm benchmark:evidence-admission:generalization
```

`packages/retrieval/scripts/contextual-evidence-pack-scores.ts` records cross-encoder scores once; `AKP_CONTEXTUAL_EVIDENCE_SCORES` replays them, and `AKP_EVIDENCE_READER_CACHE` caches reader judgments. Tune only on development domains; report held-out once.

## Current private execution and contextual retrieval experiment

The fresh private retrieval run has 113 questions: 95 with a predefined gold
document and 18 negatives. The source is unchanged and read-only; its projection
has not yet been regenerated with the ingestion or contextual-input corrections.
The current pre-admission pool contains a gold document in 92/95 positives
(top-5: 71/95, top-10: 78/95). Default deterministic admission accepts a gold
document in 22/95. Reader v4 plus fresh BGE scores accepts it in 63/95 and falsely
accepts 1/18 negatives. A cached-judgment replay with the final structural checks
preserves those counts. These labels are not exhaustive unit/span annotations:
63 gold documents do not establish precision for every admitted unit.

Stage attribution for the 32 reader positives without an admitted gold document:
3 have no gold in the current pool, 5 have no read gold candidate, and 24 have a
read gold candidate that is rejected. Those gold-candidate traces include 15
no-answer decisions, 10 non-verbatim quotes, and one invalid provider reply
(more than one trace can belong to the same question). The remaining false
acceptance substitutes a count of evaluation cases for a different requested
measurement. It is an answer-scope error, not a reason to add the private metric
or wording to the generic cue dictionary. Fresh per-question model latency was
not retained after the cached-policy replay; cached replay time is not inference
latency and must not be reported as such.

`pnpm benchmark:embedding-context` uses fresh, pinned E5 inference and the same
112-unit public corpus for both arms. All eight synthetic domains form one
explicit evaluation corpus; no gold label enters scoring. The versioned
`title-heading-v1` recipe changes only passage metadata, not query text.

| Gold-unit retrieval | Development (104 positives), body / contextual | Held-out sources (100 positives), body / contextual |
| ------------------- | ---------------------------------------------- | --------------------------------------------------- |
| Recall@1            | 76 / 94                                        | 71 / 89                                             |
| Recall@5            | 94 / 99                                        | 87 / 98                                             |
| Recall@10           | 97 / 104                                       | 93 / 98                                             |
| Recall@64           | 104 / 104                                      | 99 / 99                                             |

This is source/domain-disjoint, not question-family-disjoint. It supports an
explicit experimental input recipe, not automatic activation or answer support.
The recipe is implemented for both managed indexing and read-only import. A new
append-only migration preserves body hashes and adds actual-input fingerprints;
compatible cache reuse also checks that fingerprint. DB activation and contextual
vector retrieval reject outdated metadata inputs. Queries resolve the recorded
recipe while retaining the base model's query role and prefix. PostgreSQL tests
cover metadata changes, reuse, scoped repair, direct-SQL rejection and source-byte
preservation; the actual E5/API regression also passes.

## Next steps, in priority order

1. **Fresh end-to-end private verification.** Regenerate authorized pools and input-bound relevance scores for the current runtime; then grade accepted atomic units and verified quotes, not just document IDs. Old score records keyed only by question/unit IDs must not establish evidence for changed excerpts.
2. **Remaining admission precision.** Wrong extra units, quantities attached to another object, incomplete compound answers and paraphrase losses require independent source/family-disjoint data. Do not add topic vocabulary or relax fact requirements to fit individual questions. Relevance-only admission is not retained as a recommended default; high scores cannot bypass an answer check.
3. **Retrieval flow** (`retrieval-flow-audit.md`). Measure per-document channel ranks, lexical normalization and contextual title/heading embeddings with the explicitly configured versioned contextual recipe and new generation. Leaf selection, preserved accents and vector routing are corrected. Lowering OR weight or pruning by corpus frequency is still an experiment, not an implemented release decision.
4. **Ingestion** (`ingestion-chunking-audit.md`). Comment-free evidence, full review material, headerless tables and partial-conversion rejection are corrected. Heading hierarchy, layout-aware de-hyphenation, first-heading title fallback and long/table-row units still need independent evaluation and normal projection regeneration.
5. **Measurement provenance.** Bind recorded scores to actual query/body hashes and reader caches to model digest and inference configuration. Preserve source-disjoint holdout; add question-family-disjoint data and counterfactual deletion negatives. A single small synthetic pack cannot prove precision for every vault query.

Private evaluation material (question set, runners and caches) stays in a local temporary folder outside the repository. Never commit vault contents or identifiers.

## Source visibility correction

A generic reproduction found that a comment-only assertion was admitted through
lexical, vector, exact and raw channels. An external verifier could also point
its evidence span into the hidden comment. Chunking had a comment mask, but the
raw-document/legacy-unit admission and reader paths did not share it.

The shared Markdown parser now masks actual HTML comments at all three
boundaries, preserves original UTF-16 positions and line endings, and leaves
comment syntax in literal code intact. Model verification rejects spans that
intersect hidden comments, including a fabricated contiguous span across a
comment. An unterminated comment remains hidden through the end of its parsed
HTML block. This changes source eligibility, not query vocabulary or trust.
The generality baseline adds only the shared parser import.

Before the correction, the four admission channels and the external-verifier
reproduction failed; afterward the retrieval package passes 375 tests. Tests
cover hidden/visible prose, escaped and fenced syntax, Unicode offsets and the
search presentation boundary. The prior contextual-input checkpoint's full
local integration rerun passed 146 API tests (one optional model test skipped)
and 65 PostgreSQL tests. A single review-policy setup deadline failure did not
recur in its isolated 8-test suite or the complete rerun; no deadline was raised.
Private accuracy figures above remain tied to their recorded source/projection;
this structural correction is not a claim of universal answer accuracy.

## Measurement provenance correction

The score replay previously joined only question and unit IDs. Reusing those
IDs after changing an excerpt silently assigned the old relevance score to a
new model input. Reader caches likewise omitted the model revision and generation
configuration, and cached query time could be mistaken for fresh inference.

New recordings bind exact input hashes, pinned model identity and inference
configuration; legacy artifacts cannot be replayed as current evidence.
Reader caches also bind prompt/generation/deployment provenance, serialize writes,
coalesce duplicate requests and distinguish fresh model time from cache hits.
Focused regressions change text, query, model revision and generation options
without changing fixture IDs and verify that the old result cannot be reused.
Prior measurements above remain historical controlled runs; no new hashes are
retroactively attached to their old artifacts. The public pack documentation
also now explicitly states that its split is not question-family-disjoint.

## Review of the remote source-selection experiment (2026-10-02)

The experiment branch at `6b8e0300` completed its [Actions run](https://github.com/David-std/Architecture-Knowledge-Platform/actions/runs/36965940343). That success proves the experiment executed, not that the proposed protocol improves evidence admission. Its four development shards cover 133 questions: 104 answerable and 29 unanswerable, from the existing public domain-disjoint pack. Candidates are supplied; neither experiment evaluates indexing or retrieval recall. The pack is not question-family-disjoint and has unit labels rather than complete gold citation spans.

| Pinned model / protocol              | Correct-gold acceptance | Negative false acceptance | All admitted-unit precision | Format failures                                    |
| ------------------------------------ | ----------------------- | ------------------------- | --------------------------- | -------------------------------------------------- |
| Qwen2.5 0.5B ONNX q4, quote v4       | 39/104                  | 10/29                     | 52.7%                       | 51 parse errors / 225 calls                        |
| Same model, numbered body lines      | 11/104                  | 8/29                      | 34.4%                       | 1 parse error + 192 invalid selections / 225 calls |
| Qwen2.5 7B Ollama Q4_K_M, quote v4   | 97/104                  | 2/29                      | 94.3%                       | 0 / 225 calls                                      |
| Same local model, numbered sentences | 96/104                  | 2/29                      | 89.2%                       | 0 / 225 calls                                      |

The local comparison used native Ollama JSON mode, fixed `num_ctx=2048`, `num_predict=256`, `temperature=0`, `seed=0`, and model digest `845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e`. Both arms were interleaved on the same questions, scored with fresh input-bound BGE recordings and the same shortlist of four candidates. Each arm made 225 fresh calls. Quote generation took about 418 seconds of model-call time and sentence selection about 362 seconds. Fresh per-question p50/p95 were 2.50/6.54 seconds and 2.19/6.17 seconds respectively. A subsequent policy replay used 225 cache hits per arm and no model calls; its millisecond timings are not inference latency. Held-out questions were not inspected in this comparison. Line and sentence protocols differ in granularity and cannot be compared across models as a single controlled treatment.

**Decision:** neither coordinate-selection result justifies runtime promotion. Numbered sources can preserve provenance, but choosing a real source does not demonstrate that it answers the query. The 7B reader still admits wrong additional units and accepts two negatives in development; this is a remaining semantic calibration problem, not a reason to add question vocabulary. Optional reader enforcement remains an explicit operator configuration, disabled by default.

### Confirmed defects and corrections in the experimental harness

- `packages/retrieval/tsconfig.json` included only `src/**/*.ts`. The former workflow's retrieval typecheck therefore did not check the new experiment scripts. `packages/retrieval/tsconfig.evidence-benchmarks.json` now checks them and root `typecheck` runs it.
- The former preflight formatted files in the runner. The reusable manual workflow now checks formatting, preserving the evaluated checkout.
- The old timing stopped at fetch headers. The comparison now includes response-body consumption and JSON decoding, with its deadline covering both.
- The aggregate checked only question totals. It now rejects different model/corpus/configuration/runtime fingerprints, duplicate or missing shard/question identities, unpaired questions, stale source pools, changed labels, unknown admissions, invalid timings and provider failures. Correctness is recomputed from the current labels.
- The provider receives `response_format=json_object` but its Transformers implementation does not constrain decoding. The report says `responseFormatRequested` and `constrainedDecoding=false`; requested JSON is not a schema-enforcement guarantee. [Ollama structured outputs](https://docs.ollama.com/capabilities/structured-outputs) documents schema-enforced output as a separate capability. It can improve output conformance, but no semantic-accuracy improvement is claimed here.
- The one-use branch workflow is replaced by `evidence-source-selection.yml`, dispatched manually after it is available in the default branch. The score, compare and aggregate scripts are reusable locally under `packages/retrieval/scripts/`; they stay development-only and do not declare a winner or modify product providers.

### Confirmed runtime defect: selected cells widened into unrelated facts

**Location:** `tableSegments` and `locateEvidenceQuote` in `packages/retrieval/src/contextual-evidence.ts`, followed by the exact-fact recheck in `packages/retrieval/src/answerability.ts`.

**Reproduction:** a model says that a cell explicitly reporting an unknown amount/count/start year answers the corresponding question. The neighboring column contains a capacity number or an audit year. The old quote locator returned the entire source row. The exact-fact guard then saw the neighboring number/year and admitted the unit as `QUERY_CONDITIONED_SUPPORT`. This was reproduced for three independent generic table shapes; the erroneous model judgment alone did not explain why the deterministic boundary accepted them.

**Correction:** normalized table characters now map to their selected value bytes. Restated headers and separators have zero-width contextual positions; they cannot supply answer bytes. Bare headers fail closed. Core exact-fact validation reconstructs the selected cells' column scope from the original table without copying unselected values. The existing numeric/year format controls run on selected values; digits in headers cannot satisfy them. Monthly column context may qualify a selected amount, so a valid quoted value is not rejected simply because its cell omits the column header. Source metadata is regenerated by core code, not accepted from the model. Existing quantity/date patterns are reused; no corpus terms, query aliases or thresholds were added.

**Evidence:** focused regressions reject neighboring quantities/years and header-only dates, preserve directly stated amounts/years, and cover Unicode, link labels, repeated quotes and hidden-source guards. A policy replay of all 133 development questions preserves both local protocol metrics above; it is not a new held-out model measurement. This fix establishes a source-range invariant, not general semantic precision. Whole-row quotations that already contain the wrong metric still require a correct query-conditioned semantic judgment.

**Next work:** keep the current quote protocol; add independently labeled question-family-disjoint and citation-span data, then compare calibrated semantic admission on all admitted units, including contradictory, cross-language, wrong-metric and scope cases. Do not promote coordinate selection, expand question-specific dictionaries, or mark private precision/retrieval checks complete based on these admission-only results.
