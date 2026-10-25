# S2 owner-controlled evaluation pilot

The Architecture Knowledge Platform is an individual project. Its owner may act as the **source and question custodian** and may appoint two **blind, separate AI-assisted reviewer sessions**. Such reviews can be useful for reproducible internal evidence, but they are **not externally independent certification**, even with full agreement or a key signature. All existing S2 release controls and gate statuses remain unchanged.

This pilot closes implementation gaps in **pre-run freezing**, source-byte provenance, response-blind review dispatch and exact UTF-16 quote validation. It does not close semantic acceptance, release FAR, p95/cost or the external independence criterion.

## Candidate sources and case preparation

Start from the separately SHA-frozen original Markdown manifest previously fetched from the official Node.js and Rust Git repositories. The owner must explicitly approve the source sample, task composition and the complete proposed question manifest **before any writer call**. If more suitable or genuinely independent source families are needed, the owner may reject the sample. Every changed source must have a new immutable commit, digest and manifest.

A first **eight-question process test** includes one answerable and one unsupported question in English and Spanish for each of the two source families. It is intentionally **too small and too family-limited** for release claims. Every proposed positive needs a non-empty owner answer and one **unique exact literal original-file excerpt**. Every proposed unsupported question has an empty expected answer and empty supporting excerpt. The latter represents an owner **proposal** about absence, not proof of absence. An appointed reviewer must check the relevant entire source. Unsupported in one file must never be mistaken for unsupported in the whole authorized corpus.

Only these owner-edited, private files may supply questions. The implementer must **not** backfill post-hoc cases from model answers or re-use the eight MDN development questions or 200 inspected tasks. Use a new clean conversation for composing and cross-checking the draft, without exposing prior AKP writer results.

## Offline owner workflow

The **private, unfilled** `owner-human-editable-case-draft.TEMPLATE.json` contains eight source/language/disposition slots. The owner verifies the questions and exact source evidence and manually sets `approvedByOwner=true` and `reviewedBeforeWriterExecution=true` only after completing the review. Do not set these automatically for real data. All commands below run from PR #38's experimental worktree with private paths:

```sh
pnpm exec tsx scripts/s2-finalize-owner-case-proposals.ts \
  --candidate-dir /private/frozen-source-candidates \
  --draft /private/owner-approved-draft.json \
  --output-dir /private/unique-owner-freeze

pnpm exec tsx scripts/s2-prepare-owner-holdout.ts \
  --candidate-dir /private/frozen-source-candidates \
  --owner-cases /private/unique-owner-freeze/owner-case-proposals.json \
  --case-pin-file /private/unique-owner-freeze/owner-case-proposals.sha256 \
  --output-dir /private/unique-owner-review

pnpm exec tsx scripts/s2-audit-owner-holdout-reviews.ts \
  --review-dir /private/unique-owner-review \
  --output /private/unique-owner-review/owner-preflight.json
```

The finalizer authenticates the candidate manifest and original files, locates every distinct positive support quote **exactly once**, derives UTF-16 offsets without fuzzy search, creates SHA-256 question keys and a new raw case manifest, checks full family × language × polarity coverage, then writes a **separate non-overwriteable SHA-256 pin**. The blind packet builder revalidates the original Git blob SHA-1, SHA-256 and byte count, source family and paths before producing two independently shuffled X/Y packets with original sources and questions but **without owner gold or writer output**. The original case manifest remains owner-private. The auditor verifies the two packet hashes and every question/source identity, then any submitted citations against the frozen original text and UTF-16 offsets, rejecting partial/foreign/modified cases.

Give reviewer X only `s2-owner-reviewer-x-packet.json` and `s2-owner-reviewer-x-empty.json`, and give Y only their corresponding Y files. In the completed submissions, each case may be `ANSWERABLE_EXPLICIT`, `CONTRADICTED`, `NOT_ANSWERABLE` or `AMBIGUOUS`. Positive/refutative answers require exact literal source quotes with `sourceKeySha256`, `startUtf16`, `endUtf16`, and `quote`; genuinely unanswered cases must contain no answer or source quotes. Both complete submissions are necessary to run a structural audit; none may be replaced by generated labels. Agreement is only a descriptive measurement, not a semantic entailment proof.

## End-to-end synthetic readiness proof

A completely **synthetic** two-publisher fixture was exercised through all three offline CLIs with eight generated illustrative questions and no model run. It produced `OWNER_PROPOSALS_PRECOMMITTED_NOT_EVALUATED`, `OWNER_CUSTODIED_BLIND_PACKETS_PREPARED` (X/Y) and `OWNER_PACKETS_VERIFIED_UNREVIEWED`, with 0/2 reviewer submissions. This fixture is explicitly **not an approved owner question set** and not acceptance data. Separately, the local Qwen 7B synthetic-passage test successfully captured an exact before-send request SHA and after-send response SHA; its provider-only latency is not production HTTP p95.

## Honest measurement tiers

- **Synthetic**: tests of storage, hashes, UTF-16 boundaries and blind packet workflow, no claims about real questions.
- **Owner-controlled pilot**: source bytes and question precommit verified, blinded second opinions and exact source quotes possible, but independent institutional provenance not claimed.
- **Acceptance-quality external holdout**: only after independently verified custody and reviewer identity/protocol, entirely new case families, preregistered metrics and thresholds, enough source families for clustered uncertainty, actual HTTP request p50/p95, model-token/cost capture, claim-to-exact-inference-passage adjudication and FAR/false-abstention evaluation.

A precommitted SHA or owner signature does **not** by itself establish an external custodian. None of these steps changes `queryKnowledge`, authorizations, API citation rules, production admission, SECTION shadow status or E5 configuration. No gates should be closed from this pilot alone.

**S2 OPEN · E5 SHADOW · S3–S5 BLOCKED · PR #38 DRAFT and unmerged.**

## Owner-approved AI-only review continuation (2026-10-25)

The owner explicitly authorizes the AI operator to select new permitted official sources, operate the **fully isolated** test lab, prepare and freeze EN/ES questions, execute the actual authenticated search/reader/writer, and produce completed **AI self-custodied / dual-model** development adjudication without a human reviewer. This supersedes an assumption that each _internal development iteration_ requires manual owner input; it does NOT assert that a model is a human or that two prompts/models constitute external procedural independence. Do not automatically set historic fields declaring human approval or reviewer identity.

Two valid but non-equivalent milestones are now explicitly distinguished:

- **INTERNAL_AI_SOURCE_REVIEW_COMPLETED:** source bytes/Git blob and original spans pinned; complete raw model requests frozen _before_ calls; developer-created gold not delivered in prompts; distinct pinned model reviewers produce separately hash-sealed opinions; quotes must be exact original substrings; disagreement, unsupported quotes, ES/EN biases and errors preserved; author-gold comparison performed only after raw capture. This is the owner's requested no-human workflow and may be recorded as completed after the receipts pass.
- **INDEPENDENT_EXTERNAL_ADJUDICATION_NOT_ESTABLISHED:** no externally verified reviewer/custodian identity, genuinely unknown publisher/task distribution, independent human-origin observations or uncontaminated external blind holdout. Never rename the first milestone to the second or imply that signed self-authored JSON is independent certification.

The concrete new official family-disjoint _relative to exposed synthetic fixtures_ owner-AI corpus, HTTP experiment and limitations are in master semantic ledger **§37**. Its freeze has 3 publicly documented publisher families, 12 developer-designed cases and two new model-reviewer request sequences with original question/source SHA, where the actual outcomes are to be recorded only after both raw captures finish. Report per-language positive **withholding** and negative-risk rates separately; do not convert exploratory candidates into admitted evidence or infer FAR=0 from an empty/very small number of no-answer emissions. Owner authorization can approve use of this process for _development priorities_, but cannot change already observed score denominators, prove unseen quality or mark a production release gate as passed by decree. A formal alternative AI-only release protocol, if chosen, would require an explicit separate versioned policy change and prospectively frozen disjoint evaluation with statistical uncertainty and source/ACL safeguards.

**Completed internal evidence (25 October 2026).** The AI-only development workflow authorized above has now been executed: three original official publisher files and exact source slices verified against upstream immutable Git blobs; 12 EN/ES questions and self-authored labels frozen; two isolated authenticated HTTP arms completed; 24/24 paired Qwen/Gemma reviewer responses frozen, independently scored by SHA and byte-exact replayed without additional inference. Results are in ledger §37–§38. The two readers agreed on 8/12 decisions but only 5/12 had agreement **and** both source-bound usable outputs. The reviewers exposed false affirmative answers, truncated ES relations and valid literal quotes attached to unrelated answers, so agreement is not treated as an entailment certificate. The four omitted positive writer responses remain diagnosed at the retrieval/admission boundary, not reclassified as absent evidence. This achieves the owner-requested **AI-only internal diagnostic evaluation**, not E6 external-release adjudication, answer-level FAR or production authorization.

**Follow-up admission trace completed (25 October 2026).** A second entirely fresh AI-selected three-publisher original-source cohort (TypeScript, Moby, Redis) was preregistered and tested with 24 real authenticated HTTP searches, two paired exact+lexical / E5 arms and 24 read-only `s2AdmissionShadowSink` records. Source-byte integrity, scope, per-question SHA, raw HTTP receipt and candidate reason classification were checked and replayed without model inference. This closes the operator's **internal source-bound admission-shadow instrumentation and measurement** task (master ledger §39). It does _not_ close the semantic LAYERED reader evaluation: the measured application admission mode was explicitly `DETERMINISTIC`, all reader decisions and quote-span statuses were unpopulated, and all three positive Spanish queries were withheld by text-oriented support. No admission logic or E5 production flag was changed. A future new-cohort experiment must enable and trace the documented `LAYERED` semantic reader separately, then check final answers against original source and permission boundaries before any release decision.
