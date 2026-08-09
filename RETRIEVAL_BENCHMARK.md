# Retrieval benchmark

## Scope and truthful interpretation

The checked-in gold set has four curator-defined critical cases. It is a
regression smoke, not a corpus-wide, multilingual or semantic-retrieval
benchmark. The current benchmark endpoint executes **11 named configurations**;
its `selectedDefault` field is a recommendation produced by the ranking policy,
not an automatic global runtime configuration change.

The latest executed benchmark is
`c8ec9350-9c11-4945-aac7-d201579cf0ab`. It evaluated four cases per
configuration, had zero critical failures for its eligible winner and recommended
`lexical+graph`. A separate default evaluation,
`8477b608-a9d6-41d1-b216-91488c0da6e1`, passed 4/4.

Eligibility requires zero critical failures and zero unsupported answers. Ties
are deterministic. Vector remains benchmark-only because this small dataset
cannot justify activating semantic retrieval by default.

## Runtime distinction

`packages/retrieval/src/query-planner.ts` remains intent-specific: conceptual
queries currently use exact plus lexical retrieval; source/code/workflow intents
add channels appropriate to their policy. The benchmark recommendation has not
been silently substituted into every intent. Promoting it would require a wider
held-out evaluation, an ADR and an explicit policy/configuration change.

## Primary limitation

No claim of mature semantic retrieval is justified. Expand the gold set with
negative/no-answer, stale, contradictory, code, long-source and held-out cases
before changing a global default or comparing quality competitively.
