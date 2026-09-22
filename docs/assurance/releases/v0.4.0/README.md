# v0.4.0 deterministic Code Graph evidence

This matrix records the deterministic Code Graph capability evidence retained for v0.4.0. It records executable AKP behavior rather than treating a contract enum or an upstream feature as product support. External specialist references were checked on 2026-09-18; AKP remains pinned to its reviewed provider/configuration even when upstream capabilities move.

Allowed statuses are exactly `IMPLEMENTED`, `ADAPTER_PROVIDED`, `BENCHMARKED_NOT_ADOPTED`, `DEFERRED_WITH_REASON`, and `BLOCKED_EXTERNAL`.

## Capability matrix

| Capability family                | AKP status           | Executable evidence and boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-language parsing           | ADAPTER_PROVIDED     | `GraphifyCodeGraphAdapter` delegates parsing to the pinned real Graphify provider. The permanent CI job runs `graphifyy==0.9.63` against a real Git fixture. AKP does not claim to own every language parser.                                                                                                                                                                                                                                                                                              |
| Cross-file resolution            | ADAPTER_PROVIDED     | Graphify performs cross-file static resolution; AKP normalizes only provider output that resolves back to the verified immutable snapshot.                                                                                                                                                                                                                                                                                                                                                                 |
| Calls/imports/inheritance        | IMPLEMENTED          | Normalization maps provider relations to `CALLS`, `IMPORTS`, `INHERITS`, `IMPLEMENTS`, and `REFERENCES`; API/MCP queries traverse the corresponding lower-case graph relations.                                                                                                                                                                                                                                                                                                                            |
| Extracted vs inferred state      | IMPLEMENTED          | Provider derivation is preserved. `INFERRED` and `AMBIGUOUS` edges remain candidates and are excluded from the authoritative static projection instead of being upgraded to extracted/static evidence.                                                                                                                                                                                                                                                                                                     |
| Ambiguity representation         | IMPLEMENTED          | Ambiguous provider edges remain explicit candidates; symbol queries fail closed with `CODE_SYMBOL_AMBIGUOUS` when a selector is not unique.                                                                                                                                                                                                                                                                                                                                                                |
| Incremental refresh              | IMPLEMENTED          | A warm `GraphifyCodeGraphAdapter` preserves only its last validated provider state for the same repository/provider/configuration, materializes the next immutable SHA in a fresh workspace, restores that derived state and executes Graphify `update`. CI proves this with pinned `graphifyy==0.9.63` across two real commits. Provider restart or missing state safely falls back to full extraction; failed update never replaces the prior state before a validated full fallback/replacement exists. |
| Stale detection                  | IMPLEMENTED          | CODE projections are revision/freshness aware. Project query fencing requires the active CODE `sourceRevision` to match the project's current immutable commit for `FRESH_ONLY`; stale fallback is explicit under `ALLOW_STALE`.                                                                                                                                                                                                                                                                           |
| Path/explain                     | IMPLEMENTED          | `/v1/code/path`, `/v1/code/explain` and their MCP equivalents execute bounded graph traversal with provenance.                                                                                                                                                                                                                                                                                                                                                                                             |
| Callers/callees                  | IMPLEMENTED          | Direct incoming/outgoing `calls` queries are exposed through API and MCP and tested against PostgreSQL graph projections.                                                                                                                                                                                                                                                                                                                                                                                  |
| Blast radius                     | IMPLEMENTED          | `code.impact` performs bounded multi-relation traversal and can include tests, catalog bridges, reviewed rule/decision links, and runtime observations.                                                                                                                                                                                                                                                                                                                                                    |
| PR impact                        | IMPLEMENTED          | `code.changeImpact` accepts an immutable commit plus changed paths and returns changed nodes, impacts, and unmatched paths. Native GitHub PR ingestion is not implied; callers supply the reviewed change set.                                                                                                                                                                                                                                                                                             |
| Test linkage                     | IMPLEMENTED          | Static `TESTS` relations and revision-matched Node V8 coverage are distinct evidence paths; runtime coverage cannot upgrade a different SHA.                                                                                                                                                                                                                                                                                                                                                               |
| Rationale refs                   | IMPLEMENTED          | Human-reviewed canonical `code_knowledge_links` are append-only, emit `CodeKnowledgeLinkApproved`, and project `HUMAN_ASSERTED` EPISTEMIC→CODE `rationale_ref`/`applies_to` edges. Model-only mapping is not accepted as authoritative.                                                                                                                                                                                                                                                                    |
| Community/clustering integration | DEFERRED_WITH_REASON | Graphify and GitNexus expose clustering/community views, but the pinned Code Graph provider is executed with `--no-cluster`. AKP reserves COMMUNITY product work for the later retrieval/community phase instead of advertising it early.                                                                                                                                                                                                                                                                  |
| Multi-repo/federated query       | IMPLEMENTED          | Code queries accept authorized multi-vault/federated scopes and repository-scoped identities. AKP does not invent cross-repository relations where no explicit/static/reviewed bridge exists.                                                                                                                                                                                                                                                                                                              |
| File/line provenance             | IMPLEMENTED          | Normalized code nodes/edges retain immutable commit, relative file path and available line/symbol locators; ContextPacket citations use logical repository + SHA + path rather than local host paths.                                                                                                                                                                                                                                                                                                      |
| Diagnostics                      | IMPLEMENTED          | Provider non-zero exit, timeout/output bounds, path escape, unsupported/symlink file modes, oversized graph/files, stale revision and ambiguity fail closed with explicit codes; warnings preserve exclusions and normalization issues.                                                                                                                                                                                                                                                                    |

## Specialist comparison

### Graphify

Upstream: https://github.com/Graphify-Labs/graphify

Graphify provides local tree-sitter AST extraction for code, cross-file `calls`/`imports`/`inherits` resolution, explicit `EXTRACTED` versus `INFERRED` edges, query/path/explain, communities and incremental `update`. AKP adopts Graphify through a bounded provider adapter, pins a reviewed version in CI, disables clustering for the release production proof, sanitizes the provider environment, materializes only the verified Git snapshot, and normalizes results into the federated graph. Warm consecutive refreshes use Graphify's incremental code update from the last validated provider state; clustering remains deliberately unadopted.

### GitNexus

Upstream: https://github.com/digitalapplied/gitnexus

GitNexus provides tree-sitter indexing, cross-file resolution, communities/processes, MCP context, blast-radius `impact`, git-diff `detect_changes`, staleness information and multi-repository selection. AKP implements its own authorization/revision-aware query boundary, impact/change-impact and federated vault scopes, but does not adopt GitNexus process/community clustering in this release.

### GraphCoder

Paper: https://arxiv.org/abs/2406.07003  
Reference implementation: https://github.com/oceaneLIU/GraphCoder

GraphCoder is a repository-level code-completion retrieval framework built around a code context graph and coarse-to-fine retrieval. It is useful evidence for graph-structured repository context, but AKP's release objective is governed deterministic code evidence and impact/context queries rather than completion-model retrieval. Its retrieval pipeline is therefore BENCHMARKED_NOT_ADOPTED as a specialist design, not a missing AKP parser.

### RepoGraph

Paper: https://arxiv.org/abs/2410.14684  
Reference implementation: https://github.com/ozyyshr/RepoGraph

RepoGraph is a repository-structure plug-in for AI software-engineering systems and exposes repository search/navigation used in SWE-bench/CrossCodeEval experiments. AKP implements bounded path/symbol/impact navigation directly over its revisioned multi-graph; it does not adopt RepoGraph's benchmark-specific agent action interface.

## Adversarial closure

The maintained tests cover malicious/out-of-root paths, provider crash, ambiguity, same-name isolation, stale-current mismatch, failed-build fallback, generated/vendor exclusion, inferred-not-extracted enforcement, old-runtime-SHA rejection and unauthorized transitive bridges. The final provider adversarials additionally prove that Git mode `120000` symlinks fail with `CODE_SNAPSHOT_SYMLINK_REJECTED` and that a provider exceeding `maxProcessOutputBytes` is killed with `GRAPHIFY_PROCESS_OUTPUT_LIMIT`.

For malicious comments/docstrings, the Code Graph path deliberately has no LLM prompt surface: the real-provider CI runs Graphify in local `--code-only` mode and the adapter supplies a sanitized environment without LLM API keys. The existing adapter test explicitly sets an `OPENAI_API_KEY` sentinel and succeeds only when that key does not reach the provider. Comments can be parsed as source text, but they cannot gain model authority through this adapter.

## Release-wide limitations

These limitations apply to the v0.4 evidence set as a whole and are intentionally not converted into positive product claims:

- External comparator families without a same-task, same-fixture executable report remain reference-only or `DEFERRED_WITH_REASON`; AKP does not reuse README or paper scores as current parity evidence.
- Registered retrieval quality is measured on the small public AKP product-documentation corpus. It is not evidence of domain-general or private-customer retrieval superiority.
- Monetary provider cost is not measured for the local registered retrieval provider and must remain unmeasured rather than being interpreted as zero.
- The generic connector contract, local/Git source path and authenticated webhook/inbox are productized; first-party adapters for every vendor system of record are not.
- Graphify language/extraction coverage follows the pinned reviewed adapter/provider version. Clustering remains disabled in the Code Graph provider path because AKP owns community indexing separately.
- Federation proof uses two isolated API/database nodes on one CI host. It proves protocol, scope and failure semantics, not WAN performance or multi-region high availability.
- PPR is an on-demand bounded retrieval operation rather than a durable background job; cooperative cancellation is proven at the request boundary.
- Late-interaction retrieval is not retained in the v0.4 production matrix and therefore remains explicitly outside the ablation path.
- Agent A/B and five-arm arena evidence records losses, invalid outputs and unsupported claims from the pinned local model; those results do not establish global agent-quality superiority.

## Deliberate non-claims

- Graphify/GitNexus community detection is not an active AKP product capability.
- Incremental provider state is a derived warm-process optimization, not canonical truth; after worker restart AKP may rebuild the same immutable SHA from source.
- `code.changeImpact` is change-set impact, not automatic GitHub PR ingestion.
- Multi-vault federation does not manufacture cross-repository edges.
- Static evidence never implies runtime coverage, and reviewed rationale never converts an inferred code relation into an extracted one.
