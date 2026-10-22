# S2 authenticated HTTP search-to-writer development

**Evaluation-only, synthetic local experiment.** This change does not add an answer endpoint, change production `/v1/search`, allow SECTION admission, modify rankers or thresholds, or justify merging PR #38. S2 OPEN, E5 SHADOW, S3–S5 BLOCKED.

## New response-to-writer evidence boundary

`packages/evaluation/src/s2-authenticated-http-writer-bridge.ts` accepts **raw HTTP request and response bytes**, expected space/vault/question, a caller assertion that a real authenticated loopback request was performed, and frozen original files. The pure bridge cannot independently authenticate the bearer credential or prove the origin of bytes. That boundary is explicitly reflected by `authenticatedPrincipalVerifiedByOfflineBridge:false`.

It fail-closes unless the request is an exact single-space/single-vault nonfederated `SOURCE_BACKED` query and the captured response is HTTP 200 with matching `scope`. It also enforces `SUPPORTED` versus `EXPLORATORY_ONLY` / `NO_CANDIDATES` consistency and type-checks admitted hit identities. **Only `response.hits`**, never `response.exploratoryHits`, may flow into the existing pinned-original `freezeWriterFromRetrievedHits` bridge. A result without authorized/current original-byte matches generates no writer request, even if a related exploratory hit exists. Full source bytes and UTF-16 source spans are bound to the exact native Ollama provider payload before any writer invocation. Source IDs are generated only from admitted, revision-consistent, path-authorized and SHA-256-verified originals.

The module is pure evaluation code. Targeted adversarial tests cover valid admitted evidence, all-exploratory refusal, wrong HTTP response status/scope, contradictory admission status, denied path, stale revision and malformed hit. It never claims that a citation's _semantic entailment_ is proven merely from membership in a sent passage.

## Actual isolated Fastify HTTP + local Ollama run (2026-10-21)

The private `.work/s2-authenticated-http-native-live-dev-20261021.ts` runner reused **the already exposed, SHA-pinned synthetic development-only corpus** of three invented sources and six questions. This repetition tests the transport/authorization boundary; it is **not** a new blind holdout, nor a fair new independent estimate of accuracy.

- Frozen source manifest SHA-256 `3c30bb6edc9d305694de1e72307be478ea0b66607737cd78aa048e78a1781f30`; case manifest SHA-256 `295e94afa25c601c045dd736ad4266eb5c61f3136b57af609fba50f8cbb00eeb`.
- A new ephemeral organization/space/vault and Viewer user with **only `knowledge:read` and `source:read`** were created on isolated PostgreSQL `127.0.0.1:55432/akp_s2_bench`, not the main instance.
- The runner started actual `buildServer()` Fastify on `127.0.0.1` random port, used a fresh hashed bearer token and checked authentication: missing bearer returned **401**, foreign ungranted vault returned **404**. Both denied access; the latter must not be misreported as 403.
- Six actual HTTP POST calls reached `/v1/search` with `SOURCE_BACKED` mode, then the bridge consumed only the application-admitted `hits` list. Actual counts of **admitted** hits were `[0,1,1,1,0,1]`. The direct-library retrieval experiment on the same sources had yielded `[3,2,2,1,1,1]` preliminary hits: those are _not equivalent stages_. The search route's answerability gate correctly prevented exploratory-only results from silently being used as source evidence.
- All six raw HTTP search request/response buffers and every resulting exact writer provider request were frozen **before the first writer call**. With two queries returning zero admitted evidence, the writer was **not called** on those questions. Four explicit native Ollama `/api/chat` calls used `qwen2.5:7b-instruct` with SHA-256-pinned model digest, `num_ctx=8192`, `num_predict=512`, temperature 0, seed 1317.

| Observable                                            | Local development result |
| ----------------------------------------------------- | -----------------------: |
| HTTP 200 search requests                              |                      6/6 |
| Source-admitted queries                               |                      4/6 |
| Queries with no admitted evidence, writer not called  |                      2/6 |
| Native Qwen provider HTTP 200                         |                      4/4 |
| Structured JSON / source-ID contract                  |                      4/4 |
| Positive questions answered                           |                      2/3 |
| Positive questions with no admitted evidence          |                      1/3 |
| Negative questions answered when they should not be   |                      0/3 |
| Negative questions abstained                          |                      3/3 |
| Raw HTTP request/response SHA pairs verified          |                      6/6 |
| Raw model request/response SHA pairs verified         |                      4/4 |
| HTTP search socket p50 / p95 (only 6 samples)         |           27.4 / 58.9 ms |
| Local writer provider-only p50 / p95 (only 4 samples) |    1,068.5 / 24,591.5 ms |

The positive miss (case 1) is a **false abstention in this controlled fixture**. Two negatives had related application-admitted hits but the writer correctly returned empty answer and citations; one negative had no admitted hits and was short-circuited. An earlier attempt in the harness stopped when the foreign-vault test got 404, since it incorrectly required 403; the harness was corrected to accept either denial response, without any production auth change. Both the failed attempt and the subsequent successful run cleaned their scoped data.

The HTTP **search** timings include Fastify authentication, authorization, retrieval and admission within the local process over loopback. They are **not** the complete answer HTTP p95 because the Ollama writer was called separately by the experiment runner. The provider-only timing includes a cold-start-like outlier; there is no reliable steady-state latency inference or usage cost benchmark from four calls. No new external reviewer decided semantic correctness, no family-cluster uncertainty was estimated, and the synthetic negative cases do not establish release false admission rate.

All private request/response bytes, source and question content, case answers and authenticated-search diagnostics remain outside the public repo:
`section-new-family-20261021/retrieval-writer-synthetic-20261021/actual-authenticated-http-search-native-writer-20261021`.
The post-run offline auditor verified all **6 HTTP** and **4 provider** exact SHA pairs against receipt metadata, with status `FROZEN_HTTP_AND_PROVIDER_RAW_BYTES_VERIFIED_SYNTHETIC_ONLY`.

## Isolation and release boundary

A separate read-only verifier confirmed **zero residual fixture organizations, spaces, vaults, documents, units, index revisions, users and API-token rows**, and the disposable Docker container was stopped. The principal local database was not altered. The generated temporary runner and private manifests remain ignored, not committed, and may be archived separately.

The principal remaining S2 work is no longer proving that the local model can produce valid JSON or that the search route is callable: **it is explaining the false abstention, comparing the actual runtime ContextPacket to the frozen provider bytes, and evaluating previously unseen real source families with owner-custodied blind adjudication**. A frozen real-family acceptance trial and its verified semantic labels remain absent. No source-family-generalizable false admission rate, full response HTTP p95 or release confidence interval is claimed.

**S2 OPEN · E5 SHADOW · S3–S5 BLOCKED · PR #38 DRAFT/unmerged.**
