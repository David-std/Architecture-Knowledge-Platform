# AKP PR #38 — S2 continuity checkpoint (2026-10-17, America/Bogota)

## Verified parent state

- Repository: `David-std/Architecture-Knowledge-Platform`, draft PR #38,
  `chore/retrieval-generality-policy` -> `develop`.
- Parent commit: `95b691059f4eaa4e2a52d2ad278985340f5da511`.
  At inspection, PR was OPEN, DRAFT, unmerged, and 14 required workflows were
  successful on this parent SHA. Optional workflow dispatches marked `skipped`
  must not be counted as successful executions.
- S0/S1 closed. **S2 OPEN**; E5 shadow; S3-S5 blocked. No release/merge or
  provider-default promotion is authorized.

## Official reviewer adjudication CLI: executed, no labels committed

The external handoff `AKP_PR38_HANDOFF_FINAL_S2_2026-10-17.zip` was extracted
locally. The official, repo-sourced Node.js CLI was run on the exact original
packet, both 288-row submissions and the 155-row dispute-only submission:

```sh
node scripts/validate-s2-adjudications.mjs --self-test
node scripts/validate-s2-adjudications.mjs \
  --packet "$HANDOFF/01_entradas/paquete-congelado-fd2645f7.json" \
  --packet-sha256 fd2645f75713389d89492128027bb02a618b2a383774341d6d4fd74deb8d1daa \
  --reviewer-a "$HANDOFF/01_entradas/revisor-a-original-288.csv" \
  --reviewer-a-id reviewer-a \
  --reviewer-b "$HANDOFF/01_entradas/revisor-b-original-288.csv" \
  --reviewer-b-id reviewer-b \
  --resolution "$HANDOFF/03_resultados/s2-tercera-revision-155.csv" \
  --adjudicator-id reviewer-c \
  --output "$HANDOFF/../official-third-validation.json"
```

`HANDOFF` denotes the fully extracted ZIP root; the path is deliberately
external to the repo. The CLI self-test passed **17 mutation cases**, including
six frozen-source binding mutations. The official adjudication output was:

| Field                                 | Verified value                                       |
| ------------------------------------- | ---------------------------------------------------- |
| `sourceBinding.sourceBoundCandidates` | 288/288                                              |
| `agreement.reviewedPairs`             | 288                                                  |
| `agreement.matchingLabels`            | 143                                                  |
| `agreement.disagreements.length`      | 155                                                  |
| `disputeResolution.resolvedPairCount` | 155/155                                              |
| `disputeResolution.status`            | `THIRD_SUBMISSION_VALIDATED_HUMAN_ORIGIN_UNVERIFIED` |
| `reviewerIndependenceVerified`        | `false`                                              |
| `admissionMeasured` / `gateAccepted`  | `false` / `false`                                    |
| `falseAdmissionRate`                  | `null`                                               |

Official JSON output SHA-256:
`d1a6759be7c07e3e46de84eaf9a09d1bf05ba2ffccb01ac52cbba93f5329ca2d`.

The handoff's reproduction script recreated all five derived files byte for
byte, compared with `cmp`. The **three consensus controls were not passed to
`--resolution`**, because only the actual disputes belong there. The external
adjudicated reference remains 24 ANSWERS, 33 RELATED_NOT_ANSWERING, 231
INSUFFICIENT and 0 CONTRADICTS, with 130 initial consensuses, 155 dispute
resolutions and three separately corrected post-hoc controls. These labels
remain external and have **not** been imported as runtime input or as an
independent accuracy benchmark.

## New code (instrumentation, not quality evidence)

- `apps/api/src/s2-admission-shadow.ts` builds redacted records from the
  application **after** it has made its real candidate admission decision.
  It separates actual admitted candidates from shadow verifier diagnostics,
  checks excerpt-relative UTF-16 offsets/surrogate boundaries, hashes source
  and query identities, and redacts non-code free-form reader reasons.
- Both `/v1/search` and `/v1/context` can notify an explicitly injected,
  best-effort sink; `buildServer` exposes that opt-in dependency. Missing or
  failing observers cannot change results, and no sink is registered by
  default. This is not a new reader or an admission policy change.
- Added focused tests for exact quote hashes, shadow/active policy separation,
  invalid offsets, unscoped candidate rejection, reason redaction and
  observer failure isolation. Added a **draft**, not-yet-frozen independent
  postcalibration protocol. No new holdout claims or model calls are implied.

## Local verification of this change

- `pnpm --filter @akp/api typecheck` and `build`: PASS.
- API unit suite: **97/97 PASS**, including the new shadow tests.
- `pnpm docs:validate`: PASS; `pnpm hygiene:validate`: PASS after
  mechanically regenerating the file classification for added files.
- `pnpm retrieval:generality:validate`: PASS; `pnpm boundaries`: PASS.
- Formatter/diff validation: PASS. The local dependency install used pinned
  lockfile and an offline `--ignore-scripts` retry because ONNX Runtime's
  NuGet binary host could not resolve; no local real-model test is claimed.

**Remote same-SHA CI must be checked on the new commit independently.** Passing
these local checks does not demonstrate reader semantic precision or acceptance.

## Remaining S2 work (do not infer results)

1. Freeze genuinely independent EN/ES holdout sources/questions and their
   preregistered evaluator rubric **before** measuring; require separate
   blind adjudication with provenance and source cluster analysis.
2. Inject `s2AdmissionShadowSink` into an authorized run of the actual
   configured semantic reader. Persist observations securely and rebind
   excerpt-relative quotes to immutable source bytes and ACL/revision.
3. Measure task-level grounded final answers, justified abstentions, FAR,
   precision and intervals by language/source cluster; distinguish full
   request p95 from admission-only timing and report provider errors.
4. Perform paired Obsidian/manual, full/compact ContextPacket and fixed-reader
   comparisons with exact pinned model tokens and no use of gold in readers.
5. Audit every provisional gate independently before proposing S2 closure.
   Keep PR OPEN/DRAFT, E5 shadow, S3-S5 blocked and **NO MERGE**.

## S2 source-rebinding continuation — 2026-10-18 (not acceptance)

The next commit adds an evaluation-only authorized source-rebinding audit:

- `apps/api/src/s2-source-rebind.ts` joins the redacted **actual application**
  admission record to an externally supplied source-unit snapshot using
  hashed vault/document/unit/revision/excerpt identities. It checks UTF-16
  surrogate boundaries and exact SHA-256 quote bytes, rebases a uniquely
  located excerpt into original-unit offsets, and fails closed on a foreign,
  stale, ambiguous or inconsistent source. Reader/shadow-only spans are never
  counted as admissions.
- `scripts/s2-rebind-admission-shadow.ts` consumes separately protected,
  explicit run and source-snapshot JSON; writes a redacted per-candidate
  outcome report. Its digest checks **do not independently authenticate** the
  claimed source-manifest freeze. The report explicitly leaves semantic
  precision, FAR, final answers, full-request p95 and S2 acceptance unmeasured.
- `docs/architecture/s2-authorized-source-rebinding.md` specifies the exact
  private input contracts, invocation, status codes and boundaries; no private
  sources, reviewer labels or traces are committed.
- Synthetic unit tests cover source-byte and UTF-16 rebinding, absent/repeated
  excerpt, changed identity and revision, tampered quote digest and shadow vs
  application admission. This closes an **instrumentation/verification gap**,
  not the independent real-reader experiment.

The earlier parent confirmation of `77eda6e5e0069373eddd3da9ac036911c21013dc`
showed PR #38 still OPEN/DRAFT/unmerged. Record the final commit SHA and its
same-SHA workflow result **separately** after publishing this continuation;
do not inherit a green badge from a prior SHA.

## S2 real-reader local continuation — 2026-10-18 (exploratory)

The live-model measurements below are **engineering evidence, not S2 gate
acceptance**. The target application commit before this continuation was
`6b458a57c5fa65b999eaf3177ade1cfb10493a24`; GitHub confirmed 14
required workflows completed successfully and nine optional ones skipped.
PR #38 remained OPEN/DRAFT/unmerged.

### Existing family-disjoint, synthetic 7B diagnostic

A previously frozen (2026-10-06), author-constructed 24-question experiment
was executed on the authorized Windows workstation at experimental commit
`8f4416c1e76a123e64518680639610f4e197ac8f`, **not on the PR HEAD**:

- Local NVIDIA RTX 4050, Ollama `qwen2.5:7b-instruct`, Q4_K_M, observed
  deployment digest
  `845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e`,
  context length 4096, temperature zero, reader prompt `evidence-reader-v4`.
- Pinned BGE `onnx-community/bge-reranker-v2-m3-ONNX` revision
  `6f5ff65298512715a1e669753bc754d2bc8f367b` only ordered candidates.
- 17 answerable / 7 no-answer: reader answerable admission recall 15/17,
  precision among admitted 15/15, false admissions on negatives 0/7,
  strict question-level success 22/24; legacy deterministic comparator
  recall 5/17, one false acceptance on seven negatives.
- The reader-only admission latency p95 was 6,799 ms; this is **not** the
  complete `/v1/search` request or generated-answer latency.
- A simple Wilson95 interval is about [0.796, 1] for 15/15 and [0, 0.354]
  for 0/7. These cases are synthetic and the original human review cannot
  make their model evaluation independent. The old experiment's
  `PROMOTE_TO_PRIVATE_FRESH_E2E` status did **not** promote any production
  setting or authorize S2 closure.

Full report SHA-256:
`d2ad30460ab99855383fa62f1c39570a4d0170dbf99efd81e6a9d5c05a483b97`.
It remains in the workstation's ignored `reports/ci` directory, outside
the official independently adjudicated S2 corpus.

### Actual authenticated API observation in an isolated database

At the exact PR parent commit above, a **local opt-in** integration runner
now exercises `/v1/search` through real token authentication and vault
authorization, PostgreSQL 16/pgvector, scoped E5 vector search, the
runtime-configured `LAYERED` Qwen 7B evidence reader and the
`s2AdmissionShadowSink`. The runner uses the same frozen 48-question
public **calibration** projection (24 answerable / 24 no-answer, EN/ES),
not a postcalibration holdout. It sends **no gold labels** to the reader.

The test-only PostgreSQL container uses an obviously disposable
`akp_s2_test` database; all 92 migrations were applied. Its source
snapshots come from the frozen Git blob
`a61a24df46c0351115cd09e079ae0d8383033082`; each redacted
admission trace is rejoined by vault, document, unit and revision to the
exact immutable synthetic source text, and each admitted UTF-16 span must
rebind without fabrication. No production E5 activation was performed.

An initial three-question pilot run passed 3/3 authenticated requests,
observed two admissions with two exact source-rebound spans and no
unrebound admitted span. Full request p95 was 27,531 ms, driven by the
first request at 27,531 ms versus 12,735 and 12,137 ms afterward. All
three were positive cases, so its negative-question FAR is **NULL**.
The initial workstation test ran on Node 25.2.0 although the repository
requires Node 24; authoritative portability needs a Node 24 rerun.

### Complete paired 48-case API observation (Node 25 exploratory pass)

The full request path was executed for all 48 fixed questions through
`Fastify.inject`, authenticated with an isolated test principal, against
the four authorized disposable vaults. Each mode used the same source
projection, E5 activated only within the fixture and six scoped retrieval
candidates per question. Results were recorded only after each active
application decision:

| Diagnostic                                                  | Deterministic admission | LAYERED Qwen 7B |
| ----------------------------------------------------------- | ----------------------: | --------------: |
| Positive questions with an admission, English               |                    8/12 |           11/12 |
| Positive questions with an admission, Spanish               |                    0/12 |           11/12 |
| Negative questions with a false admission, English          |                    4/12 |            0/12 |
| Negative questions with a false admission, Spanish          |                    0/12 |            0/12 |
| Total admitted candidate passages                           |                      13 |              23 |
| Admitted passages with original-source UTF-16 quote rebound |                       0 |              23 |
| Admitted passages lacking a reader span                     |                      13 |               0 |
| Full authenticated search request p95                       |                5,754 ms |       13,133 ms |
| Observed degraded query rate                                |                    0/48 |            0/48 |

The four negative deterministic admissions are **real application decisions**
under this fixture. The generic `scoreS2SpanObservations` scorer saw no
deterministic `admitted[]` quotes and therefore misleadingly returned a
zero quote-based FAR; the correct query-level numerator comes from
`S2AdmissionShadowObservation.admittedCandidateCount`: **4/24**. The test
harness now reports raw application FAR separately and suppresses the
inapplicable span-scorer FAR field.

All 23 LAYERED admitted spans rebound exactly to source bytes. However,
only **7/23** literally enclosed a strict designated gold quote. This is
a narrow exact-gold-span proxy, **not** a semantic precision measurement:
neither the remaining 16 spans nor the 7 matches have been independently
adjudicated as sufficient answers. The reader admitted at least one
passage for 22/24 positives; two positives were abstentions. Source-unit
candidate Recall@1 was 24/24 under the preexisting E5 fixture, separate
from answerability and quote sufficiency.

The source-rebound reader report SHA-256 was
`4254d77bee0e8e88611532600b21cbc836154d41685f4e13ba299e6ba0df4332`;
the deterministic report SHA-256 was
`15782e12d0ce65ad74eb28e132b83a374abcb685d7ff71a3b9d0d7eb22fb0335`.
Both are ignored local reports, **not committed as benchmark truth**.
They came from Windows Node 25.2.0, outside the repository's Node 24
engine requirement. Sequential warm/cold cache, one synthetic source per
question, test-only LAYERED activation and absent manual task completion
preclude deployment extrapolation.

Follow-up: replayable hashed observation batches and authorized source
snapshots are being added to the opt-in harness for use with the official
`s2-rebind-admission-shadow.ts` audit, and Node 24.20.0 is being tested
with `pnpm@10.34.5`. Full final answer generation is still unmeasured.

### Pinned Node 24 real-reader replay and offline human-calibration join

Using an isolated portable `node.exe` reporting v24.20.0 and the repo's
`pnpm@10.34.5`, the complete LAYERED experiment repeated **48/48** routes
on the same PR SHA. The observed reader again admitted 23 source-rebound
spans and zero of the 24 negative questions. Full search request p95 was
13,155 ms; the same 48-case source unit Recall@1 remained 24/24. The
separately executed official source-rebinding CLI accepted all 48 redacted
observations and 48 authorized snapshots, checking all 23 admitted spans.
The authoritative **Node 24** LAYERED report SHA-256 is
`f68e213ad24926056f3e32fce62e1db9f38947fbbf245dd8475cd7a4b609ffdc`
and its source-rebinding audit SHA-256 is
`ebffe4c73f241e052724a1e90e653ed50ce51eb7ecd75beefabf71f1d04da3bf`.

The local Ollama OpenAI-compatible endpoint supplied actual model usage
for **154 reader calls**: 77,744 prompt tokens, 5,850 completion tokens,
83,594 total. These are provider-reported **reader** tokens, not target
answer-model tokens, not per-task full-context token savings, and not a
paired Obsidian/manual comparison.

The same Node 24 environment then ran the **deterministic** API mode on
48/48 questions. It made 13 passage admissions and falsely admitted on
4/24 negative questions; eight of the 24 positive questions had a passage
marked `ANSWERS` in the provisional human reference. Its full authenticated
search request p95 was 6,609 ms. Since deterministic admission does not
emit reader-selected source spans, the official source-rebinding CLI
correctly reported 13 admitted passages with **zero** reader spans
rebound, not 13 false source citations. The final deterministic report
SHA-256 is
`5dcbc67ff54b1d76f5246fe8fbacd5f2daea93e249cbee6a6a24f3c85f6280d6`;
its source-rebinding audit SHA-256 is
`32c5ca1e298a0c6402ec12b0bf1a6d51aa18c6ad560fa00e9f0967adde8b0ebe`.

After the reader run had finished, a separate offline script joined the
source-bound observations to the external 288-pair human **provisional
calibration reference**, keyed by question and passage SHA-256. It verified
**288/288** matches and the fixed reference distribution
(24 `ANSWERS`, 33 `RELATED_NOT_ANSWERING`, 231 `INSUFFICIENT`,
0 `CONTRADICTS`). Of the 23 application-admitted passages, 22 carried a
provisional human `ANSWERS` label and **one** a human
`INSUFFICIENT` label (Spanish, optical-observatory source family).
This is **22/23 passage-category calibration agreement**, not independent
source-span sufficiency or deployable precision.

All 22 admitted `ANSWERS` passage spans overlapped the selected human
quote; **only 1/22 enclosed the entire human quote**. In parallel, the
different strict designated-gold containment proxy found **7/23**. Both
are byte/interval alignment diagnostics; neither certifies nor disproves
semantic sufficiency without a fresh blind quotation review. The local
calibration join report SHA-256 was
`9aea24cc0ceccd0c362cb4474e5779b0612a934af0db4f70a452049e416400f7`.
It explicitly marks human independence unverified and `gateAccepted=false`.
The deterministic calibration join matched all 288 pairs too, finding
8/13 admissions labeled `ANSWERS` and **5/13 not answering**
(four `RELATED_NOT_ANSWERING` and one `INSUFFICIENT`); its SHA-256 was
`0c56405ce023b180c6bd2dd1fdf24d29cf76ea9cad8d49e4553647973d9af0e6`.
The single LAYERED `INSUFFICIENT` admission occurred in synthetic case
`s2-optical-observatory-p06`, an exposed Spanish calibration item.

**Interpretation:** in this test-only mode the reader reduced the observed
no-answer false admission numerator relative to the deterministic baseline
and improved Spanish passage admission, but it still overadmitted one
`INSUFFICIENT` passage and often chose shorter source quotations than the
human-calibrated selections. S2 is **OPEN**. Do not tune to those exposed
questions or promote a runtime default from this measurement.

### Reproducing the opt-in local application study

Requirements: a **separate disposable** PostgreSQL/pgvector database with
all migrations, local pinned multilingual E5 cache and Ollama/Qwen 7B. Never
run the synthetic writer against a private/operator database. The test
database name must contain `test`, `e2e`, `ci` or `benchmark`; do not
disable the repository's database-safety check.

```sh
export DATABASE_URL='<disposable postgres URL with *_test database name>'
export NODE_ENV=test
export AKP_S2_BRANCH_HEAD_SHA="$(git rev-parse HEAD)"
export AKP_S2_LIVE_ROUTE_OBSERVATION=1
export AKP_S2_LIVE_ROUTE_MAX_CASES=48
export AKP_S2_LIVE_ROUTE_EXPECT_MODE=LAYERED
export AKP_VECTOR_ENABLED=true
export AKP_EMBEDDING_PROVIDER=local-multilingual-e5
export AKP_LOCAL_FILES_ONLY=1
export AKP_EVIDENCE_VERIFIER_LOCAL_FILES_ONLY=true
export AKP_EVIDENCE_VERIFIER_PROVIDER=cross-encoder-reader
export AKP_EVIDENCE_VERIFIER_MODE=LAYERED
export AKP_EVIDENCE_READER_BASE_URL=http://127.0.0.1:11434/v1
export AKP_EVIDENCE_READER_MODEL=qwen2.5:7b-instruct
export AKP_EVIDENCE_READER_TIMEOUT_MS=60000
export AKP_EVIDENCE_ADMISSION_TIMEOUT_MS=60000
pnpm --filter @akp/api exec vitest run \
  test/s2-source-span.integration.test.ts \
  -t 'records source-rebound reader admissions'
pnpm exec tsx scripts/s2-rebind-admission-shadow.ts \
  --observations reports/ci/s2-live-route-layered-observations.json \
  --sources reports/ci/s2-live-route-layered-authorized-sources.json \
  --output reports/ci/s2-live-route-layered-rebound-audit.json
# Only AFTER the reader has finished, score the external provisional human
# calibration labels. The reference must never become a reader input:
node scripts/s2-score-calibration-admissions.mjs \
  --observations reports/ci/s2-live-route-layered-observations.json \
  --rebound reports/ci/s2-live-route-layered-rebound-audit.json \
  --reference /authorized/handoff/s2-provisional-calibration-reference-288.jsonl \
  --cases evals/registered/s2-source-span-holdout.json \
  --output reports/ci/s2-live-route-layered-calibration-join.json
```

For the fixed deterministic comparison, change
`AKP_S2_LIVE_ROUTE_EXPECT_MODE=DETERMINISTIC`,
`AKP_EVIDENCE_VERIFIER_PROVIDER=disabled` and
`AKP_EVIDENCE_VERIFIER_MODE=SHADOW`. The route's active admission is then
deterministic, not a shadow reader verdict. Output files are named by
`layered` or `deterministic` and kept in ignored `reports/ci`. The
`*-authorized-sources.json` files contain **raw public fixture text** and
queries and should remain access-controlled, uncommitted and out of logs.
The `*-observations.json` files are pseudonymous, not anonymous.

The separately invoked source-rebinding CLI must match `runId`, commit,
query/scope, source bytes and UTF-16 offsets; it reports the exact number of
rebound spans and explicitly sets `sourceProvenanceExternallyVerified=false`.
Ollama OpenAI-compatible `usage` counters can be observed for reader calls,
but these do not supply target-agent final-answer tokens or a full-vault
token-savings comparison.

**Still OPEN:** new independently sourced and blindly adjudicated EN/ES
holdout; semantic quote-sufficiency review; final grounded answers and
abstentions; exact target-model tokens; manual/Obsidian paired baseline;
representative complete-response p95, degradation, ACL/revision and source
cluster analysis. All S2 gate decisions remain unaccepted. E5 stays shadow;
S3-S5 are blocked; PR remains OPEN/DRAFT with **NO MERGE**.

### Paired local answer-generation continuation (2026-10-18, diagnostic only)

After the live `/v1/search` admission decisions and source-rebound traces were
fixed, two **separate evaluation-only** Node.js CLIs exercised a downstream
answer generator against the same 48 author-crafted, public synthetic
calibration questions. `scripts/s2-paired-answer-generation.mjs` strictly joins
the already captured observation hashes, authorized source snapshots, frozen
Git blob `a61a24df46c0351115cd09e079ae0d8383033082`, and the upstream
route report. It fails closed if scope, original source bytes, candidate IDs,
admission flags or UTF-16 citation hashes disagree. It never imports human
adjudication labels or author-provided answerability into the generation
prompt. It keeps raw questions and generated answers in ignored local
`reports/ci` files, not Git.

Each question was answered twice using the **same** local Qwen2.5 7B model,
with deterministic alternating order based on query SHA parity:

1. `FULL_POOL`: all six already retrieved, authorized source units, **not**
   an entire private Obsidian vault.
2. `ADMITTED_SPANS`: only the source-exact UTF-16 excerpts actually admitted
   by the application in the prior `LAYERED` run; zero admissions means no
   evidence supplied.

Both arms used the same source-only JSON answer/abstain instruction,
`temperature=0`, seed `1317`, maximum 160 generated tokens and JSON-object
response format. Local Windows Node `24.20.0`, Ollama
`qwen2.5:7b-instruct` digest
`845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e`;
requests went only to loopback `127.0.0.1:11434`. The reported prompt and
completion tokens are **Ollama usage counters for the submitted messages**,
not approximations derived from character lengths. This is a local simulated
answer-writer continuation, **not an AKP product final-answer endpoint**.

| Same 48 paired questions, final `SRC` replay             | Full retrieved pool | Source-bound admitted spans |
| -------------------------------------------------------- | ------------------: | --------------------------: |
| Actual model calls                                       |                  48 |                          48 |
| Mean provider-reported prompt tokens                     |              320.71 |                      140.04 |
| Generation p95, ms                                       |               1,295 |                       1,140 |
| Model-declared `ANSWER` / `ABSTAIN`                      |             25 / 23 |                     22 / 26 |
| Invalid JSON / unknown citations / malformed abstentions |           0 / 0 / 0 |                   0 / 0 / 0 |

Mean paired prompt-token reduction was **180.67 tokens**, or approximately
**56.3%** relative to the full-retrieved-pool mean. This comparison includes
the actual fixed system/query prompts and evidence bytes submitted to Qwen,
but excludes previous `/v1/search` reader calls, live answer-agent orchestration
and real manual/Obsidian effort. Generation p95 is **not** a measured
single-request retrieval-plus-answer p95, and observed local latency does not
establish production performance.

Only **after both arms completed**, the separately executed offline
`scripts/s2-score-generated-answer-calibration.mjs` joined author-created
question answerability labels. This measures **model-declared emission**,
not semantic answer correctness:

| Exposed author-question stratum            | Full retrieved pool | Admitted spans |
| ------------------------------------------ | ------------------: | -------------: |
| 24 synthetic answerable: emitted an answer |                  24 |             22 |
| 24 synthetic no-answer: emitted an answer  |                   1 |              0 |
| EN 12 answerable: emitted an answer        |                  12 |             11 |
| ES 12 answerable: emitted an answer        |                  12 |             11 |
| EN 12 no-answer: emitted an answer         |                   0 |              0 |
| ES 12 no-answer: emitted an answer         |                   1 |              0 |

The full-pool no-answer emission was in synthetic case
`s2-optical-observatory-n06`; both positive abstentions in the selected-span
arm were `s2-marine-beacon-p01` and `s2-campus-microgrid-p04`. These
post-hoc observations must **not** be turned into corpus-specific retrieval
rules or interpreted as adjudicated final-answer accuracy.

The **final, repository-hygiene-compliant** 48-case experiment was run
**twice** using source citation IDs `SRC1`–`SRC6`. Across all 96 paired
arm/question outputs, prompt token counts and emitted `ANSWER`/`ABSTAIN`
statuses matched; **95/96** raw JSON texts and completion token counts also
matched. The only repeat difference was the admitted-span answer for
`s2-heritage-vault-p06` (33 versus 36 completion tokens, still `ANSWER`).
Generation timings were measured independently per run; do not claim
byte-for-byte output determinism. The second final run's report SHA-256 is
`c48903ff6f9e1c09736589f0af57e25eb86c97ff5266479ea11ac71cd5f55c2b`;
the post-hoc stratified calibration report SHA-256 is
`e2e51949aa406a035e2360dd516c26665a177cf3e7ca99428afd2d5189af8321`.
The outputs remain local, explicitly not a postcalibration holdout or
independent reviewer result. `gateAccepted=false` in both.

```sh
# Requires only the frozen local synthetic files and Ollama on loopback.
# The output path must be new: the generator refuses to overwrite reports.
node scripts/s2-paired-answer-generation.mjs \
  --observations reports/ci/s2-live-route-layered-observations.json \
  --sources reports/ci/s2-live-route-layered-authorized-sources.json \
  --route-report reports/ci/s2-live-route-layered-observation.json \
  --frozen-fixture evals/registered/s2-source-span-holdout.json \
  --output reports/ci/s2-paired-generation-replay.json --max-cases 48
node scripts/s2-score-generated-answer-calibration.mjs \
  --generated-report reports/ci/s2-paired-generation-replay.json \
  --frozen-fixture evals/registered/s2-source-span-holdout.json \
  --output reports/ci/s2-paired-generation-replay-calibration.json
```

**S2 remains OPEN.** This adds real generator-token and timing evidence and
an explicit answer/abstain capture mechanism, but does not satisfy the frozen
independent holdout, blind semantic answer/citation adjudication, production
full-response endpoint, source-cluster uncertainty, manual/Obsidian comparison
or gate-authorized rollout criteria. No production provider/default change,
PR merge, or S3-S5 promotion follows from it.
