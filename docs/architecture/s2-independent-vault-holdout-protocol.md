# S2 — independent holdout and paired Obsidian baseline protocol

Status: **OPEN / protocol and candidate-pilot evidence only**. This document
does not close S2, approve E5, or change any production verifier.

## Why this is necessary

The exposed 48-case synthetic calibration yielded two positive questions for
which the real `/v1/search` reader admitted no span; a separate generation-only
arm answered one author-labeled negative question despite lacking a supporting
time-bound fact. The 48 cases and earlier 288 human calibration pairs cannot
be reused to establish independent final-answer accuracy. See GitHub issue
[#125](https://github.com/David-std/Architecture-Knowledge-Platform/issues/125).

The recorded span-gate diagnosis is stage-specific:

- `s2-marine-beacon-p01`: a replay with the complete source assertion passes
  `StructuralEvidenceGuard`; the actual reader-proposed span was rejected as
  `STRUCTURAL_REQUIRED_FACT_MISSING`. This is a span/scope investigation, not
  proof of a lexical retrieval miss.
- `s2-campus-microgrid-p04`: the same Spanish quantity question and complete
  source sentence fail if cardinal is written `two` or `dos` but pass with `2`.
  This establishes a generic word-number representation gap in the structural
  guard, not a reason to hardcode a domain-specific synonym.
- `s2-optical-observatory-n06`: asking for a 2023 firmware version absent from
  the supplied statement is correctly rejected by the guard; the full-pool
  answer emitter still produces a formally cited firmware value. Citation ID
  validity, temporal sufficiency and semantic answer correctness differ.

## Material: private source-disjoint candidate pilot

The user-authorized, read-only Architecture Knowledge System Obsidian vault
has 548 Markdown files (~3.18 MB) across source, architecture, domain,
governance, requirements, profile, and workflow areas. It has no document
identity relationship to the previously exposed 48-question fictional corpus.
Its actual text, local absolute path, case answers, raw provider responses,
source-bearing JSON and handoff artifacts **must remain in ignored local
directories, not GitHub**. The imported vault is never modified.

Pilot selection: deterministically choose 40 Markdown documents with exact
SHA-256 checks across ten top-level operational families, exclude private raw
`Resources` and Obsidian config, and retain a whole-vault file-hash manifest.
Attempt four tasks per document: positive Spanish, positive English, negative
Spanish, negative English. These 160 are a **candidate target**, not a claim
of 160 independently accepted cases. A generation call does not itself
establish true answerability or actual absence from the whole vault.

One early generation method copied full source quotes incorrectly and admitted
only 10/40 documents under strict byte-exact validation. Its 40 questions
remain an explicitly rejected/incomplete pilot, not an evaluable holdout.
A second method preselects exact source paragraphs before prompting, verifies
their SHA-256 again, and asks for narrow questions referring to those bytes.
Even this only establishes source authenticity, **not semantic sufficiency**.
All rejected attempts, generator/model version, prompts, source hashes and
outputs remain in the local pilot record.

### Local pilot outcome (2026-10-19; **NOT final S2 holdout**)

The exploratory source selector was extended deterministically from 40 to
80 to 100 selected documents. Each expansion retained the exact preceding
paths and SHA-256, with zero prefix discrepancies. The whole-vault 548-file
Markdown manifest remained byte-identical when recomputed after the run:

- Whole-vault source-path/file-hash digest:
  `735e0aae4e498b785f569ed692e3d251f726356dd8d7e94b9ceb5f706c5d91b4`.
- Final 100-document source manifest SHA-256:
  `8bc8e2c8c479560fd6b73400f12b9ddb2a2070482ba087ee69eef7ca992952a3`.
- Candidate acceptance by generation-time structural rules: **44 of 100**
  documents; **176** distinct model-authored questions, balanced into
  44 ES-positive, 44 ES-negative, 44 EN-positive and 44 EN-negative candidates.
  The remaining **56** documents did not pass the two-source-paragraph and/or
  question-quality checks; they did not contribute fabricated filler cases.
- A separately executed source-byte audit restored **88/88** positive exact
  quote spans using JS/UTF-16 indices and confirmed 176 unique identities,
  per-document four-way balance and source SHA-256. It flagged **19/176**
  questions mentioning terms such as “documento”, “fuente” or “extracto” for
  independent editorial revision before admissibility.
- Read-only lexical BM25 **proxy** on all 548 Markdown notes: intended-source
  top-1 **17/88**, top-5 **28/88**, top-10 **36/88** positive candidates.
  Top-5 split EN **5/44**, ES **23/44**. This is not the Obsidian search engine,
  is cross-lingually disadvantaged on English questions over Spanish notes,
  and is not an AKP response, admissibility or correctness score. Proposed
  positive source identities are model-authored, not reviewer gold.
- A shuffled, blind human-adjudication CSV and a separate shuffled manual
  Obsidian timing/task CSV have been prepared locally with blank review fields.
  **No human responses or task durations have been fabricated.**

These 176 preliminary questions are exposed to the candidate generator and
were quality-inspected by the assistant. They can be used for method
development and prospective human screening, **not as an untouched independent
postcalibration acceptance set**. A separate family-disjoint, frozen final
holdout remains required.

## Pre-registered final design (not yet executed)

1. Keep exposed synthetic cases and inspected pilot questions in development.
   Use unseen, family-disjoint operational documents for a final frozen set.
   Before model or baseline runs, freeze source SHA-256, question bytes, task
   identity, language, intended scope, document family and the rubric.
2. Target **at least 160 independently screened tasks** with 40 positive and
   40 negative/adversarial questions per language (EN/ES). Prefer expanding
   to >=240 or 320 if family coverage and independent reviewer capacity allow.
   Treat sources/families, not query translations, as independent clusters.
3. Independent reviewers should receive _question, complete authorized source
   scope and evidence-citation interface_ but no model answer, prior label,
   generator suggestion, or expected case polarity. Verify `ANSWERS`,
   `RELATED_NOT_ANSWERING`, `INSUFFICIENT`, `CONTRADICTS` and exact UTF-16
   citation offsets. A separate blinded pass reviews final emitted answers
   for facts, subject, relation, unit, version, time, polarity and citation
   sufficiency. Record disagreements and adjudications without modifying
   original reviews.
4. Freeze `current AKP`, `LAYERED` shadow and the baseline document corpus,
   authorization, model, model digest, retrieved candidate budget, prompt
   templates, run order and hardware conditions. Do not show withheld human
   labels to any reader, generator or ranking step.
5. Observe actual authenticated API search admissions and source-rebound spans;
   collect stage-level rejections, exact model prompt/completion tokens,
   generation and full-request p50/p95, provider failure/degradation and
   final answers. Score both EN/ES separately and with family-cluster
   uncertainty. Preserve disagreements between intent labels and reviewed gold.
6. Compare against Obsidian **on the same frozen source set and tasks**. A
   human follows the same search instructions and records start/end timestamps,
   located note, answer or abstention and actual quoted evidence. Randomize
   task order and arm order. Complete a representative paired manual subset
   with balanced families and EN/ES. The manual baseline is not a timing of
   in-memory text scanning. Manual user context/token copy must be counted
   from actual target model requests; do not estimate tokens with `char/4`.
7. Evaluate paired task success, precision of admitted source spans, false
   admissions on genuinely unanswerable tasks, grounded final-answer accuracy,
   citation retention, token cost and p95 end-to-end latency. Compare against
   the existing S2 provisional criteria (precision >=.80; Wilson95 diagnostic
   lower >=.70; FAR <=.10 and no worse than deterministic baseline; p95 <=25 s;
   degraded calls <=5%). Do not adjust targets after seeing final holdout.
   Compute stratified or cluster-aware intervals in addition to diagnostics.

## Current Obsidian automation limit

Installed local Obsidian is 1.10.6 and no `obsidian` CLI command is available
in PATH. The official newer Obsidian CLI requires the application process.
To avoid upgrades or changing the user's vault state, the pilot uses only a
read-only, custom whole-vault BM25 lexical **proxy** for source discovery.
Its compute latency and top-k counts **are neither native Obsidian app metrics
nor AKP search metrics** and must never enter an S2 acceptance comparison as
such. A separate human task sheet supports a future paired actual Obsidian
session. There are no observed human search times yet.

## Acceptance and handoff

The source-disjoint **candidate** set remains NOT ACCEPTED until new questions
have valid, independently adjudicated source-level gold. No assertion of
answer correctness is allowed from `ANSWER` emission alone. The exact SHA
used for any released CI/gate report must be rechecked after publication.
PR #38 remains OPEN/DRAFT; no merge, E5 remains shadow; S3–S5 remain blocked.
