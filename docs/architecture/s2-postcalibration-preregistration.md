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
  revisions. Preserve every reason for rejection. The evaluation-only CLI in
  `s2-authorized-source-rebinding.md` supports this byte-exact join, but its
  internal hash checks alone **cannot authenticate the external source freeze**.
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

## Historical X/Y review packet disposition (2026-10-27)

The existing 127-case X/Y packets were frozen on October 26 from a **source-supplied
Reader v5 capture of 261 historical queries**. They test the correctness of
individual model-proposed reader answers, not the subsequently composed
E5 → authenticated LAYERED → original SOURCE → ContextPacket → Writer pipeline.
Both remain `PACKETS_VERIFIED_UNREVIEWED` without any external human labels.

Those historical packets are **optional developer calibration/forensics,
not a prerequisite or substitute for the prospective S2 release gate**.
Preserve their original hashes, private case map, salts and empty reviewer
submissions unchanged; do not retroactively mark them reviewed, use them as
new holdout gold or base a new default model policy on their familiar cases.

After the integrated candidate version, full natural-language question/claim
proof contract, authorization chain and observable Writer outputs stabilize,
prepare **new independent X/Y or equivalent blinded packets** covering
source-family-disjoint EN/ES questions, genuine no-answer cases, and actual
admitted versus withheld citations and complete Writer answers. Freeze the
independent SOURCE/questions, original bytes and adjudication rubric **before
running or inspecting the model outputs**. The two reviewers must evaluate
the same frozen protocol; a third resolves disagreements without tuning the
gold to the model's answer. New packets can be prepared in parallel with
engineering readiness but must not be chosen post hoc from only successful
answers. Human review may then begin; no human review is claimed today.

This is a scheduling and validity clarification, **not a relaxation** of
precision, FAR, ACL/freshness, latency or independent adjudication requirements.

## Still missing

- [ ] Freeze new manifest and check source/reviewer independence
- [ ] Independently adjudicate all positive and negative cases
- [ ] Run real configured semantic reader and source-rebound quote checks
- [ ] Collect full-response latency, answer outcomes, actual tokens, errors
- [ ] Execute paired manual/Obsidian benchmark and stratified analysis
- [ ] Verify CI and independently audit S2 gate on exact final SHA

## Controlled S2 private review export (development only; §99)

There is now a bridge for **previously unreviewed questions** evaluated on genuine previously reviewed original SOURCE, without treating the old approved question as a gold label for the new one. This is not the preregistered 240-question source-family-disjoint holdout.

- The server must explicitly opt in to `AKP_S2_REVIEWED_SOURCE_ENABLED`, `AKP_S2_ATOMIC_WRITER_EVAL_ENABLED`, `AKP_S2_SOURCE_ANCHORED_SHADOW_ENABLED`, and `AKP_S2_PRIVATE_SHADOW_REVIEW_CAPTURE_ENABLED`, and inject a private trusted `s2PrivateShadowReviewSink` into `buildServer`. A capture is supplied **only after** the current actor, vault, context packet, approved original-SOURCE proof and model structured-output validations pass. Do not connect this callback to generic telemetry, logs, an external service, published Git, or shared storage.
- An explicitly authorized operator collects the resulting **full private samples JSON** and records a SHA-256 text pin in a separate private path. These samples include original SOURCE and Writer answers: imported vault access and export permissions must be separately confirmed; keeping the source hash does **not** grant permission to redistribute the bytes.
- From a restricted private directory **outside** the repository, run:
  `pnpm exec tsx scripts/s2-export-private-unseen-review.ts --samples C:/private/s2/samples.json --pin-file C:/private/s2/samples.sha256 --output-dir C:/private/s2/review-run-unique`
  The output directory must not preexist. The tool verifies the sample pin, exact SOURCE hash/UTF-16 span, frozen case IDs, Writer claim text coverage and citation keys. It emits only counts and hashes to stdout, and writes two separately shuffled `source-review-X.json` / `source-review-Y.json` reviewer packets with **no Writer answers and all truth fields blank**.
- Never send `private-writer-answers-NOT-FOR-SOURCE-REVIEWERS.json` or `private-custodian-receipt.json` to source-answerability reviewers. The private response file is held by the authorized custodian until the **source-only judgments are independently frozen**. Native Windows file modes alone do not prove NTFS ACL privacy; grant only required reviewers access to their own packets.
- Assign independent reviewers outside the engineering/model team, verify identity and independence externally, review with whole authorized source context for genuine no-answer, adjudicate differences, then perform a separate full Writer answer/statement review. **Do not** mark these model-exposed development cases as prospective blind acceptance gold. For the final gate, source-family-disjoint sources and questions must be independently selected and **frozen before the first model run**, with the established 240-question EN/ES protocol, human judgments, paired baseline, tokens, full HTTP p95 and FAR with uncertainty.

There is deliberately no automatic runtime publication, admission override, SOURCE object export, reviewer-result fabrication, or private-file persistence side effect from an ordinary HTTP request.

## External custodian intake → frozen independent review → paired metrics (§100)

Use the existing unfilled coordinator kit `%LOCALAPPDATA%/Temp/AKP_S2_PROSPECTIVE_20261028_2027/external-custodian-240-prep-001`. Its SHA-256 proves only the BLANK template. The external custodian selects previously unseen and appropriately licensed publisher/source families and independently writes all 240 question+original SOURCE records, keeping the allowed vault/path scope, full original UTF-8 files and SHA-256 under a private `source-root/Fnn/<relativePath>` tree. Keep all raw source/case/gold/identity data **outside** Git.

After externally recording the SHA-256 of a completed `filled.csv` and a separate, complete development-publisher denylist, run the pre-inference structural preflight (PowerShell example):

```powershell
pnpm exec tsx scripts/s2-preflight-external-intake.ts `
  --template C:/private/s2/template.csv `
  --template-pin C:/private/s2/template.sha256 `
  --filled C:/private/s2/completed.csv `
  --filled-pin C:/private/s2/completed.sha256 `
  --source-root C:/private/s2/originals `
  --denylist C:/private/s2/prior-dev-publishers.json `
  --denylist-pin C:/private/s2/prior-dev-publishers.sha256 `
  --output C:/private/s2/NEW-intake-preflight.json
```

A successful output of `STRUCTURALLY_COMPLETE_UNADJUDICATED_NOT_FROZEN` verifies 240 seat/source identities and original byte spans **only**. It does not prove real rights, upstream Git provenance, the completeness of the DEV denylist, true answerability, reviewer identity or independence. Next apply the existing external Ed25519 verifier `scripts/s2-verify-external-holdout-freeze.ts` with **out-of-band** key fingerprint and sealed assignments BEFORE any Writer query; then conduct X/Y blind source-only review, Z adjudication, and a separate atomic Writer full-answer review. Do not disclose `ownerSuggestedGoldKeepPrivate`, `targetStratum`, model text or the private arm map to reviewers.

Once original, frozen and independently reviewed cases AND actual paired HTTP observations from both arms exist, run the separately private diagnostic scorer:

```powershell
pnpm exec tsx scripts/s2-score-private-paired-arms.ts `
  --cases C:/private/s2/paired-source-reviewed-observations.json `
  --pin-file C:/private/s2/paired-source-reviewed-observations.sha256 `
  --output C:/private/s2/NEW-paired-metrics.json
```

This tool accepts the same case IDs for `DETERMINISTIC` and `CANDIDATE`, never requests a model or invents labels, and reports source-exact citation precision, full-answer correctness, unjustified abstentions, FAR, p95, degraded-call ratio and language/source-family diagnostics. Its leave-one-family-out results are **sensitivity checks, not a cluster-aware CI**; independent acceptance requires an externally auditable design-aware interval and all S2 gates. Scoring output is ALWAYS nonrelease. The separate 240-case synthetic fixture run is marked as synthetic and must never be treated as a reviewed holdout.

Until the external custodians supply real new/source-disjoint original files and blinded gold, it would be dishonest to report measured independent precision, FAR, p95 or a no-regression decision. Both default retrieval policy and S2 milestone remain unchanged.

## §102 pre-inference external X/Y SOURCE-only packet generation

**Only after** an external independent custodian supplies a correctly completed, separately pinned 240-case original-source intake, invoke the §100 private `scripts/s2-preflight-external-intake.ts` CLI with its existing eight required path flags **and** `--review-output-dir C:/private/s2/unique-blank-reviewed-packets`. The output directory must not already exist. The procedure performs the same read-only source identity verification then writes `SOURCE-ONLY-reviewer-X.json`, `SOURCE-ONLY-reviewer-Y.json` and `COORDINATOR-ONLY-NOT-FOR-REVIEWERS.json` under that new private directory. The two reviewer files contain the same questions and originals, independently randomized, with all semantic gold, negative whole-corpus confirmation and model outputs blank; do **not** share the third map or the original filled coordinator CSV with reviewers. The HMAC shuffle salt, assigned case keys, human identities, original source text and all private custodian files must remain outside the PR and general logging. On Windows, process-level `mode:0600` is not an independently validated NTFS ACL—reviewer-specific permissions, identity verification and source-use authorization must be arranged explicitly.

This is a **pre-inference** reviewer branch, unlike the distinct §99 output-dependent developer-review tool. X and Y must seal their SOURCE-only responses independently, and Z adjudicates after both submitted; a false/no-answer label requires verifying the **whole authorized source universe**, not just a designated passage. The custodian must independently freeze all rights, gold, case/source families, reviewer assignment hash, SHA and Ed25519 signing trust anchor before releasing prompts to the model. No Writer/model request has been triggered by this CLI.

When complete raw independent judgments and actual paired HTTP receipts are available, the §100 paired scorer reports an additional exploratory EN/ES-balanced whole-family percentile bootstrap for precision, FAR and correct responses, with sensitivity to paired regression. With fewer than eight families it refuses to present an interval. These are descriptive diagnostics, **not a preregistered calibrated coverage guarantee or an independent human verdict**. The release gate requires external statistical review and real measures; a synthetic 240-case test-run is not evidence of semantic acceptance.

## §103 receiving and adjudicating separately frozen prospective SOURCE-only X/Y reviews

External reviewers independently complete their private `SOURCE-ONLY-reviewer-X.json` / Y assignments, without sharing proposed target stratum or seeing the Writer. Their independent **submissions** must conform to `akp.s2.preinference-review-submission.v1`: `reviewer`, their original `packetSha256`, and an exhaustive set of case-level `reviewCaseKey`, `sourceAnswerability`, `reviewerAnswer`, `supportingQuoteSpans`, `wholeAuthorizedCorpusAbsenceChecked`, and `reviewerNotes`. Do not overwrite the pre-inference task packets: submissions are separate, pinned immutable files. Answerable citations require original `sourceKeySha256`, exact original text and UTF-16 start/end, not a paraphrase. A no-answer verdict requires independently recording the source universe searched; the `wholeAuthorizedCorpusAbsenceChecked` boolean by itself **does not prove** completeness.

After recording packet X/Y SHA pins and the separately submitted X/Y SHA pins under external custodial authority, execute `pnpm exec tsx scripts/s2-audit-prospective-source-review.ts` with `--packet-x`, `--packet-x-pin`, `--packet-y`, `--packet-y-pin`, `--submission-x`, `--submission-x-pin`, `--submission-y`, `--submission-y-pin`, and `--out-dir`, pointing exclusively to private, authorized paths outside Git. This auditor enforces exact complete X/Y coverage, source revision/scope equality, SHA-bound packet/answers, positive SOURCE quotes and explicit negative full-corpus-check assertions, refuses invalid labels and emits two private files: `PRIVATE-source-review-receipt.json` and `SOURCE-ONLY-Z-disagreements.json`. Z gets only unresolved original questions/SOURCE and no X/Y conclusions, for independent adjudication. Neither consensus nor a signed SHA is sufficient to authenticate reviewer independence or SOURCE rights.

Do NOT distribute the receipt, original X/Y submissions, custodian stratum map or all sources to unauthorized parties; audit and enforce reviewer-specific NTFS permissions outside the code. The output intentionally has `sourceGoldCertified:false` and `releaseGateAccepted:false` until an external identity/authority, Z adjudication, whole-vault original SOURCE scope, signed freeze and complete Writer review exist. Historic 200 DEV/author-exposed corpora and 240 synthetic-only tool validation outputs are ineligible as real gold. The core S2 end-to-end semantic precision, FAR, p95 and no-worse-baseline gates remain open.
