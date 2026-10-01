# Evidence admission in production RAG systems

Research notes (2026-10-01) behind the evidence admission redesign. Code claims were checked against the source at the linked commits; items marked _unverified_ were not re-checked.

## What proven systems do

No widely used open-source system uses topical relevance alone as a strict admission gate. Most keep a lenient filter and let the answer step abstain. The systems that decide whether a passage actually answers share three traits:

1. The judge has an explicit "related but does not answer" outcome.
2. The judge must copy the supporting text, and code verifies the copy.
3. Thresholds are calibrated on held-out data that includes unanswerable questions.

| System                                                                                                                                                                      | Gate and decision rule                                                                                                                                                                                                                                                    | Lesson for AKP                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [PaperQA2](https://github.com/Future-House/paper-qa/blob/57e89f7223b0960d5ee5ea048c69e3c47e088572/src/paperqa/prompts.py#L108-L119)                                         | One LLM call per chunk returns `{summary, relevance_score 0-10}`; top 5 kept, score below 1 dropped ([settings](https://github.com/Future-House/paper-qa/blob/57e89f7223b0960d5ee5ea048c69e3c47e088572/src/paperqa/settings.py#L1214-L1224)); the answer prompt abstains. | Rewriting chunks into question-specific evidence helps; a topical score of 1 is too lenient for admission.                                                                                                                                                                                        |
| [Onyx](https://github.com/onyx-dot-app/onyx/blob/c2e5be7996373ed120f770209ffe9a6c498fc4e6/backend/onyx/prompts/search_prompts.py)                                           | Listwise selection, then a 0-3 pointwise class where 0 includes "on topic but a different context or subject".                                                                                                                                                            | The explicit class is right, but current code replaces a dropped section with the original ([search_tool.py](https://github.com/onyx-dot-app/onyx/blob/c2e5be7996373ed120f770209ffe9a6c498fc4e6/backend/onyx/tools/tool_implementations/search/search_tool.py#L1158-L1182)): fail closed instead. |
| [Danswer v0.10](https://github.com/onyx-dot-app/onyx/blob/v0.10.0/backend/danswer/llm/answering/stream_processing/quotes_processing.py)                                     | "Useful" filter (failed open on errors); answer quotes must be exact substrings, unmatched quotes dropped.                                                                                                                                                                | Verbatim quote checking works; failing open does not.                                                                                                                                                                                                                                             |
| [RAGFlow](https://github.com/infiniflow/ragflow/blob/519e7d98a5651564d4e35d6648f006cba4baaf4f/internal/service/nlp/retrieval.go#L100-L122)                                  | `0.7 token + 0.3 vector` with threshold 0.2; empty response when nothing passes; [sufficiency check](https://github.com/infiniflow/ragflow/blob/519e7d98a5651564d4e35d6648f006cba4baaf4f/rag/prompts/sufficiency_check.md) returns missing information.                   | Abstain before generation; do not dilute a reranker to 30% of the score.                                                                                                                                                                                                                          |
| [LlamaIndex](https://github.com/run-llama/llama_index/blob/7e2c60a78ec27e8d146dfdd596778aea83c041d5/llama-index-core/llama_index/core/postprocessor/llm_rerank.py)          | Listwise LLM rerank in batches of 10; RRF k=60; auto-merging when over half of a parent's children are retrieved.                                                                                                                                                         | Parent/sibling expansion fixes "right document, wrong unit".                                                                                                                                                                                                                                      |
| [Haystack](https://github.com/deepset-ai/haystack/blob/7f4f71887e68f821a3531ae540008294ea099b7f/haystack/components/rankers/llm_ranker.py)                                  | JSON-schema listwise ranker that may return no documents; RRF k=61.                                                                                                                                                                                                       | Constrained JSON output.                                                                                                                                                                                                                                                                          |
| [LangGraph CRAG/Self-RAG examples](https://github.com/langchain-ai/langgraph/blob/b36b1d58a8b408455b512cfad3b1b26e02927282/examples/rag/langgraph_adaptive_rag_local.ipynb) | Grader accepts any keyword overlap: "it does not need to be a stringent test".                                                                                                                                                                                            | Exactly the failure to avoid for admission.                                                                                                                                                                                                                                                       |
| [CRAG paper](https://arxiv.org/html/2401.15884)                                                                                                                             | Fine-tuned T5-large evaluator with upper/lower thresholds: correct, ambiguous, incorrect; strip-level filtering.                                                                                                                                                          | The paper uses a task-specific trained evaluator; a generic relevance cross-encoder is not an evidence authority.                                                                                                                                                                                 |
| [Kotaemon](https://github.com/Cinnamon/kotaemon/blob/9ad3e4e49aa35b8acddd235918a5d9753c1cfdf9/libs/kotaemon/kotaemon/indices/qa/citation_qa_inline.py)                      | Coverage rubric; citations anchored by exact start/end phrases matched with a similarity floor.                                                                                                                                                                           | Anchor fallback when a full quote does not match exactly.                                                                                                                                                                                                                                         |
| [Sufficient Context, ICLR 2025](https://arxiv.org/html/2411.06037)                                                                                                          | Autorater lists sub-questions, answers them, outputs sufficient 0/1; Gemini 1.5 Pro 93%, TRUE-NLI 82.6%, "contains ground truth" 80.9%.                                                                                                                                   | Decompose the question before judging; NLI-only raters are weaker.                                                                                                                                                                                                                                |
| [MiniCheck](https://github.com/Liyan06/MiniCheck/blob/b58b9fa69acbd1015ec970fa65dd752413a053d2/minicheck/inference.py#L488-L499)                                            | Claim support: max over chunks, min over sentences, > 0.5. English training.                                                                                                                                                                                              | Optional independent support check after validation on Spanish.                                                                                                                                                                                                                                   |
| [Anthropic Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval)                                                                                       | 50-100 tokens of context prepended before embedding and BM25: top-20 failures -35% (embeddings), -49% (with BM25), -67% (with rerank).                                                                                                                                    | Contextual headers at indexing time.                                                                                                                                                                                                                                                              |

## Retrieval and parsing practices

- RRF k is 50-61 across Onyx, LlamaIndex and Haystack; Onyx weights query variants (semantic rewrite 1.3, keyword 1.0, original 0.5).
- Cross-lingual corpora: RAGFlow translates the question into each configured language ([chat_pipeline.go](https://github.com/infiniflow/ragflow/blob/519e7d98a5651564d4e35d6648f006cba4baaf4f/internal/service/chat_pipeline.go#L594-L614)). For AKP, keep the original query and fuse translated legs; Postgres `simple` full-text search cannot bridge languages.
- Docling serializes table cells as `row, column = value` ([hierarchical_chunker.py](https://github.com/docling-project/docling-core/blob/main/docling_core/transforms/chunker/hierarchical_chunker.py)); one unit per table row with caption and headings makes a missing row detectable.
- Normalize Unicode, whitespace, hyphenation and quote characters before any verbatim check.

## Evaluation

Report false acceptance on unanswerable questions, false abstention on answerable ones, selective accuracy versus coverage, and citation precision ([ALCE](https://arxiv.org/abs/2305.14627)). A generic hard negative for "on topic, value missing": delete the sentence or table row holding the answer from a gold unit and require abstention. Candidate public sets, unverified for fit: SQuAD2, MLQA/XQuAD, [NoMIRACL](https://arxiv.org/abs/2312.11361), [RGB](https://arxiv.org/abs/2309.01431).

## Recommendations for AKP

1. Reader verdict with an explicit `RELATED_NOT_ANSWERING` outcome and a verified answer span; fail closed on parse errors and timeouts.
2. Deterministic answer-slot check: the verified span must contain a token of the requested type (number, date, name, definition).
3. Use relevance scores to shortlist candidates, not to admit evidence. The local held-out relevance-only run accepted 35.7% of unanswerable questions. A high relevance score cannot bypass requested-fact verification; CRAG evaluator thresholds cannot be transferred to a different model and task without calibration.
4. Row-level table units with bound headers, plus OCR normalization at ingestion.
5. Contextual headers (title and heading path) in both the full-text and vector indexes.
6. Cross-lingual query legs fused with weighted RRF when an LLM is configured.
7. Optional packet-level sufficiency check with one follow-up retrieval round.
8. Counterfactual-deletion negatives and per-language reporting in the admission pack.

Reader prompt pattern for a local 7B model: state the needed fact, copy the shortest answering span verbatim, then choose `ANSWERS`, `RELATED_NOT_ANSWERING` or `UNRELATED`; question last; JSON-constrained output at temperature 0; pointwise for admission; self-consistency only in the middle band.

## Local review of the implementation

The original comparison is not sufficient evidence for default promotion. The
reader's yes/no verdict is answerability, not the truth value of the question:
an explicit denial can answer "no". Prompt v4 also preserves subject, event,
object, row, date, units and quantifiers in the requested fact. No corpus-specific
examples, aliases or source identifiers were added.

Code now maps a unique prose quote to its exact original characters, rather than
an entire containing line. Table quotes remain bound to their original rows.
Numbers/years elsewhere in a unit cannot meet a requested quantitative/temporal
fact in the verified quote, and an open question cannot serve as an assertion.
This is a structural safeguard; quote identity alone still does not demonstrate
that the source answers the question.

On the unchanged 261-question source-disjoint pack, Qwen 2.5 7B Instruct Q4_K_M
(prompt v4) with a fixed BGE v2-m3 shortlist of four measured:

| Split             | Answerable recall | False acceptance on negatives | Admitted-unit precision | Strict accuracy |
| ----------------- | ----------------- | ----------------------------- | ----------------------- | --------------- |
| Development (133) | 95.2%             | 6.9%                          | 93.5%                   | 91.0%           |
| Held-out (128)    | 91.0%             | 0.0%                          | 91.2%                   | 86.7%           |

The held-out result includes 100 answerable and 28 unanswerable questions.
Relative to prompt v2, answerable recall rose from 71% to 91%, while admitted-unit
precision was 92.3% versus 91.2%. The negative-answer slice reached 91.7% recall;
wrong additional units in answerable cases remain a real problem. Zero observed
negative acceptance in 28 cases is not a universal precision guarantee.

Only development cases informed the prompt. Held-out cases were read as aggregate
results after the prompt was fixed; cached judgments were replayed through the
final span guards. Splits are source-disjoint, **not question-family-disjoint**.
Reranker scores came from unchanged recorded query/body pairs, so this measures
admission with candidates already present, not end-to-end retrieval. The verifier
remains optional and disabled by default. A new private end-to-end run must use
fresh pools and input-bound score records after retrieval/index changes.
