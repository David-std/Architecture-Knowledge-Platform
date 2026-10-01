# Evidence admission redesign: handoff (2026-10-01)

State of branch `chore/retrieval-generality-policy` (PR #38), updated after local verification and corrections through `9014b92d`. The PR remains draft; optional model providers remain disabled by default.

## Problem

The deterministic support verifier (`packages/retrieval/src/support-verifier.ts`) decides whether a retrieved unit answers a question with cue-word dictionaries and three hard-coded relation verbs. Any new phrasing, a Spanish note answering an English question, or a heading that carries the subject leaves a correct unit exploratory, and topical units with numbers pass quantity questions. Retrieval itself also loses or mis-selects answers before admission; see the audits below.

## Implemented

| Area                | Change                                                                                                                                                                                                                                                                                                                                                       | Where                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Measurement         | Domain-disjoint admission pack: 8 domains (EN/ES), 112 units, 261 questions with paraphrases, cross-lingual pairs, table rows and unanswerable traps; development and held-out splits by domain                                                                                                                                                              | `evals/generic/evidence-admission`, `scripts/evidence-admission-pack.ts`, `pnpm benchmark:evidence-admission:generalization` |
| Admission           | Contextual cross-encoder verifier: `bge-reranker-v2-m3` (pinned ONNX) over title, heading path and body, link targets removed, table rows restated with headers; batched verification; calibrated threshold 0.2                                                                                                                                              | `packages/retrieval/src/contextual-evidence.ts`, `answerability.ts`                                                          |
| Admission           | Reader stage: the cross-encoder shortlists the top candidates; an LLM behind any OpenAI-compatible endpoint returns `ANSWERS`, `RELATED_NOT_ANSWERING` or `UNRELATED` with a verbatim answer span; the span is mapped to exact original prose characters or its original table row, otherwise the unit stays exploratory; per-candidate failures fail closed | `packages/retrieval/src/evidence-reader.ts`                                                                                  |
| API                 | `AKP_EVIDENCE_VERIFIER_PROVIDER=contextual-cross-encoder` or `cross-encoder-reader`, with `SHADOW` or `ENFORCE`; ENFORCE is rejected for other verifiers; default remains disabled                                                                                                                                                                           | `apps/api/src/runtime-config.ts`, `server.ts`, `.env.example`                                                                |
| CI                  | Baseline evidence envelope reads the locked Linux Docling version from `uv.lock` package entries                                                                                                                                                                                                                                                             | `scripts/baseline-evidence.ts`                                                                                               |
| Research and audits | Production RAG practices, retrieval flow audit, ingestion and chunking audit                                                                                                                                                                                                                                                                                 | `docs/architecture/evidence-admission-research.md`, `retrieval-flow-audit.md`, `ingestion-chunking-audit.md`                 |

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

The runtime also prevents unrelated numbers/years elsewhere on the same line or unit from satisfying the verified quote. Repeated ambiguous quotes and open questions fail closed. The quote remains an exact source locator, not proof by itself that the requested fact is answered. Provider timeouts include response-body reading, and reader/Docling errors expose safe codes.

Real retrieval over the existing private projection improved gold-document recall at 10 from 75/95 to 78/95, and within the whole candidate pool from 90/95 to 92/95. Recall at 1 fell from 42/95 to 40/95; this is not a uniform ranking improvement. The retained changes preserve indexed accents, vector recall for capable intents, and strict/vector leaf precedence. A prototype putting all OR recall in a zero-weight tail reduced recall at 10 to 70/95 and was discarded. These are document-level retrieval results, not unit-level admission accuracy. Imported files were not modified or reindexed.

## Optional local configuration (not default promotion)

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

1. **Fresh end-to-end private verification.** Regenerate authorized pools and input-bound relevance scores for the current runtime; then grade accepted atomic units and verified quotes, not just document IDs. Old score records keyed only by question/unit IDs must not establish evidence for changed excerpts.
2. **Remaining admission precision.** Wrong extra units, quantities attached to another object, incomplete compound answers and paraphrase losses require independent source/family-disjoint data. Do not add topic vocabulary or relax fact requirements to fit individual questions. Relevance-only admission is not retained as a recommended default; high scores cannot bypass an answer check.
3. **Retrieval flow** (`retrieval-flow-audit.md`). Measure per-document channel ranks, lexical normalization and contextual title/heading embeddings with a versioned input strategy and new generation. Leaf selection, preserved accents and vector routing are corrected. Lowering OR weight or pruning by corpus frequency is still an experiment, not an implemented release decision.
4. **Ingestion** (`ingestion-chunking-audit.md`). Comment-free evidence, full review material, headerless tables and partial-conversion rejection are corrected. Heading hierarchy, layout-aware de-hyphenation, first-heading title fallback and long/table-row units still need independent evaluation and normal projection regeneration.
5. **Measurement provenance.** Bind recorded scores to actual query/body hashes and reader caches to model digest and inference configuration. Preserve source-disjoint holdout; add question-family-disjoint data and counterfactual deletion negatives. A single small synthetic pack cannot prove precision for every vault query.

Private evaluation material (question set, runners and caches) stays in a local temporary folder outside the repository. Never commit vault contents or identifiers.
