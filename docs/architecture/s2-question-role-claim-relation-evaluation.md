# S2: question role, full declarative claims and source-bound semantic verification (23 Oct 2026)

**Scope:** development-only experiments and evaluation interfaces on PR #38. This report is not an S2 gate decision or a production authorization. The original E5 HTTP/24-case admission experiment is **not rerun here**. Two source-disjoint-for-DEV families and the already captured private originals were used. The author constructed or previously inspected their labels; none is an independently adjudicated holdout. S2 OPEN; E5 SHADOW; S3–S5 BLOCKED.

## Observed failures and hypothesis

An exact SHA/UTF-16 citation establishes attribution, **not** that the answer is of the requested type or that its complete subject–predicate–object/condition/negation relation is supported. A structured JSON writer can produce a syntactically valid unsupported answer; an isolated role judge can falsely reject supported answers. These are different errors and require separate traceable observations, not one lexical threshold.

The experiment retained the raw response bytes and source hashes; subsequent runs have separate immutable output directories. No source labels were included in inference prompts. Scores derived after capture are marked as author-labeled and not independent.

## Actual comparisons, not mocked unit tests

| Arm | Sample | Support-proposal coverage | False support proposals | Interpretation |
| --- | --- | --- | --- | --- |
| Qwen2.5-7B, source-quote→question + full-claim F3 | 8 supported + 8 negative, 4 synthetic relation families | 8/8 | 1/8 (B4: wrong subject) | Both stages, original-bound spans, 44 model calls combined with Llama |
| Llama3.2-3B, same F3 | Same 16 cases | 7/8 (A2 falsely rejected) | 2/8 (B4 subject, C4 wrong permit) | A contradictory verdict on a true negative sentence is also possible |
| Pinned ONNX multilingual MiniLM, **direct complete-claim NLI only** | Same 16 cases | 8/8 | 0/8 | Historical 0.8 entailment / 0.2 margin, not tuned on these cases; **does not test question focus, QA or original HTTP** |
| Two-model source/claim grammatical-actor extraction + original literal binding | 16 per model; 32 actual model calls | Not a stand-alone support detector | Llama caught B4; C4 persisted; Qwen yielded indeterminate for all 16 | Only a candidate **negative veto**; actor identity alone cannot prove entailment |
| Qwen2.5-7B native JSON writer, generic schema/instruction v2 | 4 answerable + 4 negative MDN EN/ES | 4/4 **non-abstentions**, not correctness | 0/4 negative non-abstentions | 8/8 structurally valid |
| Llama3.2-3B same native writer request structure | Same 8 MDN cases | 4/4 non-abstentions | 4/4 negative non-abstentions | 8/8 structurally valid, but unsafe on absence |
| Existing F3 full declarative claim after cross-model MDN writer | 16 writer/model pairs | 0/8 supported positives | 0/8 false supports | Too conservative: **all** real positive answers withheld, even with some sound writer answers |
| Pinned ONNX MiniLM, direct MDN projected full claims | 8 projected non-abstained claims | 1/8 candidates overall (ES01 Llama) | 0/4 among the false-negative writers in these projected claims | Strong abstention; not calibrated for real MDN answerability |

The earlier native-writer v1 returned only **3/8 structurally valid** Qwen responses; the generic v2 JSON contract produced **8/8 for each of two models**. This improvement is purely syntactic. On MDN the raw answer/no-answer error diverged sharply across writers; writer agreement is not evidence of truth.

The preliminary question-role model classified supported answers as mismatches. Treating its judgement as an authoritative gate eliminated valid attempts **before F3**. The evaluation bridge therefore keeps the role decision as **diagnostic** while projecting the original question plus the proposed answer into a complete declarative hypothesis. Source-independent projection is never evidence: it must echo the proposed value **exactly**, preserve the question relation, and then pass original-bound F3 and a separate whole-answer check. The model can still hallucinate a projected relation. On the source-disjoint MDN cases F3 proposals were **0/8** positive, so this is **not a solved sufficiency problem**.

## Implemented, opt-in evaluation contracts

- `prepareS2QuestionAnswerClaim`: independent revision-identified answer-role probe and declarative-claim projector run concurrently; a role mismatch is recorded, not a final veto. Exact answer echo and bounded, nonempty declarative proposition are mandatory. All outputs explicitly mark semantic/source entitlement and production admission **false**.
- `bindS2VerbatimWindowQuote`: rebinding from frozen source windows to an F3-compatible literal source quote; validates SHA, original UTF-8, document frame, UTF-16 surrogate boundaries and uniqueness, and trims only *exterior* window whitespace. No fuzzy quote reconstruction or trust promotion.
- `checkS2SourceClaimActorBinding`: checks a model-proposed grammatical source actor and answer actor **only** when both are unique, verbatim substrings of the respective inputs. Mismatch is diagnostic negative evidence; match is not entailment. A short, ambiguous or absent actor remains indeterminate. This is opt-in; Qwen extraction's all-indeterminate run means it must not be treated as a generic production filter.
- Eight role-claim tests, sixteen original-window tests and four actor-binding tests: **28/28** passed in focused execution. No production HTTP search behavior, policy thresholds or default gates were changed.

## What this does not establish

The source-disjoint MDN slice contains only two editorial families, four positives and four negatives, author annotations and **no independent adjudication**. The relation benchmark is small and synthetic, previously inspected, and known to this project. ONNX direct claim entailment is not answer adequacy to the question. F3 and whole-answer evaluation did not produce a qualifying MDN answer, hence whole-answer sufficiency and final HTTP false-admission rate remain **unmeasured**, not zero. An early diagnostic-stage model output of `CONTRADICTS` is not proof of logical contradiction without original context. A falsified actor/span cannot grant authorization. Absence of false support in eight negatives has broad uncertainty; no S2 threshold or provider is promoted.

For an independent gate, use an externally frozen EN/ES corpus with different source/editorial families and both supported and unsupported relation types, original authorized HTTP path, measured ranking→admission→writer→claims→F3→whole-answer stages, byte-exact citations and UTF-16 replay, both false admissions and false abstentions, latency p95 and label blindness. Run multiple models under the **same** sampling plan and do not modify policy on the held-out responses.

## Private reproducibility (never commit source text, prompts or label file)

Under ignored `.work`:

- `s2-semantic-new-families-20261022/private-crossmodel-f3-relational-20261023/UNSCORED.json` SHA-256 `d94ed7cc1df16e7ad3970fd4781bf4af977ba3d146f1b2c6799bdca7d5a2cca0`; posthoc score `a0b4bcd6bfd8eb2a30b3781240d67c0e0c7acd351edfc7ce2cd34523fbd3df70`.
- `s2-semantic-new-families-20261022/private-actor-argument-contrast-20261023/UNSCORED.json` SHA `4cac346fa9621ab82d9bc3c3cc5cd16337cb9d685467a5a158231e3092ca0267`; posthoc score `80efa9b99f1b6210ca08dd8cf40f54bd30a5e761cafd2112231e904c38434789`.
- `s2-semantic-new-families-20261022/private-direct-onnx-two-models-v2-20261023/UNSCORED.json` SHA `601db811f7e9d3c56b09687d36a129b20a0e27432044deabf4d6348ce6822860`; score `ded9db0eaf0068f1bdb0f24cc8d15a27cf199adf307e04ed2db0147db7fa7b67`. The second ONNX mDeBERTa revision **could not load from the available local cache** and was not scored; do not count it as 16 inferences.
- `s2-mdn-new-family-20261023/RUN-MDN-NATIVE-WRITER-CROSSMODEL-V2/UNSCORED.json` SHA `ef1c11c412dd75c2995bace4ce684dcd1f07a20b3ea6653d72d717c07c61377b`; `RUN-MDN-CROSSMODEL-FULL-CLAIM-F3-V5/UNSCORED.json` SHA `a396b2452595d17dc295c06afd19ef56b1f6b016de8cab6ecec932bb90206e8c`; corrected posthoc score v2 SHA `2b1ace7ee998921d2c50bcb9fadd430f88eda80d7af2eabf0da69ca3e0b40c47` (earlier erroneous v1 score preserved separately).
- `s2-mdn-new-family-20261023/RUN-MDN-NLI-FULL-CLAIMS-DEV/UNSCORED.json` SHA `01daddfba5138ad721069ee4985812a878440842f32a52d9c81e4f1b561b9fa0`. This run uses previously projected full claims; those claims are **not themselves validated or independently scored**.

Model registry digests pinned at capture: Qwen2.5-7B `845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e`; Llama3.2-3B `a80c4f17acd55265feec403c7aef86be0c25983ab279d83f3bcd3abbcb5b8b72`; MiniLM revision `0a71e92a985b6e1ad1828cf67ce9c459639c1dca`. All files stay off Git.
