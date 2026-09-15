# Retrieval benchmark output

Retrieval benchmark JSON is generated output and is intentionally not versioned. Keep durable execution evidence in CI artifacts; keep reusable evaluation cases and benchmark logic under `evals/` and `scripts/`.

Run the deterministic offline harness from the repository root with:

```powershell
pnpm benchmark:retrieval:offline -- --repo-root .
```

Run the curated harness with:

```powershell
pnpm benchmark:retrieval:curated
```

The offline harness reads only `evals/generic/**/*.jsonl`. It validates fixture loading, metric arithmetic, slice coverage, no-answer behavior, configuration-matrix logic and vector-disabled guardrails. Its evidence level is synthetic and must not be used as a production retrieval-quality claim.

The curated and runtime harnesses retain their own declared evidence boundaries. A benchmark result does not activate a production retrieval default by itself; runtime selection remains an explicit configuration decision supported by reproducible evidence.

Generated reports are written below `reports/retrieval/` by default and are ignored by Git. Use an explicit output path when a workflow needs to upload them as artifacts.
