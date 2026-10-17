# S2 reviewer calibration rubric v1.1 (post hoc, 2026-10-17)

**Scope:** one source-bound question/passage candidate at a time; assess the evidence *within that passage*, not other retrieved chunks. Verify entity, requested attribute or relation, time, unit, version, proposition, and negation. **This operational clarification was created after observing disagreements in the first reviewer pair.** It is a calibration protocol, **not** the original preregistered independent blind holdout.

## Decision order

1. `ANSWERS`: the passage independently determines the requested answer with matching entity, attribute, value, period, unit and constraints. A clear negative may answer a yes/no question, but the mere absence of a requested numerical measurement is not an answer to that value.
2. `CONTRADICTS`: the passage explicitly falsifies a factual *premise asserted by the query*. A source saying that a report **omits** the requested measurement does not contradict a numeric value the question never asserted. Do not count contradiction as an answer-bearing span for an open numeric question.
3. `RELATED_NOT_ANSWERING`: the passage directly addresses the *requested property/relation*, including explicitly saying the relevant report lacks that measurement, but cannot determine the asked answer. The same device, document or domain alone is insufficient for this label.
4. `INSUFFICIENT`: the passage addresses another property, entity, time, or relationship, or otherwise lacks material evidence concerning the specific requested slot. Fictional, non-corpus example: a temperature reading from sensor Z-99 does not establish its requested pressure, even though both refer to Z-99.

**Acceptance for open-question evidence:** only independently supported `ANSWERS` is provisionally answer-bearing; `CONTRADICTS` is a separate query-premise challenge requiring contextual evaluation, not automatically an admitted value; the other two labels are **NOT ADMIT**.

## Human source quotes

For `ANSWERS` or `CONTRADICTS`, cite an exact source substring containing enough subject/attribute/value or explicit falsifying clause, preserving original UTF-16 boundaries. Neither quote paraphrasing nor replacement by a hash is valid. Negative labels have no quote offsets. A reviewer note should explain ambiguous premise, timeline, entity or attribute cases.

## Two-set reconciliation (without label leakage)

- **Set A:** 155 pairwise disagreements of the original 288 candidate judgments across 38 questions: 145 class-label disagreements (`INSUFFICIENT` vs `RELATED_NOT_ANSWERING`) and ten quote-offset disagreements. Source-only blank annotations; third evaluator must not see either original verdict or author gold. The existing `validate-s2-adjudications.mjs --resolution` accepts **only** this exact disputed set.
- **Set B:** three source-bound candidate pairs on which both original reviewers chose `CONTRADICTS`, although the source apparently says the *requested measurement is not present*. This is a separate consensus-control evaluation; its three labels are **not** appended to Set A or silently changed in either original CSV. Do not submit Set B as the CLI dispute-resolution file. Require a separate explicit, independently documented control adjudication.
- Exact frozen packet SHA-256: `fd2645f75713389d89492128027bb02a618b2a383774341d6d4fd74deb8d1daa` (frozen source Git blob `a61a24df46c0351115cd09e079ae0d8383033082`). Original 288-pair CSVs remain external and unmodified; do not commit reviewer responses.
- Descriptive initial agreement: 143/288 identical labels, 133/288 identical label+quote offsets, 145 class-label conflicts, ten quote-offset conflicts, descriptive four-label Cohen kappa ~0.2705. The two input CSVs are structurally source-bound and complete; distinct human authors were reported by the user, but independence/blinding and human identity are **not verified by the CLI**.
- Do not treat label agreement as precision, actual runtime reader admission or a passing S2 gate. The original 48-question synthetic author-built corpus was exposed during rubric calibration; any post-calibration performance claim requires **a separately frozen, independently authored/annotated holdout not used to tune labels or runtime**.

## Release conditions

Preserve original reviewer submissions and their byte digests. Validate third submission structurally and publish a *separate* provenance receipt for the three consensus controls; record adjudicator procedure and disagreements explicitly. Then measure actual API/reader admissions, evidence sufficiency, no-answer false admission, final grounded answers, paired manual baseline, tokenizer and p95 on fixed model/policy under source ACL. S2 remains open; E5 remains shadow; S3-S5 remain blocked. This document changes no runtime thresholds, corpus, gold, model, or retrieval default.
