# Product status

This page describes the maintained product behavior of the current repository tree. It is intentionally not a construction log and does not duplicate CI transcripts.

## Supported local workflow

The repository contains a local-first multi-vault runtime with durable ingest/event processing, scoped retrieval, context packaging and governed knowledge-change workflows.

Maintained retrieval paths include exact and weighted lexical search, optional semantic vector retrieval and typed bounded graph traversal. Query planning is capability-aware and ContextPackets expose provenance, structural context, token-budget information, gaps, conflicts and no-answer state.

The compiler can create grounded change proposals against existing approved knowledge. Proposed changes remain subject to runtime validation, authorization and review; language-model output is not a publication authority.

Document extraction is provided by the local extractor service. Native-structure and OCR paths are optional capabilities and their provider/runtime requirements are verified separately from the default text path.

## Defaults and optional capabilities

- Vector retrieval is disabled unless a compatible embedding provider is configured and a consistent generation is active.
- Language-model-backed compilation is disabled unless an explicit provider configuration is supplied.
- Deterministic embedding behavior is for tests/mechanics and is rejected as a production semantic provider.
- Vault paths, ingest roots, project roots and credentials are operator supplied.
- Generic evaluation data must not encode a private vault identity; fixture packs may carry explicit fixture scope.

## Operational limits

The supported target is a reproducible local deployment. The repository does not claim high availability, Kubernetes operation, hostile-internet exposure, unlimited corpus scale or universal model-quality superiority.

External model/provider availability can affect optional semantic, OCR or compilation paths. Failures must remain visible and must not silently broaden authorization or bypass review.

## Verification policy

A product claim is release-ready only when the relevant implementation, negative/failure coverage and integration path pass from a clean checkout. The maintained GitHub Actions workflow is the source of truth for repository-wide reproducibility.

The standard gate includes dependency installation/audit, formatting, static checks, architecture boundaries, contracts, documentation, repository hygiene, build, secret scanning and integration/runtime checks. Optional provider evidence is kept explicit so absence of a provider cannot be mistaken for successful execution.

Release-specific assurance summaries live under `docs/assurance/releases/`. Detailed construction reports and superseded validation transcripts remain recoverable from Git history rather than being kept active in the product tree.
