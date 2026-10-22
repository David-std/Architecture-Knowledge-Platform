# S2 retrieval-to-writer pipeline: internal development diagnosis

**Status:** evaluation-only, no production or gate changes. AKP S2 OPEN, E5 SHADOW, S3–S5 BLOCKED; PR #38 must remain DRAFT/unmerged.

## Why the owner asked to stop repeated reviewer cycles

The owner-approved 12-case real-source pilot (three publishers) was already exposed and structurally adjudicated by two independent _chats_, not external accredited custodians. Only 1/6 source-explicit questions reached a source-grounded answer, while 5/6 had **zero application-admitted hits** and never reached Qwen. Six negatives abstained; no release false-admission claim can be made. The single native JSON-schema writer output and zero accepted Spanish hits pointed to an upstream issue. Further reviewer cycles without changing and validating the retrieval/admission strategy are not useful.

A private offline forensic replay of the real12 HTTP results gave more precise stage evidence: **5/6 positive cases did not have the owner's exact supporting quote in any of the returned concrete hit excerpts** (admitted or exploratory). This is a loss of the correct _passage_, not only a strict score threshold or a Qwen schema issue. Source-level availability differs from passage-level availability. One deterministic support cue erroneously identified a _what happens after stopping?_ question as PREVENTION; another rule can identify a quantity-like _what is maximum amount?_ question as DEFINITION. These mismatches are distinct from missing passages and are not enough to fix the upstream loss alone. Existing production answerability rules were NOT relaxed.

## Source-disjoint development laboratories

Two fresh fabricated corpora were pinned **before** search or model calls. Neither overlaps the owner real12 source family or the other synthetic corpus. Gold expectations were in separate private files, never read by retrieval/model runners; only post-run scorers opened them.

| Corpus                      | Source originals | Questions | Positives / negatives | Structural challenge                                                     |
| --------------------------- | ---------------: | --------: | --------------------: | ------------------------------------------------------------------------ |
| A. Short source bodies      |                4 |        16 |                10 / 6 | Simple explicit facts, English/Spanish                                   |
| B. Long multisection bodies |                4 |        16 |                10 / 6 | About 9–9.4 KB and 24 heading sections per file, facts at several depths |

Both ran in disposable organization/space/vault scopes in isolated PostgreSQL Docker via actual bearer-authenticated Fastify `/v1/search`. The raw exact request/response bytes, local model SHA-256 digest, query translations and freeze receipts are PRIVATE. Public repository docs contain only measurements and engineering conclusions.

### Search stage: three alternatives, identical questions and source revisions

A = baseline original question in retrieval and gate; B = Qwen-enriched translated query used **only for retrieval**, but original question retained for deterministic admission; C = translated question used at both retrieval and gate (unsafe to adopt unless semantic equivalence independently checked). Existing `QueryTransformerPort` supports adding variants. These are OFFLINE candidate tests, not new runtime defaults.

| Measured quantity                                                       | Short A | Short B | Short C | Long A | Long B | Long C |
| ----------------------------------------------------------------------- | ------: | ------: | ------: | -----: | -----: | -----: |
| Positive questions with a hit admitted                                  |    9/10 |    9/10 |    9/10 |   8/10 |   8/10 |   8/10 |
| Positive questions with fixture answer phrase in _admitted hit excerpt_ |    5/10 |    6/10 |    6/10 |   5/10 |   6/10 |   6/10 |
| Negative questions with a hit admitted (NOT model answer)               |     3/6 |     3/6 |     3/6 |    5/6 |    5/6 |    4/6 |

**Conclusion:** translation alone provides marginal excerpt coverage and does not solve source passage selection or imply safe negative admission. At least one local Qwen translation mixed Spanish into its nominally English result. Do not ship a translation-first shortcut.

### Writer-stage comparisons

For the same source/query sets, A passes only current HTTP-admitted original documents to a strict local Qwen quote-claiming schema. D selects up to two unique original files from the _authorized_ HTTP-admitted **plus exploratory** ranked hits, then asks for an exact supporting quote and concise answer. D **never** turns exploratory hits into production evidence: this is a private counterfactual shadow experiment. The same schema, Qwen model/seed/context/output configuration and exact SHA-frozen prompts were used for paired A/D comparisons.

| Metric                                                                                             | Short A | Short D | Long A | Long D | Long E |
| -------------------------------------------------------------------------------------------------- | ------: | ------: | -----: | -----: | -----: |
| Positive answers whose exact claimed quote contains fixture gold fact, before source-ID correction |    9/10 |   10/10 |   6/10 |   7/10 |   7/10 |
| Negative questions with a source-quoted positive answer                                            |     0/6 |     0/6 |    0/6 |    0/6 |    0/6 |
| Model outputs rejected by strict quote/source-ID contract                                          |       0 |       0 |      2 |      2 |      2 |

E selects up to six high-IDF lexical source sections from at most two authorized hit documents, using SHA-pinned local translation of Spanish queries. E was no better than D on long bodies; narrow section selection lost some relevant sections and a purported quote was not literal.

**Important distinction:** an admitted negative source hit is NOT the same as a false model answer. The strict writer correctly abstained on all negative synthetic questions despite many related admitted hits.

### Exact quote provenance re-attribution (candidate F)

The long-bodied Qwen outputs exposed a distinct failure: two otherwise **literal and correct** source sentences were labeled with model-invented citation IDs `SRC11` and `SRC18`, even though the frozen provider request only sent sources `SRC1` and `SRC2`. The original strict gate correctly rejected both. In another variant, Qwen paraphrased a quotation by changing its first word; THAT output must remain rejected because no exact original span exists.

The experimental pure helper `packages/evaluation/src/s2-exact-quote-attribution.ts`:

1. Verifies original UTF-8 content against SHA-256 and validated UTF-16 body boundaries.
2. Searches the **exact returned quote bytes** within all authorized originals; requires **exactly one** match across the full authorized scope and no partial surrogate offsets.
3. Binds that unique match back to the original assigned ID, content digest and exact `startUtf16/endUtf16`, even when the model-supplied ID is invalid.
4. Rejects invented, paraphrased, repeated, cross-document ambiguous, missing or manipulated quotations; it never changes the quote.
5. Keeps `semanticEntailmentVerified:false` and `releaseGateAccepted:false`; matching characters alone NEVER proves the answer is semantically implied.

Nine synthetic adversarial regression tests passed, including forged IDs, mismatched SHA, ambiguous quotes, paraphrases and false semantic entailment. The replay operated on exact frozen outputs **without any new model calls or edited response bytes**.

| Offline re-attribution score against synthetic fixture phrase    | Short A |   Short D | Long A |   Long D |
| ---------------------------------------------------------------- | ------: | --------: | -----: | -------: |
| Positives with literal authorized quote containing expected fact |    9/10 | **10/10** |   8/10 | **9/10** |
| Source-quoted false answers on six negative cases                |     0/6 |       0/6 |    0/6 |      0/6 |
| Long-case source ID repairs                                      |       — |         — |      2 |        2 |

The 9/10 long D replay result is **posthoc development evidence**, since source-ID repair was designed after diagnosing those very outputs. It is NOT a new blind holdout or unbiased independent accuracy estimate.

## Experimental S: quote-bound semantic verification (not acceptance)

A separate **evaluation-only** layer now follows the existing F attribution helper:

- The model-supplied source ID is untrusted. F first requires unique verbatim evidence, SHA-256 content verification and original UTF-16 span replay. Neither semantic probe can bypass F.
- A **question-relevance probe** receives the original question and exact quote. The existing local extractive QA adapter can supply a bounded answer span; its adapter requires that exact phrase inside the proposed answer. A QA match alone is not a truth certificate.
- A distinct **claim-entailment probe** receives the exact quote as premise and the full writer claim as hypothesis. Its direct-NLI adapter requires a revision-pinned identifier, an exact pinned-tokenizer count under the configured window, finite class probabilities and a score/margin. Uncalibrated thresholds remain research-only.
- Both distinct probes must return support with replayable evidence spans. Contradiction, insufficiency, malformed model results, exceptions, timeout, ambiguous quotes, invalid SHA and over-budget original context all lead to non-admission. Model exception text is not copied into diagnostics.
- Even when both probes agree, the outcome is only `SUPPORTED_CANDIDATE`, with immutable `productionAdmission:false` and `releaseGateAccepted:false`.
- Synthetic port-level regression tests cover question irrelevance, reversed relations, quantity changes, temporal uncertainty, source ID hallucination, invalid spans, model errors, timeouts and SHA tampering. They are NOT real-model semantic accuracy measurements.

Implementation: `packages/evaluation/src/s2-semantic-evidence.ts`, `packages/evaluation/src/s2-semantic-probes.ts`, and `packages/evaluation/test/s2-semantic-evidence.test.ts`.

This construction does not promote exploratory hits to admitted evidence or turn experimental D into a production answer endpoint. The QA-phrase-in-claim requirement can over-abstain on cross-language paraphrases. A successful QA/NLI pair can also be semantically wrong. Both failure modes need empirical, source-disjoint DEV measurement before any product proposal.

### Independent synthetic DEV challenge (2026-10-22, observed, not acceptance)

Private, author-constructed NEW four-family synthetic challenge (16 cases: 8 positive, 8 hard negative), unrelated to previously exposed SHORT/LONG corpora. Inputs and the 32 exact Ollama provider requests were frozen before any provider call. The private oracle was loaded only in postrun scoring. The writer claims were constructed for this test; these were NOT output by a production answer endpoint.

- Literal F alone: 16/16 quote/source bindings; 8/8 negative claims could still have appeared quote-bound, demonstrating that attribution alone is insufficient.
- An experimental two-step Qwen semantic diagnosis (original question to quote; full proposed claim to quote) yielded supported candidates on **8/8 positive claims**, and withheld **8/8 negative claims** (all eight marked CONTRADICTED). Each of four document families contained two positives and two negatives.
- Exact pinned local Ollama `qwen2.5:7b-instruct` was queried 32 times with temperature=0, fixed seed and a native JSON schema. The local provider observed p95 was approximately 2.122 s per call over these 32 calls. This is NOT HTTP answer-route end-to-end p95.
- The SAME Qwen model performed both semantic checks; it is not independent NLI evidence. The official pinned QA/NLI ONNX local loads failed because expected model artifacts were unavailable. Their real-world precision, cross-language accuracy and calibration remain unproven.
- These 16 exposed cases are now DEV, not a fresh holdout. No production admission, release gate, threshold or retrieval default changed, and no private prompts, documents, raw observations or gold were committed.

**Next:** evaluate an independently executable QA/NLI verifier, run further source-disjoint hard negatives and an authenticated HTTP→ContextPacket→writer shadow harness. Do not report statistically certified 0 FAR from 8 negatives.

## Independent-model QA/NLI and authenticated HTTP continuation (2026-10-22)

All results in this section are development diagnostics, not S2 acceptance, release proof or authorization to promote D, F or the semantic verifier. Private per-case data, original responses, source contents and oracle remain in ignored worktree directories.

### Real pinned model execution and generality

- Independently loaded MiniLM multilingual NLI in ONNX Runtime after copying the verified model artifact to a **short Windows path**. The original very long Transformers.js cache path caused native model-load errors even though the original ONNX file was byte-complete. MiniLM pinned commit `0a71e92a985b6e1ad1828cf67ce9c459639c1dca`, artifact SHA-256 `79f8cda2b1230585a95ea0514a6f1bd21c5c986ba0529bb3261213a3e195fa6e`.
- Independently loaded extractive multilingual XLM-R QA from `onnx-community/xlm-roberta-base-squad2-distilled-ONNX@484112fae76dde6ad01b640192d559cbc2d488e1`, quantized artifact SHA-256 `7e9eb6a4b524a076b137eb976d0457378216e195b218a4d63fd6f4f694bc26cc`. Cross-language question-to-answer controls ran locally. Neither model was promoted as a production default.
- Frozen source-disjoint author-constructed corpus: 12 new synthetic document families, 144 claims (48 positives, 96 hard negatives); no oracle supplied to either model during inference. NLI-only with predeclared score 0.8 and margin 0.2 supported **43/48** positives but falsely supported **4/96** negatives, all quantity changes. These are stage-level false-support candidates, NOT product FAR.
- A generic strict explicit-number-in-quote guard now fails closed on numeric claim values absent from the uniquely source-bound quote before QA/NLI. It is deliberately not a calculator, synonym recognizer or proof of subject-quantity binding. With numeric veto and real independent QA/NLI (QA score floor 0.1, NLI score 0.8 and margin 0.2), the same frozen private corpus yielded **39/48** supported positives, **0/96** false-supported negatives and **9/48** missed positives (six paraphrase, three negation). This exposed corpus is not a valid independent acceptance sample. In particular, 0/96 does NOT establish universal zero false admissions.
- One NLI control incorrectly classified an unsupported roof-color statement as CONTRADICTION instead of NEUTRAL. It was still withheld but demonstrates semantic-label calibration risk. Positive paraphrase misses also remain. Do not disable fail-closed integrity checks to recover these cases.

### Actual authenticated retrieval, packet and writer replay

- On the isolated disposable PostgreSQL `akp_s2_bench` and loopback Fastify HTTP API, ran **16 SHA-frozen questions in each of three retrieval variants** (48 real authenticated HTTP requests). Access checks were inherited from the preserved harness; all candidate originals were bound to the HTTP response vault, path and revision. Repeated model-provider requests were frozen BEFORE inference and used local Qwen `qwen2.5:7b-instruct` at the existing pinned digest.
- Baseline retrieval returned at least one admitted hit for 12/16 cases. The authenticated results may also contain exploratory hits; these remain **research candidates**, never admitted production evidence. Replayed 16 ContextPackets using the maintained `buildContextPacket` on admitted hits only. All 16 were `INSUFFICIENT_KNOWLEDGE` with no sections because the synthetic seeded knowledge documents returned no source citations. This is a fixture/provenance gap, not evidence of a defect in production ingestion. No exploratory hit was silently upgraded into a packet section.
- Replayed independent pinned QA+NLI over the newly observed Qwen writer responses with unique-SHA original-text attribution F. On this previously exposed 16-case development corpus (10 positives, 6 negatives), A-only-admitted yielded **9/10** supported positives and **0/6** false-supported negatives; D full-authorized-original shadow yielded **10/10** and **0/6**, respectively. D is not an admissible production ContextPacket route and no complete answer HTTP API was exercised. The additional model calls were new, but the underlying question/source families were already exposed, so these results cannot be considered blind acceptance.
- The disposable fixture cleanup query confirmed **0 residual** synthetic organizations under its test slug. The local replay and raw model responses are private, not committed. The main user vaults/databases were not altered.

### Remaining S2 acceptance blockers

1. Replace the synthetic knowledge-only seed with an isolated **real SOURCE ingestion → reviewed KNOWLEDGE publication → indexed citations → nonempty ContextPacket** workflow and validate freshness, permissions, UTF-16 spans and full writer transport end to end.
2. Run a genuinely held-out and independently adjudicated corpus containing multiple facts per answer, conditional/temporal changes, negative numerical cases, bilingual paraphrases and counterexamples. Measure stage recall, support precision, no-answer false admissions, coverage, confidence intervals and actual writer correctness independently.
3. Verify the whole-answer atomicity, qualified local-source context and cross-claim consistency checks with real pinned model providers. Those interfaces are currently shadow-only contracts with synthetic regressions, not empirically calibrated semantic gates. Complete matched manual/Obsidian comparisons, exact tokenizer accounting and S2 exit criteria before reviewers or promotion.

**Decision:** S2 OPEN; E5 SHADOW; S3–S5 BLOCKED; PR #38 remains OPEN/DRAFT/UNMERGED. No production admission/ranker/retrieval/model defaults have changed.

## Engineering decision / next gate

**Leading engineering candidate for more development: D + F**, NOT a production switch. It addresses two independently reproduced failure modes: source-specific passages omitted from admitted hits despite relevant authorized documents and hallucinated model citation IDs with otherwise exact source quotes. Preserve an explicit authorized-source check, SHA-pinned original bytes, exact evidence offsets, unambiguous quote attribution and a separate semantic-entailment verifier before admitting any answer.

Reject these as standalone recommendations based on current evidence: lowering deterministic coverage thresholds, blindly admitting exploratory hits, translating the question and treating it as automatically equivalent, and selecting source IDs based only on Qwen output.

Before asking reviewers again:

- Test the pipeline on NEW frozen, source-disjoint development corpora, especially longer multilingual real-style documents and adversarial near-miss answers, with strict supported-answer, unsupported-answer, citation and abstention metrics **per stage**.
- Add an independent claim-to-quote semantic support check (prefer pinned local QA/NLI verified on source-disjoint controls) and do not let quote attribution alone grant truth.
- Diagnose long-document chunk/ranking recall separately from admission and measure resource/token bounds; full-body context can exceed the effective model window.
- Re-run real authenticated HTTP all the way through a proper answer route when one exists; provider-only timings are not full application p95.
- Only propose owner/reviewer packets when a fixed configuration achieves reproducible gains on a NEW held-out batch with controlled negative false-answer risk.

**No owner answer manifest, raw model responses, real12 source text or private query questions were committed.** Developer experiments are all private in ignored S2 .work directories. Isolated PostgreSQL cleanup was independently read-only checked, confirming zero residual organizations, spaces, vaults, documents, units, index revisions, temporary users/tokens and transformer traces, and the dedicated Docker PostgreSQL was stopped. Gate remains S2 OPEN / E5 SHADOW / S3–S5 BLOCKED.
