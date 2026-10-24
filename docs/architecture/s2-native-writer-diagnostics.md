# S2 local native structured-writer diagnostics

**Scope: offline synthetic/development only.** This component does not modify the AKP runtime search route, allow SECTION admission, repair already failed historical outputs or satisfy a release gate. S2 OPEN, E5 SHADOW, S3–S5 BLOCKED; PR #38 draft.

## Why this work was added

The owner-custodied 8-case Node.js/Rust _pilot_ produced 8/8 HTTP 200 responses from the local Qwen writer, but only **1/8** met its expected JSON object contract. The writer was sent the **oracle-assigned correct original document** (not AKP retrieval), so this result isolates a practical writer/payload concern, not a retrieval quality measurement. Some responses ended at `max_tokens=260`; six prompt usages were 2,050 tokens, suggesting a possible default small context window, without proving why the model did not obey instructions. The eight original frozen provider requests/responses and output failures remain immutable in the owner's private evidence directory.

The previous probe used Ollama's OpenAI-compatible `/v1/chat/completions` route with `response_format.type=json_object`. JSON mode does **not** require a specific set of keys. In the local Ollama server, configuring the effective context size through this compatibility endpoint is nontrivial: the official documentation recommends a `Modelfile` with `PARAMETER num_ctx`, whereas native `/api/chat` accepts `options.num_ctx`. Ollama's native structured-output API additionally accepts a JSON schema in `format`. This implementation takes the **local native route** to make both parameters explicit, reproducible, and verifiable:

- Official native API: https://github.com/ollama/ollama/blob/main/docs/api.md
- Structured output: https://github.com/ollama/ollama/blob/main/docs/capabilities/structured-outputs.mdx
- Compatibility context limitation: https://github.com/ollama/ollama/blob/main/docs/api/openai-compatibility.mdx

## New pure evaluation module

`packages/evaluation/src/s2-native-structured-writer.ts` exposes `freezeNativeStructuredWriter` and `observeNativeStructuredWriter`.

The first reuses `freezeExactWriterRequest` for complete source SHA-256, question identity, exact literal original UTF-16 offsets and provenance verification. It constructs and hashes **the byte-identical provider-facing** `/api/chat` payload containing source IDs, prompt, `stream:false`, a required JSON schema with `answerText:string`, `citations:string[]`, `abstained:boolean` and no extra fields, `temperature:0`, seed, `options.num_ctx` and `options.num_predict`. The prompt places the question **after the source passages** and spells out no-answer behavior. The preflight rejects inputs exceeding a conservative UTF-8 byte/context heuristic; it is **not** a tokenizer or conclusive no-truncation proof.

The second binds raw exact request bytes to their prior SHA-256 freeze, parses the native envelope, requires completed `done_reason:stop` and provider token usage, flags near-budget context, and then **fail-closes** if the response has missing or extra keys, invalid JSON, an invented or duplicate citation ID, no citation on nonempty claims, or any conflict between `abstained` and the presence of claims. It only reports **structural validity and citation-ID membership**; it does NOT automatically certify whether the answer is true, whether the cited exact passage entails it, or whether a negative is absent from all authorized sources.

## Private synthetic-only local CLI

```powershell
pnpm exec tsx scripts/s2-probe-native-structured-writer.ts --spec "C:\private\synthetic-probe.json" --spec-pin-file "C:\private\synthetic-probe.sha256" --output-dir "C:\private\unique-probe"
# With an entirely synthetic source and case, enable local execution deliberately:
pnpm exec tsx scripts/s2-probe-native-structured-writer.ts --spec "C:\private\synthetic-probe.json" --spec-pin-file "C:\private\synthetic-probe.sha256" --output-dir "C:\private\another-unique-probe" --execute-local
```

The CLI is **freeze-only by default**; it checks the spec SHA-256 and original source digests, writes frozen request metadata and the **exact provider request buffer before any call**, pins the local Qwen model digest via `/api/tags`, sends to `127.0.0.1:11434/api/chat` only on explicit execution, writes raw response bytes, strict parse/audit and provider timing into the exclusive-create private directory. It uses `num_ctx=8192` and `num_predict=512` as an explicit **development candidate**, not as release threshold, and keeps the model-selection policy unchanged. Request and response contain confidential passages and must never be committed.

## Honest gates

- Existing eight-case owner pilot is **already exposed**. Tuning diagnostics or prompts after viewing its failures cannot retroactively improve that same holdout.
- Use synthetic, non-target examples for local API/schema/context troubleshooting; **do not rerun the same eight as a fresh accuracy metric**. A follow-on genuinely new owner-precommitted batch must be frozen before testing the final configuration.
- The native API can still truncate context if its effective model context is exhausted. Response usage is informative but not a cryptographic proof of full prompt ingestion.
- Structural JSON passing does not establish semantic source fidelity; actual AKP authorized retrieval, negative FAR, end-to-end application p95, cost and source-family uncertainty require separate future measurement.

## Measured development-only local observations, 2026-10-21

All three raw request buffers and raw response buffers were frozen and saved in private, exclusive-create directories on the owner's PC; each request used the same pinned local `qwen2.5:7b-instruct` digest and explicit `options.num_ctx=8192`, `options.num_predict=512`, seed 1317 and temperature 0. The observation parser returned `STRUCTURALLY_VALID` and `done_reason=stop` for **3/3 synthetic trials**. All three HTTP calls were 200:

| Synthetic scenario                          | Provider prompt tokens | Output tokens | Result                                                                |
| ------------------------------------------- | ---------------------: | ------------: | --------------------------------------------------------------------- |
| Generic, very short synthetic original      |                    123 |            23 | Well-formed empty abstention (not a semantic assessment)              |
| Explicitly unsupported fictional question   |                    129 |            23 | Well-formed empty abstention                                          |
| Long fictional source, unique answer at end |                  3,274 |            39 | Required JSON with answer `PURPLE-ORBIT-73` and known citation `SRC1` |

The final synthetic input went **beyond** the legacy pilot's repeatedly observed 2,050 prompt-token count, giving reproducible evidence that the **new native route can account for longer prompts** with explicitly set context. This is not a proof of universal no-truncation for other documents. The long-source output matches its deliberately planted synthetic answer, but neither these 3 examples nor the 7 code unit tests prove general writer factual accuracy.

Historical pilot: **1/8 contract-valid on assigned real sources, under a different adapter and generation settings**. Current synthetic diagnostics: **3/3 structural-only**, different questions and context. These rates are NOT a controlled head-to-head comparison or evidence of S2 promotion. The old owner-approved eight are never reclassified after seeing these fixes. Run a brand-new pinned owner-controlled batch to assess the eventual writer configuration without data reuse.
