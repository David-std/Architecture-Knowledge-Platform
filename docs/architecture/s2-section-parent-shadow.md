# Source-bound SECTION candidate experiment

For future publisher-family-disjoint evaluation preparation, independently signed freeze verification and **exact provider passage/request byte capture**, see [S2 independent evaluation readiness](./s2-independent-evaluation-readiness.md). These are opt-in, offline development tools only; they do not amend the existing S2 gate or historic writer traces.

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

This **offline scorer** does not generate answers or change application admission. A separate private MDN development run did exercise a local writer on 5 SECTION-enriched pairs, but its outputs were not independently adjudicated and cannot be used as release gold. Its full-request p95, semantic citation precision, false admission rate, correctness, cost and independent holdout provenance are **not measured**. The aggregate is always `DESCRIPTIVE_ONLY_NOT_GATEABLE`, with `independentHoldoutEstablished: false`, `groundTruthLoaded: false`, `actualSectionAdmissionMeasured: false` and `gateAccepted: false`. Even a matching manifest SHA does not establish independent source-family assignment or reviewer independence. Do not use a post-hoc, self-generated pin for a release gate.

## Offline blind-reviewer packet and submission audit

`auditSectionBlindReviews` in `@akp/evaluation` and `scripts/s2-audit-section-blind-reviewers.ts` validate the **previously frozen, private** two-packet reviewer protocol. The operation never writes to the vault, production database, retrieval or admission. The private case and source manifest bytes are compared to their frozen SHA-256 digests; both unmodified packet bytes must match the reviewer-packet receipt. The auditor independently binds each packet's original Markdown text, source frame and source digest to the original-file bytes from the frozen manifest, then recomputes every question key from language and exact question text. This rejects hidden labels, silently changed questions, swapped source revisions, duplicate/missing files and packets, and deviations in original UTF-16 coordinates.

The original packets **remain immutable** when reviewers respond. A reviewer submits a distinct `akp.s2.section-blind-review-submission.v1` JSON with `reviewerAssignment` ("A"/"B"), `packetSha256`, and complete `cases` containing `questionKey`, `answerability`, `answerText`, `quotes`, `note`. Allowed classifications: `ANSWERABLE_EXPLICIT`, `NOT_ANSWERABLE`, `AMBIGUOUS`, `CONTRADICTED`. Each quote is an object containing `documentKey`, `startUtf16`, `endUtf16`, `quote`. Exact original-file UTF-16 offsets must be inside the source body, never split a surrogate pair, and match the literal source string; duplicate spans or foreign sources fail closed. A positive label requires an answer and at least one literal quote; a `NOT_ANSWERABLE` label requires no answer or quotes.

Run the preflight, with **no responses yet**:

```sh
pnpm exec tsx scripts/s2-audit-section-blind-reviewers.ts \
  --private-dir /secure/section-new-family-20261021 \
  --output /secure/section-new-family-20261021/reviewer-preflight.json
```

After acquiring two separately submitted results, include `--submission-a` and `--submission-b` pointing to their private JSON files. A response from only one reviewer is rejected. The audit reports only overall agreement/disagreement counts and exact original-file quote counts, never raw questions, answers or source text. Do not overwrite the original packets or an existing report.

**Crucial:** original-file quote identity does not establish whether a quote supports the answer, whether a claimed `CONTRADICTED` item is really contradicted, reviewer independence, consensus, external source custody, or an S2 FAR/correctness gate. All these fields are explicitly `false` or `null`, even with two structurally valid submissions. A separate independent human/authorized-review process is still required. The MDN development packets are not the preregistered independent holdout.

## Tests and measurement

- Synthetic unit tests cover CRLF, frontmatter, surrogate pairs, source modification, file/section hash mismatches, identities and duplicates.
- The SECTION projection-path integration test runs with a disposable PostgreSQL fixture in CI.
- The private 200-question development set and historical 21 potentially newly visible quotes are **not** independent acceptance data. No semantic precision, negative false-admission rate, grounded answer correctness or live latency lift can be asserted from these tests.
- Before any product change, freeze a new family-disjoint EN/ES corpus and manifest and compare child-only vs SECTION shadow under identical authorization, fixed reader/target tokenizer settings, request budgets, provenance, exact quotes, correct answers, errors, and paired p50/p95. Keep the application admission gate unchanged until an independent adjudication and an explicit decision.

S2 OPEN · E5 SHADOW · S3–S5 BLOCKED · PR #38 DRAFT / unmerged.

## Reviewer answerability, proposition polarity and writer-response fidelity

The development adjudication originally compared the four-way verdicts of two reviewers. Those **frozen labels remain unchanged**. The `summarizeDualAxisReviews` module describes distinct axes: (1) `EXPLICITLY_DECIDABLE`, `NOT_SUPPORTED`, `AMBIGUOUS` or `DISPUTED` as a _provisional_ evidence-disposition projection; (2) the original claim-polarity annotation relationship, including `MIXED_CONTRADICTED_AND_EXPLICIT`. A supported answer of **No** is not equivalent to lack of an answer. Even when A/B agree on `ANSWERABLE_EXPLICIT`, their proposition-polarity judgment remains unresolved until manually reviewed. The test-only normalization does not rewrite labels or validate independently attributable reviewer identity.

Separately, `buildBlindedWriterReviewPackets`, `scripts/s2-prepare-writer-semantic-review.ts` and `auditWriterSemanticReviewPackets` prepare and audit **new anonymous reviewer tasks for already frozen local writer outputs**, without invoking or retuning the writer. This output is meant solely for private, development-only diagnosis. Preparation must revalidate the original two-reviewer submissions against the frozen source, case and packet manifests. The original writer run is pinned by its SHA-256, and the builder checks original Markdown bytes, frozen source/body coordinates, exact task hashes, response status and permitted evidence IDs. The packets include original Markdown and the question/output text but neither prior gold labels nor which retrieval arm generated an answer. A fresh 32-byte owner-only seed determines private response IDs and randomized presentation. **Only the private owner mapping** retains `CHILD_ONLY` / `VERIFIED_SECTION_ENRICHED` identities and original `SRC` / `SECTION` citation IDs; the reviewed packets use neutral `CIT1`, `CIT2` names. The private seed and map must never be sent to reviewers.

```sh
pnpm exec tsx scripts/s2-prepare-writer-semantic-review.ts --private-dir /secure/section-frozen-experiment
pnpm exec tsx scripts/s2-audit-writer-semantic-review.ts --private-dir /secure/section-frozen-experiment --output /secure/section-frozen-experiment/writer-review-preflight.json
```

Each semantic reviewer receives only their separately frozen `writer-semantic-reviewer-x-v2.json` or `writer-semantic-reviewer-y-v2.json`, and their **empty submission template**; the owner's receipt and private arm map stay undisclosed. Reviewer assessments separate source answerability, factual faithfulness of an `ANSWER` (fully supported, partially supported, unsupported/wrong, undecidable) and whether an `ABSTAIN` was justified. They must provide exact original-file UTF-16 quote spans when asserting fully supported claims or unnecessary abstention. The future auditor checks packet SHA-256, complete reviewer scope, exact UTF-16 literal matches and only aggregates agreement/disagreement. It does not accept a single submission or treat agreement as semantic truth.

**Important provenance limitation:** historical writer captures saved citation IDs but **did not freeze a complete mapping from those IDs to the exact passages delivered at inference time**. These new packets can support human factual assessment _against the independently re-fetched originals_, but cannot certify that an inference-time `SRC1` or `SECTION1` citation precisely supported the whole answer. The packet and audit always state `fullModelCitationSourceMappingAvailable: false` and `semanticSupportIndependentlyEstablished: false`. Future acceptance experiments must capture the actual presented source spans, frozen raw bytes, model input/tokenizer and output hashes together and independently adjudicate the claim-to-citation linkage.

The older **v1 semantic review packets** were an internal preflight: their `SECTION1` identifier could reveal the arm, so they are **superseded and must not be distributed**. Only the neutral-reference **v2 packets** are eligible for the next private development review; even v2 does not establish independent reviewer status, an independent publisher-family holdout or S2 release acceptance.

S2 OPEN · E5 SHADOW · S3–S5 BLOCKED · PR #38 draft/unmerged.

## Submitted X/Y semantic reviews: immutable original and strict compatibility

The two development reviewer returns arrived after the v2 packet freeze with the expected packet SHA-256 bindings and all 13 response identities. They are **not canonical-schema responses**: reviewer X supplied an additional `sourceSha256` with each quote, reviewer Y omitted `documentKeySha256`, and both used `ANSWERABLE_EXPLICIT`, `NOT_ANSWERABLE` and `FULL` instead of `EXPLICITLY_DECIDABLE`, `NOT_SUPPORTED` and `FULLY_SUPPORTED`. Never silently change the original submitted files or loosen the canonical auditor.

`adaptWriterReviewSubmission` and `scripts/s2-reconcile-writer-review-submissions.ts` implement a **fail-closed, auditable development-only migration**: exact reviewer packet SHA-256 verification, original source-text SHA-256 verification, frozen response-to-document identity, literal UTF-16 original-file source text/offset verification with surrogate boundaries, duplicate/foreign quote protection, strict label allowlists and complete X/Y coverage. The extra X source hashes must equal the frozen originals; missing Y document identities are resolved **only from that response's own pinned original v2 packet**, never from X's labels or guesses. Label mappings are explicit; original raw bytes, notes, labels, and source provenance are preserved. Normalized outputs and a hash-linked compatibility receipt are created only in ignored/private storage using exclusive writes. A second pass through the existing `auditWriterSemanticReviewPackets` is mandatory.

```sh
pnpm exec tsx scripts/s2-reconcile-writer-review-submissions.ts \
  --private-dir /secure/section-frozen-experiment \
  --submission-x /secure/submission-X-original.json \
  --submission-y /secure/submission-Y-original.json \
  --output-prefix /secure/section-frozen-experiment/writer-reviewed
```

On the four original MDN documents, the development-only capture produced **13/13 matched classifications** and **20/20 exact original-file UTF-16 quote spans** (11 X and 9 Y); nine document identities absent from Y were re-bound to the pinned Y packet and eleven explicit X source hashes matched. Both submissions mark `independentReviewAttested=false`. All four writer positive responses were classified `FULLY_SUPPORTED`, five abstentions `UNNECESSARY`, and four `JUSTIFIED`. No released answer-label ground truth is being inferred from model self-reports: these are third-party-submitted _labels with structural evidence verification_, not independently authenticated semantic truth. The owner-only descriptive arm-map reconciling script `scripts/s2-summarize-writer-reviews.ts` reports the original small, observational comparison without computing production FAR or changing thresholds.

**Unresolved acceptance gaps:** submitted label agreement is not authenticated reviewer independence; original-source quote equality is not an entailment proof; old Qwen traces lack complete inference-time source-ID→passage mapping; reused MDN development questions are not independent publisher-family holdout; there is no new full-HTTP p95/cost/cluster uncertainty assessment. Keep all gate flags false, S2 OPEN, E5 SHADOW and S3–S5 BLOCKED. Do not merge or promote SECTION based on this development observation.
