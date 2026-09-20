# Scale benchmark output

Scale benchmark JSON is generated output and is intentionally not versioned. The harness, workload definitions and assertions remain versioned; CI artifacts retain executed evidence.

Run from the repository root with:

```powershell
pnpm benchmark:scale
```

Generated reports are written below `reports/scale/` and are ignored by Git. Results describe only the executed environment and workload; they are not production capacity or service-level guarantees.

## P11 enterprise scale suite

The scale workflow combines two complementary synthetic suites:

- `benchmark:scale` keeps the document/unit/vector corpus matrix at 1K, 10K, 50K and 100K rows.
- `benchmark:scale:enterprise` grows federated epistemic graph nodes/edges, CODE symbols/edges, temporal facts, work-item references, durable agent sessions and federation peers at 100, 1K and 5K enterprise-state targets.

The enterprise-state report includes p50/p95/p99 lookup latency, indexed-write throughput, incremental-update cost, `ANALYZE` maintenance time, process memory, PostgreSQL storage growth and bounded pool pressure. Concurrent request throughput, queue lag and retry rate remain measured by `benchmark:concurrency`; resilience/federation failure semantics remain in the dedicated resilience matrix. These are local/team deployment measurements, not internet-scale SaaS capacity claims.
