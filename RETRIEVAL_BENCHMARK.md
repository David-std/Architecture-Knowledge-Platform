# Retrieval benchmark

## Current executable evidence

Two reproducible evidence levels are checked in:

- [`reports/retrieval/offline-benchmark.json`](reports/retrieval/offline-benchmark.json):
  Level A, deterministic scoring/policy evidence over 19 generic cases.
- [`reports/retrieval/curated-benchmark.json`](reports/retrieval/curated-benchmark.json):
  Level B, deterministic retrieval over 13 labelled cases distributed across
  three isolated fixture vaults.

They were regenerated with:

```powershell
pnpm benchmark:retrieval:offline
pnpm benchmark:retrieval:curated
```

The recorded results are:

| Field                  | Level A                                                            | Level B                                                            |
| ---------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| status                 | `IMPLEMENTED_AND_EXECUTED`                                         | `IMPLEMENTED_AND_EXECUTED`                                         |
| evidence level         | `LOGIC_ONLY_SYNTHETIC`                                             | `CURATED_FIXTURE`                                                  |
| quality claim          | `NONE`                                                             | `FIXTURE_ONLY`                                                     |
| cases / configurations | `19 / 10`                                                          | `13 / 10`                                                          |
| vault isolation        | case metadata                                                      | `3` fixture vaults                                                 |
| production default     | `null`                                                             | `null`                                                             |
| report SHA-256         | `10F02A8D19150C24D11F5545988204B7A44EBE6E0C92D41CA14F327ECC8CA98D` | `9C5491FF25B523859B350235E0F010F01CACFCE6703907073D4B1292EE96D5F5` |

The Level-A runner reads only `evals/generic/**/*.jsonl`. Its provider,
`synthetic-gold-projection-v1`, generates deterministic identifiers and noise
to exercise scoring and policy branches. It does not read the private vault,
PostgreSQL, embeddings, graph projections or document content. Consequently,
this artifact is not evidence of retrieval quality on a real corpus. Level B
does execute the retrieval implementation over local labelled fixtures, but
its corpus is intentionally small and curated; perfect recall there must not
be generalized to production.

## Required matrix

The package-level `RETRIEVAL_BENCHMARK_MATRIX` and the API benchmark route use
the same ten configurations:

| Configuration                | Channels                                    | Vector benchmark-only | Rerank |
| ---------------------------- | ------------------------------------------- | --------------------: | -----: |
| `context-pack-only`          | context-pack                                |                    no |     no |
| `exact+lexical`              | exact, lexical                              |                    no |     no |
| `vector-only`                | vector                                      |                   yes |     no |
| `graph-only`                 | graph                                       |                    no |     no |
| `lexical+vector`             | lexical, vector                             |                   yes |     no |
| `lexical+graph`              | lexical, graph                              |                    no |     no |
| `vector+graph`               | vector, graph                               |                   yes |     no |
| `context-pack+lexical+graph` | context-pack, lexical, graph                |                    no |     no |
| `full-hybrid-rrf`            | context-pack, exact, lexical, vector, graph |                   yes |     no |
| `full-hybrid+rerank`         | context-pack, exact, lexical, vector, graph |                   yes |    yes |

Both artifacts evaluate all ten configurations. Level A uses 19 generic cases;
Level B uses 13 cases across three fixture vaults. The
case slices include exact identifiers, paraphrases, synonyms, cross-language,
comparisons, workflow selection, source verification, code evidence, stale
data, contradictions, no-answer, multi-vault isolation, global synthesis,
vector-disabled, grounding, lexical, permissions, security and regression.

## Metrics and interpretation

The scorer computes Recall@5, Recall@10, MRR, binary nDCG@10, no-answer
accuracy, unsupported-claim rate, exact-identifier recall, cross-language
recall, estimated token cost and estimated latency. Evidence recall and
citation precision are measured only when a case supplies `gold_evidence` or
`gold_citations` labels. The current generic fixtures supply neither, so their
coverage is explicitly `0`; no proxy is presented as measured evidence quality.

Token and latency values in the offline artifact are deterministic synthetic
estimates. They are not LLM billing data or service-latency measurements.

## Vector-disabled and default policy

The offline probe requests `exact + lexical + vector` and records the effective
channels as `exact + lexical`; `vectorInvoked` is `false` and runtime index
verification remains required. This proves only the harness policy branch.

The measured synthetic winner is `context-pack-only` and
`vectorActivatedByDefault` is `false`. The artifact deliberately records
`productionDefault.selected: null`: synthetic rankings cannot select or change
the production planner. A real API benchmark against an indexed corpus and a
held-out, labelled evaluation set is required before choosing a runtime
default, especially for vectors or reranking.

## Limitations and next evidence

- The offline run validates matrix coverage, metric arithmetic, fixture
  loading, no-answer behavior, negative expectations and default guardrails;
  it makes no corpus-quality claim.
- Level A does not measure evidence or citation quality because its generic
  cases have no such labels.
- Level B supplies citation/evidence labels for only a subset of its cases;
  that sparse coverage is not a general citation-quality result.
- The API route is wired to the canonical ten-configuration matrix, but neither
  fixture level is a held-out production database benchmark.
- Runtime vector-disabled behavior is executed and records requested
  `exact+lexical+vector`, effective `exact+lexical`, and `vectorInvoked=false`.
  Real embedding-provider quality and service latency remain unmeasured.
