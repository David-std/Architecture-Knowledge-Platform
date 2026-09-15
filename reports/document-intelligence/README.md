# Document intelligence benchmark output

Document-intelligence benchmark JSON is generated output and is intentionally not versioned. Reusable fixtures and benchmark code remain in the repository; durable execution evidence belongs in CI artifacts.

Run from the repository root:

```powershell
python scripts/document_intelligence_benchmark.py `
  --fixtures test/fixtures/document-intelligence `
  --report reports/document-intelligence/benchmark.json `
  --repeats 3
```

The report records fixture hashes, adapter availability, structural metrics, processing timings and exact skip/failure reasons. Optional Docling, Marker and Chunkr candidates are `SKIPPED` when their dependency or service is unavailable. The harness reports `selection.status: NOT_SELECTED` until benchmark evidence is reviewed and a provider is explicitly configured.
