# S2 authorized-retrieval-to-native-writer development bridge

**Scope:** local offline, synthetic development experiment only. Neither the writer bridge nor this report is an API endpoint, route-level policy change, independent holdout, release gate, or production admission path. **S2 OPEN · E5 SHADOW · S3–S5 BLOCKED · PR #38 DRAFT.**

## What was implemented

`packages/evaluation/src/s2-retrieved-writer-bridge.ts` connects **ranked hits already emitted by authorized `queryKnowledge`** to frozen original Markdown bytes and the previously introduced `freezeNativeStructuredWriter` native Ollama JSON-schema writer request. No correct answer or expected document ID is accepted in the bridge input; ranked source selection is only from the actual hit list.

For every candidate hit, the bridge requires the requested vault UUID, active/current lifecycle, unit/document/revision identity, an affirmative path authorization callback and a frozen original with identical vault, document ID, relative path and revision. Each selected original's SHA-256, strict UTF-8 bytes, UTF-16 body frame and original literal passage offsets must verify. No duplicated documents, unauthorized paths, stale hits, missing original bytes or tampered source can be used. A source must fit the explicit bounded full-body evidence budget. Source IDs (`SRC1`, etc.) are assigned **in ranked hit order**, with per-source hit rank, hash-only identities and byte provenance in the frozen evidence receipt.

When zero evidence qualifies, the bridge returns `NO_AUTHORITATIVE_RETRIEVAL_EVIDENCE`, **no provider request**; when at least one source qualifies, it freezes **the exact full native `/api/chat` request bytes** with all source text and SHA-256 before inference. The bridge carries `ownerGoldLoaded:false`, `semanticCitationEntailmentVerified:false`, `applicationHttpP95Measured:false` and `gateAccepted:false`. The caller is still responsible for establishing that the input hits really came from authorized `queryKnowledge` under the correct space/vault/principal; a fabricated caller-supplied list cannot be independently authenticated by this pure function. The development runner fixes a disposable scope, resolves the path policy and calls the actual retrieval function.

**Negative-path tests:** `packages/evaluation/test/s2-retrieved-writer-bridge.test.ts` verifies authorized current hits, no-hit abstention without model request, rejected stale revisions and denied paths, tampered source SHA, deduplication and cross-vault or unpinned rejection. The prior structured native writer regression suite checks correct source-ID citations, strict JSON, truncated responses and abstention consistency.

## Measured real PostgreSQL queryKnowledge → local Ollama development run

A NEW, completely fabricated corpus was written and SHA-pinned _before_ calling retrieval or the model, distinct from all previous owner-approved Node.js/Rust/MDN questions. Sources describe invented protocols for `boreal orchid`, `cobalt otter` and `silver pine`. The corpus includes three source-positive and three source-negative questions in English/Spanish (the EN/ES composition in this small development set is not sufficient for language-stratified statistical claims).

Frozen source manifest SHA-256: `3c30bb6edc9d305694de1e72307be478ea0b66607737cd78aa048e78a1781f30`.
Frozen case manifest SHA-256: `295e94afa25c601c045dd736ad4266eb5c61f3136b57af609fba50f8cbb00eeb`.

The private development runner `.work/s2-retrieved-native-live-dev-20261021.ts` used a NEW disposable organization, space, and vault on isolated Docker PostgreSQL `127.0.0.1:55432/akp_s2_bench` only; it created 3 pinned originals, **9 parsed knowledge units** and a matching lexical index-revision marker. It invoked genuine `queryKnowledge` with exact scoped authorization, `SOURCE_BACKED` mode and lexical/exact channels for each question. It froze all six complete retrieval→writer request/citation passage maps before making any provider call. Qwen2.5 7B instruct model SHA-256 digest `845dbda0ea48ed749caafd9e6037047aa19acfcfd82e704d7ca97d631a0b697e` was pinned, using the native `/api/chat` structured-output request with explicit `num_ctx=8192`, `num_predict=512`, `temperature=0`, `seed=1317`.

| Development measurement                                             |         Observed |
| ------------------------------------------------------------------- | ---------------: |
| Synthetic original documents                                        |                3 |
| Indexed knowledge units                                             |                9 |
| Real PostgreSQL retrieval queries                                   |                6 |
| Queries with retrieval hits                                         |           6 of 6 |
| Retrieval hits per case                                             | 3, 2, 2, 1, 1, 1 |
| Authorized literal original documents selected for model            | 2, 2, 2, 1, 1, 1 |
| Ollama HTTP 200 responses                                           |           6 of 6 |
| Strict structured model responses                                   |           6 of 6 |
| Positive answers with text literally found in supplied evidence     |           3 of 3 |
| Negative-case abstentions                                           |           3 of 3 |
| Strict _exact-string_ comparison to a simple fixture-canonical text |           5 of 6 |
| Independent semantic correctness / production false-admission rate  |     Not measured |

The sole strict-canonical mismatch is a **non-substantive surface-form difference** in the storage-location answer (the model included `in` before a location description); the answer was **verbatim within the actual source** and used an authorized citation ID. The exact-string comparison was NOT retroactively tuned after seeing the result. All three negative responses had empty answer/citation arrays despite receiving relevant retrieval hits. These results illustrate correct expected behavior on controlled fiction; they do not prove the same behavior on user data.

Each case has its exact raw request bytes, response bytes, SHA hashes, pinned original identity, selected ranked hit IDs, actual provider tokens and separated retrieval/provider durations in the PRIVATE `section-new-family-20261021/retrieval-writer-synthetic-20261021/actual-postgres-queryknowledge-ollama-20261021` directory. Post-run hash validation passed for 6/6 request-response pairs. The first provider invocation took ~111.1 seconds (possible local cold-load/initialization); subsequent calls took ~1.05–1.87 seconds. **Those are provider-side times, not authenticated AKP HTTP p95**, and must not be promoted to a capacity target. There was no independent semantic adjudication or release uncertainty interval.

After the experiment, a standalone read-only cleanup verifier queried the disposable database and returned **zero residual rows** for the synthetic organization, space, vault, documents, units and index revision. The dedicated Docker PostgreSQL container was stopped cleanly; the principal/default Windows database was never changed.

## What still blocks S2 admission

- The new bridge is development-only and assumes upstream ranked hits have already been authorized. Neither `queryKnowledge` direct-library calls nor isolated Docker are an authenticated production HTTP route.
- A new owner-custodied **non-reused** set with genuinely new source families, blind question authoring and two separate reviewer adjudications is required to measure the repaired writer beyond synthetic fiction. The old 8-case Node.js/Rust set, old 200 tasks and MDN 8 questions are development-only after inspection.
- Negative absence across the **whole authorized source set**, semantic claim-to-exact-cited-passage support, source-family clustered intervals, cost and full application HTTP p50/p95 still require evidence.
- The source selection deliberately sends the whole frozen body of each retrieved matching document when it fits the finite budget. This is not the ordinary runtime `ContextPacket` / section admission mechanism; compare complete runtime context-packet construction in an independent subsequent phase.
- Neither the local model settings nor the bridge is wired into production. There is no threshold/ranking change, SECTION promotion, rollout or merge.

**Next:** add a scoped authenticated route-level capture for new blind cases, with the final constructed `ContextPacket` and provider request linked to authorized hit provenance; run new owner-selected source-family-disjoint questions only after preregistration. Do not make release decisions from these six synthetic observations.
