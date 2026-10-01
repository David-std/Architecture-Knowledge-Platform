# Evidence admission redesign: handoff (2026-10-01)

State of branch `chore/retrieval-generality-policy` (PR #38) after the evidence admission redesign, for whoever continues it.

## Problem

The deterministic support verifier (`packages/retrieval/src/support-verifier.ts`) decides whether a retrieved unit answers a question with cue-word dictionaries and three hard-coded relation verbs. Any new phrasing, a Spanish note answering an English question, or a heading that carries the subject leaves a correct unit exploratory, and topical units with numbers pass quantity questions. Retrieval itself also loses or mis-selects answers before admission; see the audits below.

## Implemented

| Area                | Change                                                                                                                                                                                                                                                                                                                            | Where                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Measurement         | Domain-disjoint admission pack: 8 domains (EN/ES), 112 units, 261 questions with paraphrases, cross-lingual pairs, table rows and unanswerable traps; development and held-out splits by domain                                                                                                                                   | `evals/generic/evidence-admission`, `scripts/evidence-admission-pack.ts`, `pnpm benchmark:evidence-admission:generalization` |
| Admission           | Contextual cross-encoder verifier: `bge-reranker-v2-m3` (pinned ONNX) over title, heading path and body, link targets removed, table rows restated with headers; batched verification; calibrated threshold 0.2                                                                                                                   | `packages/retrieval/src/contextual-evidence.ts`, `answerability.ts`                                                          |
| Admission           | Reader stage: the cross-encoder shortlists the top candidates; an LLM behind any OpenAI-compatible endpoint returns `ANSWERS`, `RELATED_NOT_ANSWERING` or `UNRELATED` with a verbatim answer span; the span is mapped to the original line or table row, otherwise the unit stays exploratory; per-candidate failures fail closed | `packages/retrieval/src/evidence-reader.ts`                                                                                  |
| API                 | `AKP_EVIDENCE_VERIFIER_PROVIDER=contextual-cross-encoder` or `cross-encoder-reader`, with `SHADOW` or `ENFORCE`; ENFORCE is rejected for other verifiers; default remains disabled                                                                                                                                                | `apps/api/src/runtime-config.ts`, `server.ts`, `.env.example`                                                                |
| CI                  | Baseline evidence envelope reads the locked Linux Docling version from `uv.lock` package entries                                                                                                                                                                                                                                  | `scripts/baseline-evidence.ts`                                                                                               |
| Research and audits | Production RAG practices, retrieval flow audit, ingestion and chunking audit                                                                                                                                                                                                                                                      | `docs/architecture/evidence-admission-research.md`, `retrieval-flow-audit.md`, `ingestion-chunking-audit.md`                 |

User guide: "Contextual evidence verifier" and "Reader stage" in `docs/guides/retrieval-context-engineering.md`.

## Measured results

Admission pack, product admission path:

| Verifier                                                            | Split       | Answerable recall | False acceptance | Admitted precision | Strict accuracy |
| ------------------------------------------------------------------- | ----------- | ----------------- | ---------------- | ------------------ | --------------- |
| Deterministic                                                       | development | 19.2%             | 27.6%            | 53.8%              | 29.3%           |
| Deterministic                                                       | held-out    | 26.0%             | 28.6%            | 51.0%              | 32.0%           |
| Contextual cross-encoder 0.2                                        | development | 83.7%             | 31.0%            | 88.9%              | 78.9%           |
| Contextual cross-encoder 0.2                                        | held-out    | 86.0%             | 35.7%            | 73.9%              | 74.2%           |
| Cross-encoder shortlist 4 + reader (qwen2.5:7b-instruct, prompt v2) | development | 69.2%             | 6.9%             | 96.1%              | 74.4%           |
| Cross-encoder shortlist 4 + reader (qwen2.5:7b-instruct, prompt v2) | held-out    | 71.0%             | 0.0%             | 92.3%              | 73.4%           |

Private Spanish-language vault, real retrieval, 113 questions (95 answerable, 18 unanswerable): deterministic recall 23% and false acceptance 11%; contextual cross-encoder 0.2 recall 87% and false acceptance 6%; at 0.3, recall 85% and no false acceptance.

The cross-encoder measures topical relevance. It still admits a unit when the requested table row, name or date is missing, or the relation runs the other way, and some definitional or cross-lingual answers score below the threshold. The reader stage targets these cases.

The reader stage removes nearly all false acceptance: missing slots, wrong subjects and same-vocabulary traps fall to 0%. Its recall loss is concentrated in yes/no questions whose answer is "no", at 26% recall: the 7B model labels a passage that denies the statement as related but not answering. Fix this on development domains only, for example by telling the reader that a clear denial or contradiction answers a yes/no question. Then re-measure held-out once. Reader latency on a 6 GB laptop GPU is about 1-2 s per judgment.

## Enable locally

```dotenv
AKP_EVIDENCE_VERIFIER_PROVIDER=contextual-cross-encoder
AKP_EVIDENCE_VERIFIER_MODE=ENFORCE
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

## Next steps, in priority order

1. **Measure and decide the reader stage.** Run the pack and the private set with `cross-encoder-reader`. Only ENFORCE the reader if held-out false acceptance falls without losing recall. Consider the CRAG three-band rule: admit high cross-encoder scores, drop low ones, and send only the middle band to the reader.
2. **Retrieval flow** (`retrieval-flow-audit.md`). The combined fixes measured gold recall at 10 going from 0.79 to 0.96:
   - Choose an atomic unit, not a container, with length-normalized ranking (`apps/api/src/routes/search.ts` around the lateral best-unit query and `bestUnitByDocument`).
   - Keep the vector channel for every intent (`packages/retrieval/src/query-planner.ts` `intentChannels`).
   - Move OR assertion recall into its own channel at about 0.5 weight that fills only leftover slots and keeps accents (`assertion-recall.ts`, `candidate-policy.ts`, primary pool cut in `search.ts`). Monitored files must not gain literals.
   - Add a contextual embedding input strategy, title and heading path above the body, as a new generation (`packages/indexing/src/embedding-index.ts`).
3. **Ingestion** (`ingestion-chunking-audit.md`):
   - Keep `akp-locator` comments out of unit text (`apps/worker/src/document-artifact.ts`, `packages/retrieval/src/chunking.ts`).
   - Render tables that have no detected headers, and remove the 6,000-character draft preview cap.
   - Fix the Docling mapping that dropped page-2 content, and de-hyphenate extracted text (`apps/extractor/app/adapters/docling_native.py`).
   - Make link-only and label-only units ineligible for embedding, and make `semanticType` match whole words.
   - Use the first heading as the title when front matter has none.
4. Add row-level table units and counterfactual-deletion negatives to the pack, where the answer sentence is removed and abstention is required.

Private evaluation material (question set, runners and caches) stays in a local temporary folder outside the repository. Never commit vault contents or identifiers.
