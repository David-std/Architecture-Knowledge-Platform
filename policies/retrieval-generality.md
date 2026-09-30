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

The gate is deliberately narrow: a static scan cannot prove that an algorithm generalizes or that an innocuous literal is safe. A new helper module or changes outside the monitored modules can still evade it; retrieval heuristics therefore belong in the monitored modules rather than route handlers. Reviewers must apply the product rule to all retrieval-related code. The existing baseline is technical debt to replace with measured, query-conditioned evidence verification, not an approved dictionary to extend.
