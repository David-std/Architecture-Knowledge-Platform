# Temporal Truth Guide

## What this feature is

Temporal Truth is AKP's append-only bi-temporal substrate for facts, support, source episodes and withdrawals. It distinguishes when something was valid from when AKP recorded it, while preserving immutable truth revisions.

`truth_revision_heads` points to the latest immutable truth revision for each vault. Facts reference support sets, source episodes and the revision that introduced them. Supersessions, withdrawals and evidence invalidations are separate immutable records.

## When to use it

Use temporal queries for current-truth questions, historical/as-of questions, changed-since analysis, withdrawal behavior and cases where multiple support paths or disputed facts matter.

Use ordinary document retrieval when temporal semantics are not relevant. Do not infer an as-of answer from a current snapshot alone.

## Configuration

Temporal facts are scoped by space, vault and authorization path. Each fact includes subject, predicate, object, `valid_from`, optional `valid_to`, `recorded_at`, support set and truth revision.

Support sets retain fact/evidence/source references and may be `SUPPORTED` or `DISPUTED`, including alternative support groups.

Derived-state dependencies identify vector, graph-summary, community-report, cached-synthesis, context-fragment and task-artifact items whose support can become stale when truth changes.

## Normal workflow

1. Record a source episode for an immutable source artifact.
2. Create or reuse a support set referencing the evidence/source revisions.
3. Append facts under a new truth revision.
4. Supersede facts explicitly when their valid-time interpretation changes.
5. Record withdrawal or evidence invalidation instead of editing historical rows.
6. Query current, as-of or changed-since state against a captured truth revision.
7. Validate derived candidates against support state before final ranking/context assembly.

## Truth states returned by queries

`supportState` continues to report whether the fact's evidence is `SUPPORTED`, `DISPUTED` or `UNSUPPORTED`. The additive `truthState` field combines that support evaluation with valid-time and supersession semantics at the query's captured truth revision:

- `SUPPORTED_CURRENT` — valid now/as-of and supported.
- `DISPUTED_CURRENT` — valid now/as-of but explicitly disputed.
- `UNSUPPORTED_CURRENT` — temporally current but no longer supported; visible only in history mode because current queries suppress it.
- `FUTURE_EFFECTIVE` — already recorded but not yet valid at the requested valid time.
- `HISTORICAL` — outside its valid-time interval at the requested time.
- `SUPERSEDED` — replaced by a fact whose supersession is visible and effective at the query revision/time.

These are query-relative states. They do not mutate the append-only lifecycle stored on the fact.

## Security and governance boundaries

Temporal rows are append-only by database trigger. Application code cannot rewrite history to manufacture current consistency.

Authorization-path filtering applies before temporal facts participate in retrieval. Support from another vault/path cannot leak through a derived candidate.

Truth support is evidence/provenance state; a model cannot create an attested fact by assertion alone.

## Degraded and offline behavior

Strict truth consistency rejects or suppresses candidates whose captured truth/support revision is no longer valid. Best-effort mode may return bounded degradation warnings but cannot silently relabel stale derived context as current truth.

Historical rows remain available even when current support changes. Derived vector/community/cache material is rejected by truth validation before rank/fusion acceptance when its support is stale. Vector rows may then be cleaned asynchronously, but the worker revalidates against the current truth head before deleting them and retains append-only dependency/projection history for audit and recovery.

## Failure and recovery

Truth revisions and support records are durable backup state. Derived truth projections are rebuildable and are validated against the restored revision head before use.

If truth changes during a strict query, the query should detect mixed revision state and restart/reject instead of combining before/after support.

Use doctor to inspect truth/index health after recovery and rebuild affected projections when support invalidation events request it.

## Example

An as-of query can ask which deployment rule was valid on a given date. AKP resolves the fact interval and support set at the requested time, returns the corresponding truth revision, and keeps a later superseding rule out of that historical answer.

## Limitations

AKP preserves temporal truth mechanics but cannot infer missing historical evidence. A gap remains a gap.

Physical retention of historical dependency/projection metadata and rebuildable graph/community state is intentional for recovery and reproducibility. Some invalid vector rows may be physically cleaned after current-head revalidation; correctness never depends on that cleanup because revision/support validation happens at query time.
