# S2 postcalibration evaluation — preregistration draft

**Status:** design only; **not frozen, not executed**. S2 remains OPEN.
Finalize and timestamp this protocol **before** collecting or inspecting new
evaluation questions. The public 48-question/288-passage fixture, post-hoc
rubric v1.1 and three reviewer files are **calibration**, not a blind holdout.

## Independent material and adjudication

1. Obtain newly authorized source documents and task questions from source
   authors/domains outside the public S2 corpus. Log consent/licensing, exact
   source SHA, unit locators, revision, vault scope and reviewer provenance.
   Do not publish sensitive source or task text in Git.
2. The coordinator freezes question order, source bytes, authorized scopes,
   language/answerability strata, evaluation settings, assignment seed and a
   SHA-256 manifest before any model observations or threshold adjustments.
   No translation/paraphrase of the original 48 questions may enter this set.
3. Two reviewers label explicit subject, relation direction, date, quantity,
   polarity, qualification and exact UTF-16 spans with the **same** rubric,
   frozen before review. The third reviewer resolves discrepancies; keep any
   consensus-control corrections separate. Blind reviewers to model output,
   other judgments and answerability stratum. Document how procedural
   independence was checked; distinct IDs are insufficient proof.
4. Keep review inputs, originals and adjudication append-only. Expose gold
   labels to scoring **only after** all reader/baseline decisions are fixed.

**Planning target (not statistical proof):** at least 240 questions: 60
answerable and 60 no-answer in each of EN/ES. Include several independent
sources per stratum, and negative types such as wrong subject, inverse
relation, missing value/date/units, negation and stale or unauthorized source.
Reassess sample size for source-level clustering before freezing. Never claim
that 240 alone guarantees narrow confidence bounds.

## Paired arms and data capture

| Arm                      | Fixed input                                                                      | Endpoints                                                                       |
| ------------------------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Manual Markdown/Obsidian | Same authorized vault and task                                                   | Correct completion/abstention, navigation/effort, elapsed time                  |
| AKP current              | Existing `queryKnowledge` with active configured admission                       | Candidate ranks, admitted/exploratory decisions, source quotes, errors, latency |
| Fixed reader comparator  | Exactly the same authorized AKP candidate pool                                   | Quote sufficiency and answerability under one pinned model                      |
| Full/compact context     | Same target answer model/task; full vault, full ContextPacket, selected passages | Exact tokens, grounded answers, citations, cost, task success                   |

- Pin PR SHA, database/index revisions, E5, reader and tokenizer versions,
  prompts, timeout, candidate limits and budgets. Randomize paired arm order,
  document cache warmup and count provider calls/timeouts.
- Use the **opt-in** `s2AdmissionShadowSink` of `buildServer` to observe the
  actual `/v1/search` and `/v1/context` admission paths. The observation
  contains query and scoped-source digests, active-versus-shadow verdict,
  abstention, excerpt-relative UTF-16 span/hash and **admission-only** timing.
  It contains neither gold labels nor source/query text. Digests remain
  pseudonymous: control access to trace files and their join keys.
- A separate authorized evaluator must rebind each captured excerpt digest,
  source unit and offset to the _original immutable source bytes_ and ACL/
  revision before scoring a quote. An excerpt-valid span is not necessarily a
  source-valid citation. Reject ambiguous joins, surrogate splits and stale
  revisions. Preserve every reason for rejection.
- Record full request/answer elapsed times independently: admission p95 is
  **not** request p95. Record real model input tokens with one fixed tokenizer;
  never estimate using character ratios. A `VERIFIER_SHADOW` judgment must not
  be counted as what the application actually admitted.

## Prespecified endpoints and decisions

1. Semantically sufficient and source-exact admitted citations / all admitted
   citations, plus **separate** strict exact-gold-span coverage proxy.
2. **FAR:** no-answer questions with at least one _application-admitted_
   source passage / all independently adjudicated no-answer questions. Report
   query counts and distinguish false admission from wrong answer.
3. Grounded answer correctness and justified abstention, with blinded paired
   judgments and task-completion comparison against Obsidian/manual.
4. ES/EN and source-cluster-stratified recall, precision, FAR, p50/p95 full
   request latency, admission latency, degraded calls, model tokens and cost.
5. ACL/revision leakage, wrong-source citations and protocol deviations as
   explicit blocking failures, not blended into mean recall.

Report Wilson95 only as a **simple binomial diagnostic**; also compute an
interval accounting for language and source clustering. A raw 0/N FAR does
not establish zero generalization risk. Do not alter thresholds based on the
new holdout.

The provisional gate remains citation precision >=0.80 with simple Wilson95
lower >=0.70 plus defensible stratified uncertainty; FAR <=0.10 and no worse
than baseline; full-request p95 <=25 s; degraded calls <=5%; no downstream
answer/task regression. **No endpoint has passed this holdout.** E5 stays
shadow; S3–S5 remain blocked; PR #38 stays OPEN/DRAFT/unmerged.

## Still missing

- [ ] Freeze new manifest and check source/reviewer independence
- [ ] Independently adjudicate all positive and negative cases
- [ ] Run real configured semantic reader and source-rebound quote checks
- [ ] Collect full-response latency, answer outcomes, actual tokens, errors
- [ ] Execute paired manual/Obsidian benchmark and stratified analysis
- [ ] Verify CI and independently audit S2 gate on exact final SHA
