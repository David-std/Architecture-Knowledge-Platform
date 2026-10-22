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
