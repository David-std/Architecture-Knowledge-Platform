# Code Context Guide

## Code graph revision lifecycle

A code-graph revision is requested first, enters `BUILDING` before provider-derived graph state is persisted, reaches `READY` only after its nodes and relationships validate, and is then activated by an atomic pointer swap. The previously active revision becomes `RETIRED` only in that activation transaction. A failed replacement becomes `FAILED`; it does not replace the prior active revision. If the repository advances before the replacement is ready, the prior active revision may remain queryable only as stale/degraded context according to the caller's freshness policy.

Transition timestamps are retained on the projection revision (`requestedAt`, `buildingAt`, `readyAt`, `activatedAt`, `retiredAt`) so operators can distinguish extraction latency, readiness and activation rather than inferring them from one mutable status.

## Graphify provider and validation boundary

The live code-graph adapter is audited against Graphify `graphifyy==0.9.63`, Apache-2.0, upstream commit `eaaec1abd99d3a7fb30301ccb49f4cc72ae34011`. The accepted full invocation is `extract . --code-only --no-viz --no-cluster`; incremental refresh uses `update . --no-cluster`. The code-only integration is treated as local and does not require network access. A different provider version fails the adapter gate until it is deliberately re-audited.

Provider execution receives a minimal environment, an immutable Git snapshot, a controlled temporary working directory, a wall timeout and bounded stdout/stderr. Snapshot and output validation also enforce file-count, snapshot-byte, graph-byte, node-count and edge-count ceilings. Provider paths containing traversal, absolute escapes or control characters are rejected. Unknown explicit derivation kinds, unsupported provider schema versions, dangling edges and source line ranges outside the immutable file are rejected instead of being coerced into trusted code edges.

## Incremental equivalence, candidates and evidence tiers

Incremental Graphify refresh is accepted only when the normalized supported semantics for the head commit equal a clean full rebuild of the same head commit. The live provider CI records incremental and full elapsed time, node count and edge count while treating semantic equivalence, not speed, as the correctness gate.

Provider edges marked `INFERRED` or `AMBIGUOUS` are not activated as authoritative graph relationships. AKP keeps a bounded candidate-target registry in project code-graph status so ambiguity remains inspectable without choosing a target. Cross-commit rename and move reconciliation likewise remains `CANDIDATE` or `AMBIGUOUS` unless deterministic provider evidence establishes stronger continuity.

Evidence promotion is monotonic and proof-specific: deterministic static linkage may promote to `STATICALLY_LINKED`; a matching revision-scoped runtime observation may promote that to `RUNTIME_COVERED`; only an explicit stronger dynamic-proof policy may promote to `DYNAMICALLY_PROVEN`. Repeated model agreement never promotes evidence.

Comments and docstrings are untrusted source text. A provider may expose their text as code context, but fields resembling instructions, permissions, tools, trust, profiles or canonical-knowledge authority are discarded by the canonical adapter and cannot mutate governance state.

## Partitioned impact and commit delta

Impact reporting keeps evidence classes separate instead of collapsing them into one score. The CODE query boundary partitions direct static dependents, transitive static dependents, tests, runtime observations, Software Catalog impacts, linked rules or decisions, and uncertain or ambiguous candidates. The original revisioned graph impact remains present for backwards compatibility and auditability.

For managed projects, commit-delta impact is derived server-side from an authorized local Git checkout. AKP verifies immutable base and head SHAs, computes a bounded rename-aware Git change set, derives added/removed/changed symbols from those commits, and fences the head SHA to the current active CODE graph revision. Client-supplied changed paths are not used as authority for this delta mode. Local checkout paths are never returned. Cross-commit symbol rename or move mappings remain explicit candidate or ambiguous reconciliation records rather than stable identity assertions.

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
