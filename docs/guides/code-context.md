# Code Context Guide

## What this feature is

Code Context projects an approved repository snapshot into the `CODE` graph domain and exposes symbols, dependencies and change-impact context alongside knowledge, runtime and temporal context.

The maintained real adapter is Graphify. AKP materializes a bounded repository snapshot, executes the external provider in an isolated working directory, normalizes its output into AKP contracts and records provider/configuration hashes and source commit identity.

## When to use it

Use Code Context before broad refactors, dependency changes, API modifications, or work that must connect repository symbols with rules, decisions, services or tests.

Do not use it as a substitute for the repository itself. Source files and commit identity remain the code authority; the code graph is a rebuildable projection.

## Configuration

Project paths must be beneath `AKP_PROJECT_ROOTS`. A code snapshot includes repository identity and commit SHA.

Graphify configuration selects the executable, optional arguments, working root and incremental mode. Code graph options bound file size, provider runtime, process output, graph size and exclusions.

Provider execution uses a scrubbed environment and a temporary workspace. Incremental mode keeps validated provider state only for the matching repository/provider/configuration identity.

## Normal workflow

1. Resolve an authorized repository snapshot at a specific commit.
2. Materialize only permitted files and apply exclusions/size limits.
3. Execute Graphify or another configured `CodeGraphExtractionPort` provider.
4. Normalize symbols and relations into a versioned CODE graph artifact.
5. Build and activate the projection revision.
6. Query symbol lookup, callers/callees, dependency paths or impact.
7. Bridge returned code context to governed rules/decisions through typed graph relations and citations.

Incremental updates are attempted only when a compatible previous provider state exists. If incremental refresh fails, AKP performs a full rebuild and keeps the prior provider state until the replacement validates.

## Security and governance boundaries

Repository access is restricted to approved project roots and immutable commit snapshots where required. Provider processes receive a bounded workspace instead of arbitrary workstation filesystem access.

Code graph queries inherit graph authorization. A symbol/path outside the caller's allowed scope cannot be used as an intermediate authorization bypass.

Generated code-context summaries remain derived context. They cannot publish a rule or decision without the normal review workflow.

## Degraded and offline behavior

If the code provider is unavailable, stale or incompatible, AKP may omit the code channel and return explicit warnings while other retrieval channels continue.

A stale source commit must not be represented as current. The projection revision carries the source commit/configuration identity so callers can detect mismatch.

## Failure and recovery

Provider failure during an incremental update falls back to a full rebuild when safe. A failed replacement does not activate over the previous good CODE revision.

CODE graph state is rebuildable after restore. Use the original repository commit and provider configuration, then inspect code-graph staleness through doctor before relying on impact analysis.

## Example

Before changing a retry helper, an agent can resolve the symbol, inspect callers/callees, obtain a bounded blast-radius path, and include linked tests plus an approved retry policy from the EPISTEMIC graph. The output should cite both code revision and governed knowledge evidence.

## Limitations

Static graph extraction cannot prove every runtime dependency. Dynamic/runtime relations require separate observed evidence.

Graphify is an adapter, not AKP's canonical storage format. Provider-specific output is normalized and may omit unsupported language constructs rather than exposing raw provider semantics as product truth.
