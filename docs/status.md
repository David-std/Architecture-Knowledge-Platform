# Current status

This page is the concise product-facing status for the active product-completion
work. Historical construction and release reports are preserved under
[`docs/assurance/`](assurance/); generated machine evidence belongs under
`reports/` or CI artifacts.

## Evidence boundary

Last fully proven pre-P9 checkpoint:

- branch: `work/p5-document-intelligence`
- commit: `712e5b86ae3188dde4560a4d5d5896613c8abadc`
- standard CI: run `34796527625` — success
- managed-Git recovery: run `34796527624` — success

The P9 productization change is intentionally not labelled `PROVEN` until its
own clean-checkout CI/recovery runs complete.

## Phase state

| Phase | State | Evidence summary |
| --- | --- | --- |
| P0 Remote CI + event correctness | `PROVEN` | Causal delivery/drain/runtime lock and clean remote gates executed. |
| P1 Semantic vector retrieval | `PROVEN` | Real semantic provider/generation path and scoped retrieval exercised. |
| P2 Typed multi-hop graph execution | `PROVEN` | Bounded scoped recursive traversal exercised. |
| P3 Planner + lexical + ContextPacket | `PROVEN` | Planner/fusion, compact/full packet and no-answer behavior exercised. |
| P4 Knowledge Compiler | `PROVEN` | Grounded structured compilation remains behind deterministic review/publication boundaries. |
| P5 Document Intelligence | `PROVEN` | Provider-neutral structured extraction plus executed local/Docling paths; optional providers remain explicit. |
| P6 Web operator UX | `PROVEN` | Search/graph/sources/jobs/reviews/evals/health operator surfaces exercised in CI/build evidence. |
| P7 Production observability | `PROVEN` | OTLP trace/metric export to the local collector exercised. |
| P8 Foundation/security/Git/multi-vault | `PROVEN` | Security boundaries, rollback/publication recovery, multi-vault isolation and managed-Git restore executed. |
| P9 Documentation/repository productization | `IMPLEMENTED_NOT_EXECUTED` | This change relocates history, removes personal assumptions and hardens repository hygiene; remote proof pending. |
| P10 Final benchmark/evidence matrix | `DEFERRED` | Broad retrieval/document/agent/load evidence runs after P9 closure. |

## Current product invariants

- Approved Markdown/Git knowledge is canonical and human-readable.
- Derived lexical, vector, graph and context projections are rebuildable.
- Imported vaults are operator-supplied read-only sources; no personal path or
  corpus is a product default.
- Retrieval and compilation preserve authorized space/vault/path scope.
- Provider/model output is untrusted and cannot publish or grant authority.
- Publication and rollback use reviewed Git plus durable lifecycle semantics.
- Optional providers/telemetry can degrade explicitly without corrupting
  canonical knowledge.

## Remaining work

P10 is the next planned phase after P9 receives clean remote evidence. It owns
broad comparative retrieval/document/agent/concurrency evidence and final
release-state reporting; it must not rewrite P0-P9 correctness merely to improve
a benchmark.
