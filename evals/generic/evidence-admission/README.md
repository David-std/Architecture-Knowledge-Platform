# Evidence admission generalization pack

This pack measures one decision: whether a retrieved unit **answers** the question, so it may be admitted as `SUPPORTED` evidence. Retrieval recall is out of scope; every question is evaluated against all units of its domain, which share vocabulary and act as distractors.

The pack exists because a handful of motivating questions cannot show that an admission rule generalizes. It covers eight unrelated domains, English and Spanish, and many phrasings of the same information need.

## Contents

- `manifest.json` lists the domains and assigns each to a split.
- `domains/*.json` contains the units of one domain and the questions asked against them.

| Split         | Domains                                                                      | Use                                                                                        |
| ------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `development` | hospital pharmacy, municipal library, warehouse logistics, food safety       | Diagnose failures and tune decisions.                                                      |
| `heldout`     | incident response, public transport, aircraft maintenance, payroll and leave | Report once per candidate. Do not inspect individual failures to tune a rule or threshold. |

The split is by domain and source: held-out documents and entities do not appear in development. It is **not question-family-disjoint**. Family labels group paraphrases within a domain, while question forms and intents are shared across splits. Independent family-disjoint evaluation remains required before promotion.

## Units

Each unit has a `documentType` (`rule`, `claim`, `concept`, `procedure`, `decision-rule`, `dashboard`, `note`), a `unitType` matching the platform unit types, a `title`, a `headingPath` and `text`. Several bodies do not repeat their subject, as in real notes where the heading carries it. Dashboards contain numbers that answer some questions and tempt false acceptance for others.

## Questions

| Field        | Meaning                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `intent`     | `YES_NO`, `DEFINITION`, `CONDITION`, `RATIONALE`, `PROCEDURE`, `QUANTITY`, `DATE` or `ENTITY`. |
| `gold`       | Every unit that states the answer. An empty list marks an unanswerable question.               |
| `acceptable` | Units that are partially informative. Admitting them is neither required nor penalized.        |
| `challenges` | Why the case is hard; see `manifest.json`.                                                     |
| `family`     | The underlying information need. Paraphrases share a family.                                   |

Labeling rules:

- A yes/no question is answered by a unit that settles it either way. A unit that says "no" is gold.
- A unit that is about the same topic but does not state the requested value, entity, relation direction or condition is not gold.
- An unanswerable question is not answered by any unit, even when one shares most of its words.

## Metrics

For every question the admitted set is compared with `gold` and `acceptable`.

- **Answerable recall**: answerable questions for which at least one gold unit is admitted.
- **False acceptance**: unanswerable questions for which any unit is admitted.
- **Admitted precision**: admitted units that are gold or acceptable, over all admitted units.
- **Strict accuracy**: answerable questions with a gold admission and no wrong admission, plus unanswerable questions with no admission, over all questions.

Results are reported per split, intent, language and challenge. Run the benchmark with:

```powershell
pnpm benchmark:evidence-admission:generalization
```

## Limitations

The units and questions are synthetic and were written by a single author, so they do not represent the distribution of real questions. Domains are small. The pack does not replace evaluation on a private corpus with real retrieval, and a good score on it is a regression signal rather than a product-wide precision claim. Labels can be wrong; correct them with a version bump rather than by changing a runtime rule to agree with them.


## Recorded model inputs and reader judgments

New cross-encoder recordings use schema version 2. Each row includes SHA-256
fingerprints of the exact query/passage pair, and the envelope binds the pinned
model revision and token/batch/dtype/device configuration. Replay rejects old
ID-only recordings, changed inputs and incompatible inference configuration.
Regenerate legacy files with `contextual-evidence-pack-scores.ts`; do not add
hashes to old rows and represent them as newly measured evidence.

Reader benchmarks require `AKP_EVIDENCE_READER_MODEL_REVISION` and
`AKP_EVIDENCE_READER_DEPLOYMENT_FINGERPRINT` when caching judgments. Pin and verify
the actual model digest/revision and record the serving configuration before
setting those values; they are operator-supplied provenance, not an automatic
verification of an arbitrary remote service. Schema version 2 keys judgments by
that provenance, generation options, prompt version and the actual reader input.
The report separates fresh model calls/time from cache hits. Mixed or cached
query elapsed times are policy replay timings, not inference latency.
Legacy reader caches must be regenerated in a new file.
