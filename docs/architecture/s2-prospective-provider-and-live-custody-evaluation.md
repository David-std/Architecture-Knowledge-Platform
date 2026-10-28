# S2 — prospective local Writer probes and authenticated original-SOURCE custody (2026-10-28)

**Evidence tier: development, not independent acceptance.** S2 remains OPEN, E5 SHADOW, LAYERED/BGE and bounded lexical recall OFF by default, S3–S5 BLOCKED, PR #38 DRAFT.

## Preserve the existing 200 DEV cases

The master ledger (§§67–69) has **200 EN/ES historical questions across 34 source documents**, 209 historical citations (103/209 AI-reviewed as sufficient), 49 of 126 provisionally positive cases with no AI-reviewed sufficient citation, and 31 positive abstentions despite previously deemed sufficient citation. In the older Writer cohort, 44/58 affirmative answers were assessed as correct/supported; 14 were not. The original 48-case synthetic source-span benchmark, 288 calibration review pairs and 158-item blind disagreement/control kit likewise remain **development/calibration**, not prospective gold. These denominators are distinct pipeline stages. None of those sources/tasks is eligible for a new independent release holdout.

## Frozen prospective _development_ probe: four local models

An author-created synthetic manifest was SHA-256-pinned **before inference** (`789592f9a0c157530d518d9cb82a9e46416a83d3d9e7881ce3da4e4a8032a0d1`). It has four invented SOURCE families, 16 questions, 8 positive, 8 negative and 8 each in EN/ES. Private exact frozen native Ollama `/api/chat` request bytes, UTF-16 SOURCE frames, responses, model digests and timing receipts are kept outside Git at `%LOCALAPPDATA%/Temp/AKP_S2_PROSPECTIVE_20261028_2027`.

| Local Writer               | Strict expected-string positive | Negative proper abstention | Correct source ID on positives | Provider+capture p95 |
| -------------------------- | ------------------------------: | -------------------------: | -----------------------------: | -------------------: |
| Llama 3.2 3B               |                             7/8 |                        8/8 |                            8/8 |               7.98 s |
| Qwen 2.5 7B                |                             7/8 |                        8/8 |                            8/8 |              12.68 s |
| Gemma 3 4B                 |                             8/8 |                        7/8 |                            8/8 |              13.43 s |
| Qwen 3.5 9B, `think:false` |                             8/8 |                        8/8 |                            8/8 |              28.84 s |

**Do not reclassify the frozen scores after seeing answers.** The two scored Spanish positive misses actually returned English `bronze` rather than expected Spanish `bronce`: source-compatible factual material, but incorrect requested response language under this primitive strict-string proxy. Gemma's one negative answered `no replacement material is recorded` with a citation instead of abstaining on the missing WHAT-material slot; this is a **false affirmative under the answerability contract**, not a fabricated material. Both require independent adjudication, not guessed semantic correction. The source-ID column is structural validity, **not** proof that a claim is entailed.

A first Qwen3.5 attempt consumed all 256 output tokens as `message.thinking`, with empty `message.content`. Its rejected requests remain preserved. The native evaluation adapter now optionally freezes Ollama `think:false` in the exact provider request; it leaves other models' defaults unchanged. A 16-case rerun then completed structurally. The p95 values are **not end-to-end AKP API latency**; 16 cases/model and provider cold/warm variation cannot certify the provisional 25 s gate.

## Actual authorized HTTP + PostgreSQL + immutable MinIO

On an isolated disposable Compose project, migrations 001–093 applied, including the new reviewed-proposition table. The new `apps/api/test/s2-reviewed-source-live.integration.test.ts` exercised 4/4 local integration cases successfully: a source-mismatched proposal fails; same-principal approval fails; a distinct _simulated test principal_ approves; authenticated writer statement and fake SEC2 citation are checked against a persisted ContextPacket; ES question and claim are bound to the original EN SOURCE; true authenticated `/v1/context` returns the current authorized factual claim in deterministic and test-only LAYERED modes; revocation and vault-permission removal fail closed.

The first fixture used a generic `concept` document type and both retrieval modes returned **0 candidate sections** before any R5 decision. Changing only the _test fixture_ to the accurate `claim` type and matching index metadata yielded 1 source-bearing section in both. This is a **stage attribution finding**, not a domain-specific retrieval rule or proof LAYERED improves admission. Changing top-k, BGE thresholds or the model would not have solved that particular pre-Reader document-type mismatch.

The HTTP integration contains prewritten statement text and two simulated authenticated principals; the separate model probes contain real Ollama calls but no authenticated AKP retrieval. Therefore a single model-generated, provider-custodied, authenticated Search→ContextPacket→Writer→independently reviewed atomic-claim audit remains **unproven**. Provider-only p95 and server-only milliseconds must not be combined as a measured full-request p95.

A new opt-in **CI step** now uses Docker Postgres and MinIO, a disposable `akp_s2_reviewed_test` database, built Retrieval package, Node 24 and the actual Fastify test. An initial local attempt against a DB named `akp` was correctly refused by the `TEST_DATABASE_NOT_DISPOSABLE` safety check; no guard was bypassed.

## Independent reviewer intake — 240 blank seats, NOT a finished holdout

`scripts/s2-prepare-external-review-kit.ts` created a **private coordinator-only 240-seat template** with 12 publisher families, 20 questions/family, five of each EN-positive, EN-negative, ES-positive, ES-negative per family (**60 per stratum**). The template SHA-256 is `90e89febb4b98098bdb257d42cc4a4f4c93d6785efb0a0c359b1400d9d8e84d4`. The private output is `%LOCALAPPDATA%/Temp/AKP_S2_PROSPECTIVE_20261028_2027/external-custodian-240-prep-001/`. It includes unfilled intake, explanatory README, blind reviewer rubric and a manifest explicitly marked **UNFILLED**.

There are currently **0 actual questions** in this 240-seat holdout, **0 independent reviewers**, no new sourced answers, no real signer key and no model runs on the intended independent data. A separate external custodian must choose authorized new publisher/source/relation families, complete SOURCE SHA-256 and exact spans, freeze cases/labels/thresholds _before_ inference, and arrange blinded independent X/Y reviews with Z adjudicating disagreements. The existing `s2-owner-holdout` and Ed25519 external-freeze verifier must be reused; the blank-template hash is **not** an external source freeze. Publisher families and target cases must be disjoint from 200 DEV, 48 synthetic, 176 owner pilot and other previously tuned examples.

## Retained acceptance gates and next work

Retain the preregistered provisional precision >=0.80, simple Wilson95 lower >=0.70 _as diagnostic_, FAR <=0.10 and no worse than deterministic baseline, full HTTP p95 <=25 s, degradation <=5%, **no final-answer correctness regression** and source-family-cluster uncertainty. Future paired baseline/LAYERED tests must measure source-unit Recall@K, source attribution, requested answer role, actor, negation, time, actual full atomic Writer assertions, necessary/unnecessary abstentions, tokenizer and model residency, actual cold/warm full-request latency and reviewer uncertainty. Do not tune this independent holdout based on its outputs.

**Current disposition:** implementation and isolated test evidence improved; **S2 NOT GATEABLE**. E5 SHADOW, no default changes, S3–S5 BLOCKED.

## Reproducible checks

```sh
pnpm contracts:validate
pnpm --filter @akp/retrieval build
pnpm --filter @akp/evaluation exec vitest run test/s2-native-structured-writer.test.ts
# Requires isolated PostgreSQL, MinIO and explicit S2 test env flags:
pnpm --filter @akp/api exec vitest run --config vitest.integration.config.ts test/s2-reviewed-source-live.integration.test.ts --no-file-parallelism
pnpm exec tsx scripts/s2-prepare-external-review-kit.ts --output-dir /absolute/private/new-path
```

Keep all private questions, SOURCE originals, provider raw text, labels, local full paths and reviewer identities out of Git. No test-only flags change the default runtime.
