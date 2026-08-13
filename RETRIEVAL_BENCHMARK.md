# Retrieval benchmark

## Current executable evidence

The current reproducible artifact is
[`reports/retrieval/offline-benchmark.json`](reports/retrieval/offline-benchmark.json).
It was generated with:

```powershell
pnpm benchmark:retrieval:offline -- --repo-root . --generated-at 2026-08-12T00:00:00.000Z
```

The recorded result is:

| Field                   | Value                                                              |
| ----------------------- | ------------------------------------------------------------------ |
| status                  | `IMPLEMENTED_AND_EXECUTED`                                         |
| evidence level          | `LOGIC_ONLY_SYNTHETIC`                                             |
| quality claim           | `NONE`                                                             |
| generated at            | `2026-08-12T00:00:00Z`                                             |
| generic cases           | `19`                                                               |
| observed slices         | `19`                                                               |
| required generic slices | `14`                                                               |
| dataset SHA-256         | `e8d9d5959aab4773b46210ad01b9ac6bfffc110dfc7f95d9bfb5cdd79991fdca` |
| report SHA-256          | `AA000CE2339B5F89C0351AFADFC40A4B0994E90552DA22209923D6BCE6A1C9F3` |

The runner reads only `evals/generic/**/*.jsonl`. Its provider,
`synthetic-gold-projection-v1`, generates deterministic identifiers and noise
to exercise scoring and policy branches. It does not read the private vault,
PostgreSQL, embeddings, graph projections or document content. Consequently,
this artifact is not evidence of retrieval quality on a real corpus.

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

The offline artifact evaluates all ten configurations over all 19 cases. The
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
- Evidence and citation quality remain unmeasured until labelled fixtures are
  added.
- The API route is wired to the canonical ten-configuration matrix, but this
  document does not claim a post-hardening database benchmark run.
- Runtime vector-disabled behavior, index revision handling and real latency
  still require an API/database execution recorded separately.
