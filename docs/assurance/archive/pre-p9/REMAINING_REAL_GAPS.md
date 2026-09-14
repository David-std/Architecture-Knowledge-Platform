# Remaining real gaps

These are explicit product or assurance limits, not hidden placeholders.

## Resolved in v0.3 P0

- Node 20 is no longer the active compatibility target. Clean remote CI passes
  under Node 24.20.0 with application engines constrained to `>=24 <25`.
- Python local, CI and extractor-image dependency resolution now share the
  checked-in `apps/extractor/uv.lock`; dev dependencies and heavyweight
  provider extras are separated.
- The product lifecycle passes unchanged with causal outbox eligibility and a
  machine-readable drain that waits for durable retry/lease timestamps and
  fails on quarantine or deadline.
- CI now persists diagnostics and test reports and always removes disposable
  containers and volumes.

## Product and operational limits

1. `DEFERRED` — OIDC/SAML, MFA, device assurance, centralized secret
   management, HA and PostgreSQL RLS are outside the local baseline.
2. `DEFERRED` — There is no Obsidian companion plugin or browser Web Clipper.
   The external vault is a human-authored, read-only source.
3. `CONTRACT_ONLY` — Docling, Marker and Chunkr adapters are present but were
   unavailable locally. OCR/vision/audio/video processing is not configured.
4. `PARTIALLY_IMPLEMENTED` — Raw evidence export is bounded and verified but is
   disabled by default and was exercised with a mock object store, not enabled
   as a deployment feature.
5. `PARTIALLY_IMPLEMENTED` — Repository/code evidence is deterministic but
   lacks language-server depth, runtime coverage and mutation-backed proof.
6. `PARTIALLY_IMPLEMENTED` — Publication spans Git and PostgreSQL through
   compensation plus reconciliation; it is not a distributed atomic commit.
7. `DEFERRED` — Object-lock/WORM backups, encrypted remote recovery, quotas and
   cross-node coordination are not implemented.
8. `PARTIALLY_IMPLEMENTED` — OpenTelemetry APIs are wired, but the local runtime
   resolves a proxy/no-op tracer and meter. Durable audit, outbox and job state
   make incidents diagnosable; exported workflow spans, channel metrics,
   stuck-job gauges and alert policies still require a real provider/backend.

## Evidence limits

1. Retrieval evidence has two levels: 19 Level-A logic-only synthetic cases
   and 13 Level-B curated cases across three isolated fixture vaults. They
   validate the harness and fixture isolation, not production retrieval quality.
2. `productionDefault.selected` remains `null`; vector search remains disabled
   until a real held-out benchmark justifies an ADR-backed choice.
3. Optional document-intelligence candidates were skipped honestly. The nine
   deterministic fixtures do not prove OCR or advanced scientific extraction.
4. The external source vault retains unresolved wikilinks and has no Git
   history. Warnings are preserved rather than repaired without evidence.
5. Security coverage is meaningful but not exhaustive; no internet-facing
   or formally verified multi-tenant claim is made.
6. The private recovery ZIP contains database/object-store/managed-Git data and
   must not be committed or shared publicly.
7. The scale benchmark proves deterministic single-process mechanics up to
   100,000 synthetic documents/units/embeddings and 99,999 relations. It is
   cumulative and cache-sensitive; it does not establish concurrent API/worker
   throughput, production latency SLOs or semantic retrieval quality.
8. A managed-Git bundle was not restored because no disposable external
   managed repository was authorized. PostgreSQL and object-store backup and
   restore were verified independently, including empty-state recovery,
   migration idempotency and checksum failure.
9. Agent usability is `PARTIALLY_PROVEN`: a real MCP session and bounded
   ContextPacket returned the expected rule/claim with citations and controls,
   but a longer lexical query missed, the serialized packet exceeded the raw
   fixture size and no controlled LLM comparison measured completion quality.

## Release closure

The annotated tag `v0.2.1-platform-validation` records the current validated
local checkpoint; `v0.2.0-platform-megagoal` remains the previous baseline. The
limits above remain intentionally open and must not be read as release blockers
for the local reusable baseline unless a deployment requires them.
