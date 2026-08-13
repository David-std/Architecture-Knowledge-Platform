# Document intelligence benchmark

## Current result

Status: `IMPLEMENTED_AND_EXECUTED` for the deterministic local baseline and
`IMPLEMENTED_NOT_EXECUTED` for Docling, Marker and Chunkr. The machine-readable
report contains **9 deterministic `EXECUTED` fixtures** and **27 optional
`SKIPPED` fixtures** (9 per optional adapter).

The reproducible harness at `scripts/document_intelligence_benchmark.py` writes
its machine-readable result to
`reports/document-intelligence/benchmark.json`. The latest checked-in execution
used two repetitions per fixture and produced the counts above. It ran locally
on Python 3.14.0; CI declares Python 3.12, and this checkpoint did not rerun the
benchmark under the CI interpreter.

## Default decision

- Default adapter: `deterministic-baseline` version `0.3.0`.
- Execution profile: local CPU, provider cost zero.
- Supported structured routes in the executed corpus: Markdown, HTML, XLSX and
  PDF fixtures, with provider-neutral `DocumentArtifact` output and locators.
- Optional default: none. Docling was skipped because its dependency was not
  installed; Marker because its dependency/command was not configured; Chunkr
  because neither the OSS service nor a cloud endpoint was configured.

This is a conservative availability decision, not evidence that the baseline
outperforms those candidates. The platform reports optional adapters as
`CAPABILITY_NOT_CONFIGURED` and does not silently route documents to them.

The optional candidates were not installed or configured in the local run:
Docling was skipped with `DEPENDENCY_NOT_INSTALLED:docling`, Marker with
`DEPENDENCY_OR_COMMAND_NOT_CONFIGURED`, and Chunkr with
`OSS_OR_CLOUD_SERVICE_NOT_CONFIGURED`. Their 27 `SKIPPED` rows are not quality
measurements.

## Metrics and limits

The report records fixture/source hashes, adapter and version, availability,
text recall, heading hierarchy, table structure, formula and figure handling,
locator accuracy, chunk-boundary quality, timing, CPU/GPU requirement, provider
cost and failure/skip reason. Synthetic fixtures make structural checks
reproducible; perfect scores on those small fixtures do not establish broad OCR,
scientific-layout or real-world table quality.

Memory peak was not measured by the current harness. Scanned-image OCR, visual
captioning, audio/video transcription and comparative candidate quality remain
unproven. A future default change requires the same corpus, pinned candidate
versions/configuration, resource measurements and executed accuracy comparison.

## Reproduction

```powershell
python scripts/document_intelligence_benchmark.py `
  --report reports/document-intelligence/benchmark.json `
  --repeats 2
```

The final validation report records the exact rerun made for the release
checkpoint; this document must not imply that a skipped candidate was tested.
