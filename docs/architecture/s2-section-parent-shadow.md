# Source-bound SECTION candidate experiment

**S2 remains OPEN.** The SECTION path introduced in PR #38 is a **library-only opt-in shadow**, not a new retrieval default, evidence admission authority, citation format or release acceptance.

## Execution boundaries

1. `queryKnowledge` completes normal scope filtering, retrieval, truth checks and rerank.
2. Only an explicitly configured internal `sectionCandidateShadowSink` requests parent candidates, and only after the caller has resolved authorization.
3. `resolveSectionCandidatesShadow` retrieves each persisted `SECTION` independently using `knowledge_units.parent_unit_id`. The query enforces same document/space/vault/corpus revision, lifecycle, trust and unit permissions, checks both path access and source-read authorization, refuses stale documents and checks `content_hash`, `locator.sourceBodyHash`, UTF-16 boundaries and raw `body_cache` text.
4. A candidate has the parent's **own ID** and locator, never the child's ID or the derived `parentContext`. Parent SECTION text is deduplicated; the sink does not modify active hits, rank, admission decisions or API responses.
5. The source-projection check does **not** authenticate the original Git/vault/source artifact. `body_cache` and the parent unit are both database projections.

## Independent original-file rebinding

`rebindSectionsToFrozenOriginal` is a **pure, offline** verifier for a custodian-authorized frozen source snapshot. It is **not wired to HTTP, admission or production search**. For each SECTION candidate, its independent original file record must provide:

- The exact vault, document, path and revision.
- Original immutable file text, **including any YAML frontmatter** and original CRLF/BOM representation.
- Its externally precommitted SHA-256. Merely computing a new hash from the current file at evaluation time does not establish an independent source freeze.
- UTF-16 `bodyStartUtf16` and `bodyEndUtf16` which select exactly the Markdown body used as `knowledge_documents.body_cache`. They must be derived from the frozen original's provenance, not by searching the projected SECTION quote.

The verifier checks full-file hash, body-projection hash, body frame, source span hash, normalized literal SECTION text, revision/identity/path matching and Unicode boundaries. It outputs status codes, digests and original-file offsets; no original text, source paths, questions, labels or excerpts. Missing/mismatched inputs fail closed; extra/duplicate snapshot records are rejected.

**Important limitation:** the function can prove byte-level consistency against the _supplied_ frozen file, but it cannot itself prove that the file was independently frozen or that its custodian had authorization. Its output always has `externalManifestAuthenticated: false`, `semanticSufficiencyMeasured: false`, `gateAccepted: false`. A separate manifest authenticity check, authorized source retrieval and review are required. Do not interpret `FROZEN_FILE_SPAN_MATCHED` as a source-of-truth certificate or proof that the answer is semantically sufficient.

If a document was OCR-transformed, edited during extraction or otherwise lacks an exact Markdown body frame, do not guess with fuzzy matching; record the failure and obtain the correct artifact provenance and locator instead.

## Pinned file-manifest validation (offline only)

`verifyPinnedSectionRebind` accepts an immutable manifest **byte string** and its SHA-256 **obtained separately before inspection**, plus authorized original file bytes and SECTION candidates. Its strict `akp.s2.section-frozen-manifest.v1` file records specify vault/document, revision, safe relative path, original-file SHA-256 and original-file body UTF-16 boundaries. The validator rejects mismatched pins, duplicate/missing/extra files, modified byte payloads, invalid UTF-8, unsafe paths, unknown record fields and inconsistent candidate identities before invoking the original-file SECTION rebinder. It preserves raw CRLF and BOM coordinate frames, does not serialize source content, and returns a diagnostic, not a new evidence authority.

**Crucial custody boundary:** `manifestPinMatched: true` means only that the given manifest bytes match the provided digest. There is no cryptographic or operational proof that this digest came from an independent custodian, that a version was immutable at freeze time, that the files were lawfully accessible, or that their evidence answers the user's question. Output always sets `externalCustodyIndependentlyAttested: false` and `gateAccepted: false`. Never derive `trustedManifestSha256` from the same manifest at evaluation time for a real S2 gate, and never put private manifests or originals into GitHub.

## Paired SECTION capture: preparation-only comparison

`scoreSectionPairedShadow` (package `@akp/evaluation`) and the explicitly offline `scripts/s2-score-section-paired.ts` consume **new, precommitted** case identities and separately captured search-vs-SECTION observations. Do not use any of the already inspected 200 tasks or the historic public 48-question calibration material as an independent holdout.

Prepare an access-controlled, UTF-8 JSON manifest with exact schema `akp.s2.section-paired-manifest.v1` containing `executedCommitSha` (40 hex), `sourceManifestSha256` (64 hex), and `cases` with unique `caseKeySha256`, `scopeSha256`, `sourceFamilySha256`, and `language` (`en` or `es`). The **SHA-256 of the raw manifest bytes must be fixed and retained separately before collecting the run**, in a text file containing just the hex digest.

Record a distinct `akp.s2.section-paired-run.v1` file on that same source manifest and executing SHA, with `mode: "SHADOW_ONLY"` and one `captures` entry per manifest case. Each capture contains exact `caseKeySha256`, `scopeSha256`, measured child-only `childRequestMs`, `childDegraded`, the exact identities of authorized child hits as `eligibleChildKeysSha256`, measured incremental `sectionLookupMs`, `shadowErrorCode: null` (or a redacted error code and zero candidates), and `sectionCandidates` with `sectionKeySha256`, `childKeySha256`, `originalStatus` from the separately executed frozen-original source verifier. The runner verifies every candidate belongs to the recorded authorized child pool; a frozen-file match is **not** sufficiency or an accepted answer.

Run **locally** with all source/case inputs in private storage:

```sh
pnpm exec tsx scripts/s2-score-section-paired.ts \
  --manifest /secure/section-cases.json \
  --pin-file /independent-custodian/section-cases.sha256 \
  --captures /secure/section-captures.json \
  --output /secure/section-paired-aggregate.json
```

This emits **aggregates only**: EN/ES counts, source-family count, eligible child counts, proposed and original-file-matched parent counts, per-status rejection counts, shadow errors, child-only full request p95 and _incremental parent lookup_ p95. It rejects duplicate/foreign questions, mismatched scopes or revisions, malformed status and input fields, invented labels, misplaced parent identities and non-pinned manifests. Output is created without overwrite.

The parent arm has **not** yet generated answers or changed application admission. Its full-request p95, semantic citation precision, false admission rate, correctness, cost and independent holdout provenance are **not measured**. The aggregate is always `DESCRIPTIVE_ONLY_NOT_GATEABLE`, with `independentHoldoutEstablished: false`, `groundTruthLoaded: false`, `actualSectionAdmissionMeasured: false` and `gateAccepted: false`. Even a matching manifest SHA does not establish independent source-family assignment or reviewer independence. Do not use a post-hoc, self-generated pin for a release gate.

## Tests and measurement

- Synthetic unit tests cover CRLF, frontmatter, surrogate pairs, source modification, file/section hash mismatches, identities and duplicates.
- The SECTION projection-path integration test runs with a disposable PostgreSQL fixture in CI.
- The private 200-question development set and historical 21 potentially newly visible quotes are **not** independent acceptance data. No semantic precision, negative false-admission rate, grounded answer correctness or live latency lift can be asserted from these tests.
- Before any product change, freeze a new family-disjoint EN/ES corpus and manifest and compare child-only vs SECTION shadow under identical authorization, fixed reader/target tokenizer settings, request budgets, provenance, exact quotes, correct answers, errors, and paired p50/p95. Keep the application admission gate unchanged until an independent adjudication and an explicit decision.

S2 OPEN · E5 SHADOW · S3–S5 BLOCKED · PR #38 DRAFT / unmerged.
