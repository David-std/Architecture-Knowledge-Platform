# Retrieval benchmark artifacts

The canonical machine-readable artifact is
[`offline-benchmark.json`](offline-benchmark.json). Regenerate it from the
repository root with:

```powershell
pnpm benchmark:retrieval:offline -- --repo-root . --generated-at 2026-08-12T00:00:00.000Z
```

Current recorded identity:

- status: `IMPLEMENTED_AND_EXECUTED`
- evidence level: `LOGIC_ONLY_SYNTHETIC`
- quality claim: `NONE`
- generic cases: `19`
- observed slices: `19` (the required generic slice set has `14` entries)
- dataset SHA-256: `e8d9d5959aab4773b46210ad01b9ac6bfffc110dfc7f95d9bfb5cdd79991fdca`
- artifact SHA-256: `AA000CE2339B5F89C0351AFADFC40A4B0994E90552DA22209923D6BCE6A1C9F3`

The runner reads only `evals/generic/**/*.jsonl`; it does not open the private
vault, PostgreSQL, embeddings, graph projections or document content. The
synthetic provider exercises the exact ten-configuration matrix, scoring,
slice coverage, no-answer behavior, negative expectations and vector-disabled
guardrails. It is a logic harness, not a retrieval-quality benchmark.

The report records `productionDefault.selected: null`. Its measured synthetic
selection is diagnostic only and cannot activate a runtime planner default.
Vectors remain disabled in the probe (`vectorInvoked: false`), with runtime
verification still required. Evidence recall and citation precision have zero
labelled coverage until fixtures provide `gold_evidence` and
`gold_citations`. Token and latency fields are deterministic estimates, not
LLM cost or service-latency measurements.
