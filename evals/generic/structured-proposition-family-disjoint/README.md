# Structured proposition family-disjoint holdout

This pack is a fresh, deterministic evidence-admission holdout for explicit
structured propositions. It does not perform free-text proposition extraction
and it does not enable the semantic reader.

## Split policy

Development and heldout use disjoint abstract families.

Development:

- `DIRECT_EXACT`
- `OBJECT_MISMATCH`
- `OBJECT_OPTIONAL`
- `EMPTY_REQUIRED_FIELD`

Heldout:

- `SUBJECT_BINDING`
- `PREDICATE_BINDING`
- `POLARITY_CONTRADICTION`
- `NORMALIZATION_EQUIVALENCE`

Both splits include English and Spanish. Every candidate quote must occur
exactly once in its passage.

## Freeze rule

The manifest is frozen before the first benchmark execution. Once heldout has
been observed, individual failures may be reported but the same version must
not be tuned. A changed runtime or revised cases require a new versioned
holdout.

## Execution

```powershell
pnpm benchmark:structured-proposition-family-disjoint
```

The benchmark runs the normal `LayeredEvidenceAdmissionPipeline` with the
default structural guard and exact structured matcher. Semantic fallback is
replaced by a fail-closed reader that always returns `INSUFFICIENT`.

The report is written to
`reports/ci/structured-proposition-family-disjoint.json`. Promotion requires
100% strict accuracy in both development and heldout plus disjoint family sets.
A failure exits non-zero.

## Scope

This pack measures structured proposition admission only. It does not measure
candidate retrieval, query-to-proposition extraction, semantic prose reading,
ContextPacket assembly, final answer generation, or private-vault E2E quality.
