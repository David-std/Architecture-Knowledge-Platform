# Selective semantic evidence admission (PR #38)

Status: **implemented behind opt-in flags, not evaluated for promotion**. This change is a code-first phase. The existing SHADOW/ENFORCE/LAYERED choice, shortlist size 4, score ordering and one-pass reader remain the defaults; no evaluation corpus was used to tune these mechanisms.

## Goal and separation of responsibilities

Retrieval seeks a relevant source unit (Recall@k); reranking chooses a bounded reading budget; the semantic reader asks whether a particular source span answers the **fully qualified** question; the structural guard verifies that span can legally and exactly be cited; query-level selection decides whether to answer or abstain. Exact source offsets and a model's answerability verdict are necessary checks, **not a guarantee that the quoted subspan entails the answer**. A system that abstains from everything has no useful coverage. Optimize the joint precision/coverage tradeoff and negative-query false admissions, never just one percentage.

## Implemented opt-in configuration

| Variable                                        | Default | Effect                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AKP_EVIDENCE_READER_SHORTLIST_STRATEGY`        | `score` | `document-diverse` selects the best-scoring eligible candidate of each source document before using remaining reader slots for repeated units. Same shortlist size; does not generate queries or add reader calls.                                                                   |
| `AKP_EVIDENCE_READER_CONFIRM_QUOTE`             | `false` | When the first judgment admits a source span, ask the reader again using **only the quoted text**, without title or surrounding passage. Abstain on an insufficient quote, unlocatable second quote, or reader failure. Adds up to one reader call per tentative positive admission. |
| `AKP_EVIDENCE_ADMISSION_MIN_DISTINCT_DOCUMENTS` | `1`     | In LAYERED mode, admit a query-level answer only if at least N different document IDs individually pass source-bound admission. Otherwise withhold all supported candidate keys. No additional model calls.                                                                          |

Document diversity is a ranking prior, not evidence authority. Different document IDs need not mean independent underlying sources, and requiring two or more may sharply reduce coverage. Quote-only rereading is **not an independent verifier** when using the same model; correlated mistakes are possible. Both remain disabled until an independently evaluated comparison supports promotion. A quote-only replay may reject otherwise valid rows if the first quote omits its table header, relation direction, subject or qualifier. It is deliberately conservative.

Existing `AKP_QUERY_TRANSFORM_PROVIDER=openai-compatible-translation` remains optional. The completed F6 translation + LAYERED comparison did not improve admission (52/90 vs 52/90) and increased negative admissions (1/18 vs 0/18); do **not** promote that combination by default. The separate shortlist-6 experiment admitted 49/90 gold units and had nine degraded cases, versus 52/90 and one degraded case with shortlist 4. Do not change the default from 4 to 6.

## Lightweight measurements prepared in code

`evaluateOwnerEvidencePrecision` requires independent human `ANSWERS`, `RELATED_NOT_ANSWERING`, or `WRONG` labels for **every evidence in the evaluated sample**, otherwise precision is `null`. `evaluateSelectiveQueryOutcomes` separately reports coverage, false admissions among independently labeled unanswerable queries, and precision over emitted answers; missing correctness labels produce `null`, not an invented 100%. `gradedProportion` reports the Wilson 95% lower bound where a proportion is defined.

For the later governed A/B, freeze a **new** domain-disjoint set with real end-to-end source retrieval, measure gold-unit Recall@k, source-bound answer-bearing subspan overlap, owner adjudicated evidence precision, query-level precision/coverage, negative false admissions, latency and failure/degraded rates. Change one mechanism per comparison; do not re-tune F3/F5/F6 or publish any private evidence to GitHub.

## Promotion gates

Keep the owner acceptance gates: ≥50 adjudicated F3 evidence labels; precision ≥0.80 and Wilson lower 95% ≥0.70; no worse negative FAR vs baseline and ≤10%; paired statistical test on independent gold-bound questions; production-representative p95 ≤25s and degradation ≤5%; ≥80 answerable plus ≥15 unanswerable new independent evaluation questions. A passing CI build and the 27/27 PR implementation checklist **do not** establish this acceptance.

**No merge, no activation of defaults and no confidential evaluation corpus in this PR.**

## Source conflict abstention

`AKP_EVIDENCE_ADMISSION_ABSTAIN_ON_CONFLICT=false` by default. When explicitly true in LAYERED mode, any source-bound `CONTRADICTS` verdict among the evaluated candidates causes query-level abstention, even if another candidate provides admitted support. This is a conservative policy, not proof of source reliability; contradiction detection depends on the verifier's ability to identify it. It adds no model calls.
