# Retrieval flow audit (2026-10-01)

Candidate generation and ranking, measured before evidence admission on a private Spanish-language architecture vault (549 documents, 1,033 searchable leaf units) with 113 English and Spanish questions, 95 of them answerable. Vault contents and identifiers stay local; only aggregates and code locations are recorded here. Configuration: `SOURCE_BACKED`, minimum trust `MACHINE_SUPPORTED`, internal pool cap 64, multilingual E5-small, no reranker.

## Baseline

| Slice                  | Questions | R@10  | R@20  | R@all |
| ---------------------- | --------- | ----- | ----- | ----- |
| All answerable         | 95        | 0.789 | 0.853 | 0.947 |
| English                | 69        | 0.797 | 0.855 | 0.957 |
| Spanish                | 26        | 0.769 | 0.846 | 0.923 |
| Yes/no                 | 42        | 0.881 | 0.881 | 1.000 |
| What/define            | 31        | 0.645 | 0.774 | 0.903 |
| Non-conceptual intents | 6         | 0.67  | 0.67  | 0.67  |

R@k is the share of answerable questions with a gold document among the first k pool entries. Five questions never reached a gold document. In the top 10, entries contributed only by the OR assertion-recall list made up 52% of slots with 5% precision, against 17% precision for vector-only and 37% for entries found by both channels. A gold document ranked first by the vector channel finished at pool ranks 11-32 in seven questions.

## Root causes

1. **OR assertion recall fills the pool at full lexical weight.** `assertion-recall.ts` ORs every token of three or more characters, function words included. `search.ts` appends those rows to the lexical rows and gives the channel weight 1.5, so any lexical rank up to 31 outranks vector rank 1. The primary pool is then cut at 64, and vector-only candidates below the noise are lost.
2. **The strict lexical query never matches a question.** `plainto_tsquery('simple', ...)` requires every token, and the `simple` configuration has no stop words. Title and heading weights are therefore never used. OR recall is limited to claim, rule and decision-rule documents, so concepts, policies and ADRs have no lexical path.
3. **Accent mismatch.** Query terms are accent-folded, but `simple` tsvectors keep accents, so every accented Spanish term is silently dropped from OR recall.
4. **Intent routing removes the vector channel.** Five intents (exact lookup, workflow execution, source verification, project code, impact analysis) run without vectors, and they are triggered by surface patterns such as an uppercase identifier or words like "repository", "file" or "source". Questions routed this way produced pools of one or two candidates.
5. **Embeddings carry no title or heading.** `embedding-index.ts` embeds the unit body only. Concept names often live only in the heading path, so the body cannot match a question that names the concept.
6. **One unit per document, lexical-first, containers allowed.** Fusion is per document and the representative unit comes from the lexical row first. That unit is chosen by `ts_rank_cd`, where a DOCUMENT or SECTION container, which contains every term, usually wins. 53 of 140 gold hits arrived as container units, and some answers arrived as a sibling link-only unit.
7. **Latent:** the HNSW index runs with `ef_search=40` and no iterative scan. Once the planner uses it, filtered queries will return fewer than 64 rows.

## Measured variants

| Variant                                                                            | R@1  | R@5  | R@10 | R@20 | R@all | MRR  | Misses |
| ---------------------------------------------------------------------------------- | ---- | ---- | ---- | ---- | ----- | ---- | ------ |
| Baseline                                                                           | .442 | .726 | .789 | .853 | .947  | .558 | 5      |
| Vector for all intents                                                             | .432 | .726 | .789 | .863 | .968  | .552 | 3      |
| Lexical weight 0.5                                                                 | .516 | .768 | .800 | .863 | .958  | .624 | 4      |
| OR recall keeps accents, drops terms in over 15% of documents                      | .453 | .747 | .842 | .884 | .958  | .576 | 4      |
| Contextual embeddings (title and heading path)                                     | .495 | .811 | .842 | .905 | .958  | .624 | 4      |
| Combination: routing + contextual + document ranking + OR fix + lexical weight 1.0 | .505 | .905 | .958 | .958 | .989  | .659 | 1      |

In the combination, R@10 is 0.957 for English questions and 0.962 for Spanish ones. These are pre-admission numbers from one vault. Promoting any change still requires the held-out and unanswerable evaluations of the retrieval generality policy.

## Proposals

1. Give OR assertion recall its own lower-weight channel. It should fill only leftover pool slots, keep accents, and drop terms by document frequency computed per vault revision. That is a corpus statistic, not a stop-word list.
2. Make intent routing only add channels. Vectors stay available for every intent, and identifiers inside a question add exact lookup.
3. Add a contextual embedding input strategy (title and heading path above the body). It is a new embedding generation and requires re-embedding.
4. Rank the vector channel by document, keeping a document's other good units as siblings.
5. Prefer leaf units over containers when choosing a document's unit. Send admission the best two or three sibling leaves per document.
6. Enable an HNSW iterative scan, or over-fetch, before the index is used.
