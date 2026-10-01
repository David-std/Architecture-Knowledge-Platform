# Retrieval generality policy

AKP retrieval must work across vaults and domains. A failing question is an evaluation case, never an instruction to add its nouns, document identity, or paraphrase to generic runtime code.

## Product rule

- Do not add corpus-specific terms, named concepts, document IDs, paths, aliases, or question text to the generic query planner, retriever, reranker, support verifier, or ContextPacket admission logic.
- Do not tune a global threshold or add a branch because one question passes or fails. An observed case belongs in a generic fixture or a private local evaluation pack, with both answerable and adversarial non-answerable counterparts.
- Keep source-specific language in an explicit, versioned profile or source mapping when it is a property of that source. Such configuration must not grant support, truth, or authorization by itself.
- Ranking and similarity determine which authorized candidates to inspect; they do not establish answer support. `SUPPORTED` requires a specific admitted unit and inspectable passage that answers the query. A thematic match remains exploratory.
- Preserve authorization, scope, lifecycle, temporal truth, trust, exact-identifier, and quantitative/date boundaries independently of any semantic verifier.
- Do not enable an optional verifier, model, or reranker by default until a held-out, cross-domain evaluation demonstrates acceptable false acceptance, false abstention, citation precision, latency, degraded behavior, and rollback.

## Required evidence for a retrieval-quality change

1. Record the stage of failure: candidate generation, authorized shortlist, support decision, citation selection, or ContextPacket projection. Report the expected and actual `documentId + unitId`, not just a top-level status.
2. Evaluate answerable, unanswerable, contradictory, and same-vocabulary/wrong-relation examples. Include unseen topics, documents, paraphrases, and language pairs. Keep a held-out set separate by document and question family from development examples.
3. Compare retrieval recall before the support gate, correct-unit acceptance, precision of all admitted units, false acceptance, false abstention, cited-span correctness, and latency. State the corpus and configuration; a small synthetic set is a regression, not a general precision claim.
4. Keep private vault contents and local identifiers out of committed fixtures, diagnostics, and reports. Use structurally equivalent generic examples publicly and run the private set locally.
5. If a semantic verifier is proposed, run it in `SHADOW` first. Calibrate its decision and candidate coverage on the held-out set; preserve deterministic security and exact-fact gates. Promotion requires an explicit configuration decision and a reversible deployment plan.

## Static gate and existing code

`pnpm retrieval:generality:validate` is part of CI. It rejects new string, template, or regular-expression literals anywhere in the monitored query-heuristic modules: `packages/retrieval/src/support-verifier.ts`, `packages/retrieval/src/query-planner.ts`, and `packages/retrieval/src/assertion-recall.ts`, including newly added declarations. The baseline records **existing** hand-written vocabulary so this policy can be adopted without disguising a behavior change as documentation. Removing baseline entries is encouraged. Adding entries requires an explicit architecture review and cross-domain evidence; a passing test on the motivating question is insufficient.

The current baseline also includes a document type (`decision-rule`) and a generic uppercase-acronym pattern. These describe repository structure and explicit entity identity, not a vault concept or an answer synonym. Neither permits a thematic catalog entry to become evidence for a yes/no relationship by itself.

### Structural table grammar

The baseline may include format-level literals required to interpret a versioned structural unit when the admission rule is independent of corpus nouns. GFM table support uses the `TABLE` unit type plus generic condition/situation and decision header roles only to bind cells from the same parsed row. Conditional support is restricted to eligible claim/rule/decision-rule documents, with one unambiguous condition column and one decision column. A decision-count heading or an interrogative decision cell is not a directive. A table role never establishes support by itself: the queried answer anchors must occur in the decision cell, the condition and decision must come from the same exact row, and a title cannot supply missing relation anchors.

This structural exception is covered by answerable and adversarial table cases across unrelated domains and languages. Metric tables remain non-supporting. It does not authorize adding query paraphrases, domain nouns, or answer synonyms to the baseline; those remain subject to query-conditioned verification and held-out calibration.

### Assertion punctuation grammar

Question-only evidence cannot establish an assertion, including quoted or formatted questions and Unicode question marks. Sentence segmentation follows `Intl.Segmenter` and [Unicode sentence boundaries](https://www.unicode.org/reports/tr29/#Sentence_Boundaries). The baseline permits sentence/line boundary and punctuation literals for this structural rule; it does not add domain vocabulary. Actual declarative answers following a question remain eligible.

A capability phrase containing “without” is not, by itself, proof that the queried activity lacks a requirement. Viewing a report or simulating an activity may be possible without a component even when the actual activity requires it. Likewise, shared token prefixes do not establish entity identity. Such inferences require the queried predicate and component to be demonstrated; legitimate indirect positives remain in the measured semantic frontier until that proof exists.
The gate is deliberately narrow: a static scan cannot prove that an algorithm generalizes or that an innocuous literal is safe. A new helper module or changes outside the monitored modules can still evade it; retrieval heuristics therefore belong in the monitored modules rather than route handlers. Reviewers must apply the product rule to all retrieval-related code. The existing baseline is technical debt to replace with measured, query-conditioned evidence verification, not an approved dictionary to extend.
