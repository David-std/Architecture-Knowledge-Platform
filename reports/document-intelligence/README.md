# Document intelligence benchmark output

Run from the repository root:

```powershell
python scripts/document_intelligence_benchmark.py `
  --fixtures test/fixtures/document-intelligence `
  --report reports/document-intelligence/benchmark.json `
  --repeats 3
```

The JSON report records fixture hashes, adapter availability, structural
metrics, processing timings and exact skip/failure reasons. Optional Docling,
Marker and Chunkr candidates are `SKIPPED` when their dependency or service is
not available. The harness reports `selection.status: NOT_SELECTED` until a
human reviews benchmark evidence and explicitly configures a selection.
