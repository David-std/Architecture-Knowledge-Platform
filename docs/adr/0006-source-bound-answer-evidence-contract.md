# ADR 0006 — Source-bound answer evidence as one retrieval contract

- **Status:** Proposed. The source-value transport has code and contract tests; semantic admission and end-to-end release are **not accepted**.
- **Date:** 2026-10-25.
- **PR:** [#38](https://github.com/David-std/Architecture-Knowledge-Platform/pull/38), remains draft.
- **Decisions superseded:** the old optional extracted-answer check inside `ReaderEvidenceVerifier`; not ADR 0004 or the source/knowledge trust boundary in ADR 0005.
- **Evidence:** [S2 master ledger §§45–49](../architecture/s2-semantic-experiments-and-integration-ledger.md), [retrieval-flow audit](../architecture/retrieval-flow-audit.md), [admission research](../architecture/evidence-admission-research.md), [S2 detailed pipeline diagnosis](../architecture/s2-pipeline-diagnosis-and-candidate-lab.md).

## Context

AKP is a governed context and coordination system, not a model-generated authority. S2 has repeatedly failed in three _different_ places: retrieval can find a relevant document but miss the answering leaf excerpt; the reader can select an incomplete subquote or misinterpret a relation; and the admission boundary can discard an otherwise genuine answer value. Provider timeouts are a fourth, operational, source of abstention. These must remain separately observable. Evidence of a source's literal identity is never independent proof that it answers the question.

The production reader v5 returns `needed` (requested fact), `answer_span` (claimed quote), `answer` (extracted value) and `verdict`. Previously the verifier stripped `needed`/`answer`, source verification normalized away all value detail, and `LayeredEvidenceAdmissionPipeline` saw only a decision and quote offsets. The structural guard then inferred the requested quantity from raw textual digit presence. A quotation of `tres` could fail for lack of a digit; a digit in an identifier or in another relation could pass a necessary textual cue. Neither consequence is repaired safely by a table of English/Spanish cardinal synonyms. The S2 generality policy has already rejected such runtime-specific heuristics.

## Decision and one owner

`packages/retrieval` owns **one** passage-local answer evidence contract. `QueryConditionedAnswerEvidence` contains the model-proposed `requestedFact`, `answerText`, a `LITERAL|POLARITY` classification, and for literal values the original UTF-16 `valueSpan`. Its enclosing `QueryConditionedEvidenceVerification` carries source `evidenceSpan`; no additional provider- or language-specific adapter is required.

A single source-local function (`answer-value-evidence.ts`) finds a unique original UTF-16 answer occurrence, permitting only NFC canonical Unicode composition, case and whitespace normalization while **not** translating, parsing word numbers, replacing synonyms or matching substrings of words and hyphenated identifiers. Repeated, unbound, tampered or invented values do not acquire a source span.

`ReaderEvidenceVerifier` attaches the value to the same cited passage. `validateSourceBoundVerification` verifies ranges, surrogate boundaries, visible source, quote containment, uniqueness and value identity and preserves the answer evidence. `QueryConditionedSemanticEvidenceReader` passes it to `LayeredEvidenceAdmissionPipeline`; the structural guard revalidates the value against the hit being admitted, independent of the earlier verifier call. A `POLARITY` answer is separately typed because a literal `yes/no` need not appear in a prohibitive or permissive source sentence; its truth and complete question relation remain model proposals, not settled by typing.

**Authority is unchanged**: ACL, vault, revision, trust and lifecycle precede retrieval; only source-bound `ANSWERS` with the existing guard can become admitted hits. No exploratory hit is promoted, no language normalization creates an answer, and neither a literal value nor a model's `SUPPORTS` certifies subject/predicate/direction/negation/time/condition. The in-memory `answerEvidence` must not be serialized in public search traces or ContextPackets. Citations and writer claims still require separate source and per-claim verification.

## Cutover and compatibility

The superseded `requireExtractedAnswerInQuote` flag and its duplicate search logic are removed rather than preserved behind a legacy switch. For structured reader v5 verdicts, an extracted value without a unique anchored occurrence fails closed. Other `QueryConditionedEvidenceVerifier` implementations (local QA/cross-encoder) still have their own evidence protocols; they do **not** receive fabricated answer slots. This is a contract migration inside the existing modular monolith, without database migration or new network API fields. Provider-specific and unstructured verifier interfaces must be inventoried and consolidated at the next accepted cutover, rather than wrapped indefinitely.

This migration can increase abstention on sound **nonliteral** paraphrases and cross-language answers; normalized literal Unicode/whitespace is maintained. This is a known quality risk, not a claim of precision improvement. Existing digit-only structural requirements are deliberately **not** bypassed by spelled-out cardinal values, until a role-complete source-bound numeric verifier is calibrated. A `valueSpan` alone must never satisfy quantity sufficiency.

## Evidence required before acceptance

- Compare the same frozen authorized source revisions and requests before/after migration, including source-family-disjoint EN/ES examples and hard negatives.
- Measure at least: source/answer-bearing excerpt recall, reader quote/value-slot recall, role-complete claim accuracy, no-answer false admissions and false abstentions, ContextPacket and final-answer citation coverage, model errors/timeouts and HTTP p95. Disclose uncertainty and whether labels are internally AI adjudicated or genuinely independent.
- Verify relations with negation, direction, conditions, qualifiers, identifiers, temporal constraints, tables, and hostile instructions inside documents. Model agreement is not independent human approval.
- Run an authenticated real SOURCE ingest → reviewed KNOWLEDGE → query → admitted packet → writer → authorized scoped tool E2E. Verify identity, revision and ACL at each boundary; compare baseline.
- Only after acceptance, retire redundant evaluators/old paths according to ADR 0004 and the core-redesign execution spec. Until then do not turn LAYERED on by default or merge PR #38.

**Gate remains:** S2 OPEN · E5 SHADOW · S3–S5 BLOCKED.

## Controlled next cut: structural value requirement (2026-10-26)

The first code-backed contract repair is not a semantic proof. An additional weakness existed in `StructuralEvidenceGuard`: after accepting a uniquely source-bound `answerEvidence`, the final count/year check still inspected **numbers anywhere in the selected quote**. A genuine model-proposed answer such as `approval` could therefore pass the necessary numeric cue because the same paragraph mentioned `17 archive files`, even though that was not the requested approval count. The same failure mode applies to incidental years.

The product guard now retains its existing quotation-level quantity/date checks **and**, where the reader supplies `answerEvidence`, requires the separately validated literal **answer value span** to satisfy the required quantity or date. A typed `POLARITY` answer does not satisfy numeric/date requirements. Failure has a distinct stable reason, `STRUCTURAL_ANSWER_VALUE_REQUIRED_FACT_MISSING`, while the earlier `STRUCTURAL_REQUIRED_FACT_MISSING` still denotes a quote-level gap. This is a **necessary condition only**: a digit may still name a different entity or relation; it cannot establish the correct subject/predicate/time/condition without independent relation verification. No spelled cardinal is equated with a digit and no exploratory evidence is promoted. Verifiers without structured answer slots retain their previous fail-closed semantic source checks; consolidating their distinct protocols is a separate cutover obligation.

Source-bound value tests exercise the complete reader → source validator → `LayeredEvidenceAdmissionPipeline` for incidental count, incidental year, spelled cardinal, and a genuine digit. Because successful decisions preserve the reader's source reason, not the guard's internal reason, tests assert `READER_QUOTED_ANSWER` on a structural pass rather than inventing a synthesized guard reason. Negative decisions preserve the guard's distinct failure reasons. Release remains subject to prospective source-family-disjoint EN/ES semantic role and whole-answer correctness metrics. No proof of semantic sufficiency or S2 closure is claimed here.

## Experiment rejection and governed provenance boundary (2026-10-26)

An attempted general matcher/pipeline cut at `d6dc7bfe` was not accepted by the predeclared family-disjoint proposition benchmark (development 6/8, heldout 4/8). All disagreements were layer-attribution differences for abstentions, but the exact immutable oracle is binding; it must not be edited to manufacture a pass. The general matcher and its pre-existing fallback contract were restored, rather than creating an indefinite parallel implementation. The rejected experiment remains in Git and ledger §51.

The independent governed temporal-fact **shadow** path now requires source-document identity (space/vault/document/path/current revision/lifecycle) and credential path authorization in persistence before evidence lookup. It rejects missing query polarity and unsupported qualifiers instead of pretending the existing exact matcher verifies complete linguistic relations. This does not grant authority to model-generated propositions and does not alter production LAYERED admission. Connecting structured roles to authenticated HTTP requires an explicitly authorized and independently grounded original-query projection and comprehensive source-bound relation proof. No semantic S2 acceptance is claimed.

## Governed SOURCE attestation prerequisite (2026-10-26)

An authorized KNOWLEDGE document/revision is necessary but not sufficient to justify a proposition with a raw SOURCE excerpt. The existing single governed-temporal shadow bridge now additionally requires a `supported_by` document–evidence edge, an ACTIVE source in the same space and vault, and an associated source artifact whose `source_hash` matches the source's current SHA-256. Conflicting-only document relations, withdrawn sources and stale source-artifact revisions fail closed. This is tested by mutating each property against a real disposable PostgreSQL instance and confirming restoration only after a valid source chain returns. It is still a prerequisite, **not proof of what the original question asks**; the explicit query roles have no independent semantic authority yet. No production HTTP admission/default is changed.

## SOURCE-locator revision and excerpt-digest integrity precondition (2026-10-26)

The governed shadow path now requires each evidence locator's `source_hash` to equal the ACTIVE raw SOURCE record's `sha256`. The retrieval projection independently recomputes SHA-256 over the exact UTF-8 bytes of every stored evidence excerpt and requires equality with its persisted `content_hash`. This preserves the Worker's pre-existing excerpt hash and source locator contract while refusing missing/old SOURCE locator revisions, altered excerpts and corrupted content hashes; it is not normalization, inference or a synonym rule. Missing legacy locator hashes fail closed **only in this shadow path**; there is no DB migration or change to production reader defaults.

This protects internal integrity and revision binding, but the SOURCE store is **not re-read** and SHA-256 of a stored excerpt is not proof that the excerpt appears in a canonical raw object or that the quoted proposition entails the question. A future candidate admission authority must verify original immutable bytes and authorized source locators, then separately bind the question's roles/conditions, answer value, ContextPacket and per-claim citations under pinned ACL/revision. The heldout oracle is unchanged; S2 remains unaccepted.
