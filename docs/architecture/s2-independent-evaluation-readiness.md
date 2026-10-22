# S2 independent evaluation readiness: exact writer passages and family-disjoint freeze

**Stage-by-stage S2 pipeline diagnosis and self-run candidate comparisons:** see [S2 pipeline diagnosis and candidate lab](./s2-pipeline-diagnosis-and-candidate-lab.md). This documents two new synthetic corpora, multiple local pipeline options, false-abstention causes and a shadow-only exact-quote attribution candidate. Do not use these trials to accept a gate or send new reviewer packs.

**Authenticated HTTP search-to-writer development evidence:** see [S2 authenticated HTTP writer bridge](./s2-authenticated-http-writer-development.md), with real bearer-authenticated local Fastify, no exploratory-hit promotion and explicit false-abstention reporting. These development observations are not an independent real-source release holdout.

**Actual authorized retrieval-to-writer development path:** see [S2 retrieved writer bridge](./s2-retrieved-writer-development.md), validated only on an isolated synthetic PostgreSQL fixture with pinned native Qwen raw requests/responses, not the production HTTP route.

**Local writer output diagnostics:** see [S2 native structured-writer diagnostics](./s2-native-writer-diagnostics.md). This is synthetic/development-only and does not supersede the frozen eight-case owner pilot.

**Personal project path:** see [S2 owner-controlled evaluation pilot](./s2-owner-controlled-evaluation.md) for owner-custodial precommits, blinded X/Y reviews, full original file provenance and exact quote auditing. It is an internal evidence tier and **does not claim external independence or supersede the formal gate**.

**Status: preparation-only; S2 OPEN, E5 SHADOW, S3–S5 BLOCKED.** Nothing here is a new production search path, source authorization bypass, admission rule, deployed writer, calibration target or release gold.

## Evidence model and the historical gap

The 2026-10-21 MDN writer experiment yielded 13 Qwen outputs (8 child-only, 5 SECTION-enriched), reviewed by X and Y. Their 13/13 label agreement and 20/20 exact original Markdown quotes are **development observations**, not independently authenticated truth. The historic writer trace retained `SRCn` and `SECTIONn` IDs but not a complete frozen ID-to-exact-**presented**-passage map. No after-the-fact reconstruction from `body_cache`, a matching source quote or a new retrieval query can repair that missing trace.

`freezeExactWriterRequest` (in `packages/evaluation/src/s2-writer-passage-capture.ts`) is a pure preparation helper for **future** experiments. It constructs one exact UTF-8 provider JSON request with its complete system/user prompt, question, source-ID ordering, entire literal passage text, model, configured seed, temperature and maximum tokens. The frozen request includes its SHA-256 and raw UTF-8 bytes (base64) plus each passage ID, SHA-256, length and original-file provenance status. For `ORIGINAL_LITERAL_MATCH`, a separately frozen original Markdown byte string, revision-bound file digest and document identity must correspond to **exact full-file UTF-16 offsets** inside the independently established body frame. For retrieval-derived excerpts without exact offsets the passage remains `UNBOUND_PROJECTION`; **no guessed locator or source status is permitted**. Request mutations after freezing fail closed. `sealExactWriterResponse` binds an immutable request digest to the raw response byte digest and elapsed **provider-only** duration, without calling the reply semantically correct or treating it as an end-to-end HTTP p95.

The explicitly opt-in, offline-only CLI `scripts/s2-freeze-and-run-writer-probe.ts` loads a precommitted private spec hash. It writes the **exact provider request bytes and the frozen receipt before** any network request; it defaults to _prepare-only_. Only with `--execute-local` does it verify a pinned model digest against local Ollama and send the same frozen request bytes to `http://127.0.0.1:11434/v1/chat/completions`. It then writes the exact raw response bytes and a digest/timing receipt. No path may be inside the public worktree, no prior report can be overwritten, and there are no remote/cloud model endpoints. If generation fails, preserve the request and the redacted error. The separate source-reader integration must supply the actual candidate passages and exact source bytes **before generation**. Inferred model passage offsets are never reconstructed from output citations.

```sh
pnpm exec tsx scripts/s2-freeze-and-run-writer-probe.ts \
  --spec /private/probe-spec.json \
  --spec-pin-file /external-freeze/probe-spec.sha256 \
  --output-dir /private/unique-run
# After inspecting the frozen request, explicitly add --execute-local
# on a NEW unique run directory (not on top of an existing snapshot).
```

The private spec has `schemaVersion: "akp.s2.writer-local-probe-spec.v1"`, `questionAndModel` matching `WriterProbeInput`, and `originals` containing `documentKeySha256`, `fileSha256`, `filePath`, `bodyStartUtf16`, `bodyEndUtf16`. `originals[].filePath` is an access-controlled LOCAL original file. `questionAndModel.passages[]` contains `id`, the exact `text` used, and `original` with original-file IDs and spans, or `null` if the source is not demonstrably literal. Do not use historic MDN questions, any inspected 200 tasks, or a previously exposed public calibration family as an independent holdout.

**Synthetic CLI proof:** an entirely fictitious file, a 1-passage precommitted spec and the prepare-only CLI were run with no model call. The preflight verified the passage against full original UTF-16 coordinates and produced request SHA-256 `1e2aa1f40ad52033d273af6c065c6a5af8b97d960954dcb7b767bf1c0824652c`. This demonstrates the new capture mechanics, not a source-backed model result.

## New publisher-family source candidates (not a holdout)

Four original Markdown candidate files were fetched from two official upstream public repositories at **40-digit immutable commit SHAs** and verified against each upstream GitHub Contents API Git blob ID and raw byte size:

| Publisher family | Repository       | Frozen upstream commit                     | Original Markdown source files                                 |
| ---------------- | ---------------- | ------------------------------------------ | -------------------------------------------------------------- |
| `nodejs`         | `nodejs/node`    | `14ed05f86bd6c2309f07a29edaa64c3a0ce01728` | `doc/api/timers.md`, `doc/api/path.md`                         |
| `rust-lang`      | `rust-lang/book` | `1500248d8f230566e4ec9f27fcbb8fe9e2898ab1` | `src/ch04-01-what-is-ownership.md`, `src/ch08-03-hash-maps.md` |

The four frozen raw candidate files, a SHA-256 manifest, upstream Git blob hashes and a reproducible fetch/check script are kept under **private** `section-new-family-20261021/holdout-source-candidates-20261021`. No test questions, expected answers, reviewer labels or model results were created from them. Source selection was performed by the implementer and therefore **does not qualify as an independent custodian-selected holdout**. Publisher provenance checks also do not guarantee that cited docs, licenses or the assessment task distribution represent the target deployment setting. An external custodian must inspect selection, licensing, revisions and bias before choosing/adding sources and freezing the actual test set.

## Independent custodian freeze protocol

`verifyPrecommittedHoldoutFreeze` checks an **Ed25519** signature over domain-separated bytes `AKP:S2:INDEPENDENT_HOLDOUT_FREEZE:V1\\0` followed by exact UTF-8 manifest bytes. The manifest's externally precommitted SHA-256, the expected Ed25519 public-key fingerprint, and a separately pinned development-family denylist must come from **outside** the signed manifest and outside an editable implementer-controlled evaluation run. The manifest includes opaque `caseManifestSha256`, mixed EN/ES counts, negative-case count, separate publisher family IDs, pinned Git commits/source SHA-256 snapshots, and sealed reviewer-assignment digest. The verifier rejects signature forgery, mismatched hash/key, reused development publishers (including MDN), duplicate publishers/repos, invalid source revisions and missing EN/ES or negatives. It returns **structural signature and declared family checks only**; it cannot establish the real-world independence, institutional authority or unbiased conduct of the holder of the key.

```sh
pnpm exec tsx scripts/s2-verify-external-holdout-freeze.ts \
  --manifest /private/custodian-freeze.json \
  --pin-file /external/custodian-freeze.sha256 \
  --signature /external/custodian-freeze.sig \
  --public-key /external/custodian-public-ed25519.pem \
  --fingerprint-file /external/trusted-key-fingerprint.sha256 \
  --development-denylist /external/preexcluded-dev-families.json \
  --denylist-pin-file /external/preexcluded-dev-families.sha256 \
  --output /private/holdout-freeze-audit.json
```

A separate, verifiably independent custodian must (1) establish reviewer role/authority and public key through an out-of-band channel; (2) choose/freeze families and questions **without seeing system outputs**; (3) publish a timestamped precommit and explicit target release metrics, acceptance thresholds and cluster-unit rationale before the runs; (4) assign blinded reviews with no writer outputs or other reviewer judgments visible; (5) audit evidence against exact original source locations and each inference-time passage map; and (6) authorize adjudication only after both reviews are sealed. Simply signing an implementer-created manifest, having X and Y agree, or creating another model-agent reviewer does **not** prove independence.

Before S2 can close, evaluate on genuinely new publisher-family-disjoint tasks with independently adjudicated positives, explicit refutations and unsupported negatives. Capture complete authorization provenance, reproducible child and SECTION candidate IDs, the full request/response, exact passages, citation claims, cold/warm timing and cost. Report actual application end-to-end p50/p95, paired answer gains, negative false admissions and source-family-cluster uncertainty. Pre-register any release thresholds externally; do not select or tune them on the 200 already inspected questions, the 8 MDN questions, or these unadjudicated candidate sources.

This separation between risk measurement, review independence and quantified uncertainty is consistent with NIST AI RMF MEASURE recommendations: https://airc.nist.gov/airmf-resources/airmf/5-sec-core/ .

## Current non-claims

- `independentCustodianRoleExternallyAuthenticated=false`: no independently verified custodian identity/authority has been provided.
- `modelCitationFaithfulnessIndependentlyAdjudicated=false`: no new complete writer-output source/span review has been returned for these new sources.
- No new provider-run correctness, release FAR, source-cluster confidence interval, full-route p95 or cost data exist from this preflight.
- No changes to production admission, retrieval defaults, user-facing citations, threshold calibration, model selection or S2/E5 release gates.

**S2 OPEN · E5 SHADOW · S3–S5 BLOCKED · PR #38 DRAFT/unmerged.**
