# Validation report

## v0.3 P0 validation evidence

- Date: 2026-08-31 (America/Bogota).
- Draft PR:
  `https://github.com/David-std/Architecture-Knowledge-Platform/pull/1`.
- Validated head: `10fbea61afe66342dd519ebdcf01e982364a76a3`.
- Clean-checkout workflow:
  `https://github.com/David-std/Architecture-Knowledge-Platform/actions/runs/33463026103`.
- Remote result: TypeScript PASS and Python PASS under Node 24.20.0 and Python
  3.12.
- Database-focused result: PostgreSQL package 18/18 and worker drain 5/5.
- Unchanged API integration result: 34/34, including the product lifecycle
  final assertion that every selected delivery is `SUCCEEDED`.
- Python result: `uv sync --locked`, Ruff, mypy over 17 source files and pytest
  13/13; the extractor Docker image built and installed with the same lock.
- Workflow result: frozen strict pnpm install, audit, formatting, compose,
  migrations, unit/type gates, contracts, docs, hygiene, build, secret scan,
  API integration, CLI import, runtime verifier, MCP, backup/restore,
  diagnostics upload and disposable-service cleanup all passed.

This evidence closes only P0. The v0.3 PR remains in progress and draft while
P1–P10 are incomplete.

## v0.2.1 validation baseline

- Date: 2026-08-30 (America/Bogota)
- Release tag: `v0.2.1-platform-validation`
- Validated implementation commit:
  `aad98770e2e44fcb31f3c1943d3588a8c6f50fb2`
- Prior baseline tag: `v0.2.0-platform-megagoal`
- Prior baseline commit:
  `e829ea6f65b617bbb6d4b5e5e3f97f984df2dda4`
- Release status: `validation-baseline-stable`
- Validation environment: Windows NT 10.0.26200.0; Node 25.2.0; pnpm
  10.34.5; Python 3.12.13; PostgreSQL 16.14; pgvector 0.8.5; Docker
  client/server 29.6.2.
- The historical v0.2.1 CI target was Node 20 and Python 3.12; active v0.3
  compatibility supersedes it with Node 24.20.0 and locked Python 3.12.

`PASS` means the command or behavior was observed in an isolated validation
workspace and reproduced from the tagged clean checkout where the gate is
listed as a release gate. `LIMITED` means the implementation ran but the
evidence cannot support a broader quality or production claim.

## Executed gates

| Gate                           | Result  | Observed evidence                                                                                   |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------- |
| Frozen dependency graph        | PASS    | 23 workspaces; frozen lock and strict peer dependency installation succeeded                        |
| Dependency audit               | PASS    | 443 dependencies; 0 info/low/moderate/high/critical known vulnerabilities                           |
| Formatting                     | PASS    | `prettier --check .` after repository-wide normalization                                            |
| Contracts                      | PASS    | 51 OpenAPI paths, 3 AsyncAPI channels, 21 MCP tools                                                 |
| Documentation                  | PASS    | 38 active Markdown files; archived iterations excluded                                              |
| Node lint/typecheck/unit       | PASS    | 113 tests passed; 3 database-only cases intentionally skipped by the unit command                   |
| Strict unused-code compiler    | PASS    | 22/22 TypeScript configurations with `noUnusedLocals` and `noUnusedParameters`                      |
| Architecture boundaries        | PASS    | 158 source modules / 390 dependencies; zero dependency violations                                   |
| Production build               | PASS    | all workspaces plus Next 16 production build; 18 dynamic Web routes                                 |
| API integration                | PASS    | 3 files, 34/34 tests: 26 security, 7 review/publication, 1 full product lifecycle                   |
| Real database packages         | PASS    | 3/3: crash/reclaim/fencing/quarantine outbox, incremental index and multivault isolation            |
| Python extractor               | PASS    | Ruff; mypy 17 source files; pytest 13/13 under Python 3.12.13                                       |
| Fresh/runtime schema           | PASS    | 18 migrations, 53 required relations/extensions, 47/47 invariant checks                             |
| API health                     | PASS    | liveness and readiness 200; PostgreSQL, MinIO and extractor ready                                   |
| MCP generic-client smoke       | PASS    | 21/21 tools, scoped vault enumeration and valid search response                                     |
| Agent usability smoke          | LIMITED | scoped session + supported ContextPacket; 300/512 tokens and 2 citations; no LLM quality judgment   |
| CLI smoke                      | PASS    | `akp status` returned platform capabilities and scoped corpus state                                 |
| Web unauthenticated boundary   | PASS    | protected pages return 307 to `/login`; regression replaces prior HTTP 500                          |
| Web authenticated pages        | PASS    | status, search, ingest, jobs, reviews, graph, evals, health, spaces, audit and sources returned 200 |
| Retrieval Level A / B          | LIMITED | 19 × 10 generic cases and 13 × 10 curated cases across three isolated fixture vaults                |
| Document intelligence          | LIMITED | 9 deterministic executions; 27 optional candidate rows honestly skipped                             |
| Synthetic scale                | LIMITED | 1K/10K/50K/100K documents, units and embeddings; exact row counts and complete cleanup              |
| Backup/restore                 | PASS    | populated and empty restores with 18 migrations; idempotent rerun; checksum tampering failed closed |
| Failure injection              | PASS    | PostgreSQL, MinIO, extractor, vector and API/MCP failures degraded or recovered as designed         |
| Repository hygiene/secret scan | PASS    | 340 files classified; tracked-file secret scan and `git diff --check` passed                        |

## Product lifecycle E2E

`apps/api/test/product-lifecycle.integration.test.ts` runs against real local
PostgreSQL, MinIO, Git and the worker:

1. submit a Markdown source and persist immutable bytes;
2. extract a canonical `DocumentArtifact`;
3. create an isolated review draft;
4. request changes and submit draft revision 2;
5. approve and publish the reviewed commit;
6. deliver durable outbox events through a real worker drain;
7. build incremental projections;
8. find the marker through search and persist a revision-bearing
   ContextPacket;
9. reject a second source without publishing it;
10. roll back the first publication, create a tombstone and remove it from
    search.

The test does not read the external vault and cleans mutable PostgreSQL, MinIO,
Git and filesystem fixtures.

## Agent usability smoke

An additional ephemeral workflow exercised the real worker and MCP server:

1. ingest, extract, review, approve, publish and index one rule/claim fixture;
2. call `akp_start_session` with a 512-token budget and vault scope;
3. search for `volatile integration boundary`;
4. call `akp_build_context` and receive `SUPPORTED`, one section, two citations,
   no gaps and 300/512 tokens used;
5. confirm the packet did not expose the token or grant tool, permission,
   authorization, capability or execution keys.

The raw fixture was approximately 238 tokens, the selected section 300 tokens
and the serialized packet approximately 864 tokens because it includes
provenance, revisions, citations and controls. The longer initial lexical query
returned no result, vector remained disabled and no LLM evaluated task quality.
The evidence proves a usable bounded MCP workflow, not semantic filtering,
universal token reduction or better coding-agent output.

## Runtime and recovery evidence

- `verify:runtime` passed 47 invariants: exact migration names/SHA-256,
  pgcrypto/pgvector, validated constraints, default credential revocation,
  VaultRegistry integrity, durable-outbox triggers and attempt-outcome
  uniqueness, vault/space isolation, cross-table lineage, token-scope shape and
  source/unit integrity.
- Bootstrap mode records corpus counts as observations. Populated thresholds
  are an explicit opt-in and were not used to turn historical corpus size into
  a release invariant.
- Backup v3 produced and restored exact PostgreSQL, MinIO and configuration
  artifacts. Populated restore recovered 18 migrations, one fixture document
  and 15 MinIO files; an empty freshly migrated database also restored.
- Backup hashes from the executed drill:
  - PostgreSQL dump:
    `356504040b189f3c28fe8c74a6c44ca4dcbe914756ceb0bc9a56c2d3fb1b2897`
  - MinIO archive:
    `77dc3cc3e35dccec6b22a00fe7b432fb6bf7b5e65d611ba39a1154bfd8b77cfa`
  - configuration metadata:
    `02eca8fb0b0bfe13c1d4c83efb4178981e16432589e2b8e57579ce93b60255e2`
- Managed-Git bundle restore was not executed because this isolated candidate
  did not have an authorized external managed repository. The script validates
  a supplied bundle, but that branch remains `IMPLEMENTED_NOT_EXECUTED` here.

## Failure injection

- extractor stopped: liveness 200, readiness 503 with `extractor:false`;
- MinIO stopped: liveness 200, readiness 503 with
  `rawObjectStore:false`;
- PostgreSQL stopped: liveness 200, readiness 503 with `database:false`;
- database restart retained four vault fixtures, 67 audit events and 48 outbox
  events at the time of the drill;
- a synthetic MinIO object retained size and ETag across restart, then was
  removed;
- vector disabled: lexical + graph remained available with
  `VECTOR_DISABLED` and a degraded response;
- MCP failed closed when the API was unavailable and returned to 21/21 after
  restart.

## Benchmark provenance

| Artifact                         | SHA-256                                                            |
| -------------------------------- | ------------------------------------------------------------------ |
| Level-A retrieval report         | `10F02A8D19150C24D11F5545988204B7A44EBE6E0C92D41CA14F327ECC8CA98D` |
| Level-B curated retrieval report | `9C5491FF25B523859B350235E0F010F01CACFCE6703907073D4B1292EE96D5F5` |
| Document-intelligence report     | `043A0ED69BD80141BC02B7EA735D6D57E62556E7C10B5AD1AB596CC92D4E7AE6` |
| Scale benchmark script           | `FAA55DE6338579CD6F68C1D37034CA9CF5BC3F4CFC8817DB0A7DF56BEACF61C2` |
| Scale benchmark report           | `3694929A5241010911296C79C97E4A4B07623D080DAD8B9A2CB7F17B1D163DB7` |

At 100K synthetic rows, client-observed p95 was 24.293 ms for lexical search,
12.067 ms for the fixed-vector query and 1.126 ms for one-hop graph lookup.
The local ContextPacket builder selected 636 sections from 100K candidates in
81.776 ms p95, with a 302,059,520-byte Node RSS delta. These cumulative,
cache-sensitive measurements are not SLOs and do not measure semantic quality,
PostgreSQL RAM, concurrent tenants or end-to-end worker throughput.

## Security assertions exercised

- cross-vault and cross-space reads/writes fail closed;
- path-scoped actors cannot access pathless whole-space resources;
- token-to-session exchange preserves least privilege and current membership;
- idempotency is partitioned by credential scope and concrete resource URL;
- current vault visibility/enabled state and inherited access participate in
  the authorization fingerprint, preventing replay after access revocation;
- SSRF and traversal payloads are rejected;
- raw source, audit and draft leakage controls are tested;
- malicious HTML active content is stripped;
- prompt-injection text remains untrusted source content and cannot alter
  permissions, tool policy or publication policy;
- Error Book metadata is recursively sanitized;
- invalid review drafts, duplicate paths, competing decisions and changed tips
  fail without escaping the review boundary.

## Observability classification

Lifecycle state, attempts, leases, heartbeat, errors, outbox correlation,
incremental-index rows, audit events and backup manifests provide durable
operational evidence. OpenTelemetry is only an API bridge backed by the no-op
provider in this local runtime: there is no collector/exporter, channel-level
search metrics, workflow-specific spans, stuck-job gauge or alert. Therefore
ingest, extract, compile, review, publish, outbox, index, search, ContextPacket,
MCP and backup are `PARTIALLY_PROVEN` for diagnosability, not fully
instrumented.

## Current final-evidence summary

```yaml
prior_baseline_tag: v0.2.0-platform-megagoal
prior_baseline_commit: e829ea6f65b617bbb6d4b5e5e3f97f984df2dda4
validated_implementation_commit: aad98770e2e44fcb31f3c1943d3588a8c6f50fb2
release_tag: v0.2.1-platform-validation

clean_bootstrap: PROVEN_FROM_TAGGED_CLEAN_CHECKOUT
migrations: 18_PASS
unit_tests: 113_PASS_3_DB_ONLY_SKIPPED
integration_tests: 34_PASS
e2e_tests: 1_PRODUCT_LIFECYCLE_PASS
extractor_tests: 13_PASS
security_tests: 26_PASS
recovery_tests: PASS_WITHOUT_MANAGED_GIT_BUNDLE

genericity: PROVEN_BY_GENERIC_AND_THREE_VAULT_FIXTURES
multi_vault: PROVEN
cross_vault_isolation: PROVEN

event_driven: PROVEN
outbox: PROVEN
idempotency: PROVEN
crash_recovery: PROVEN
reconciliation: PROVEN

document_intelligence:
  deterministic_adapter: EXECUTED
  docling: NOT_EXECUTED
  marker: NOT_EXECUTED
  chunkr_oss_or_cloud: NOT_EXECUTED
  selected_default: null

retrieval:
  exact: PROVEN
  lexical: PROVEN
  vector: SYNTHETIC_PATH_ONLY
  graph: PROVEN
  raw_fallback: PARTIALLY_PROVEN_DISABLED_BY_DEFAULT
  code_fallback: PARTIALLY_PROVEN
  rrf: PROVEN
  rerank: CONTRACT_ONLY
  selected_default: null

context_packet:
  token_budget: PROVEN
  continuations: PROVEN
  no_answer: PROVEN_IN_FIXTURES
  agent_usability: PARTIALLY_PROVEN_DETERMINISTIC_SMOKE

review: PROVEN_END_TO_END
rbac: PROVEN_LOCALLY
audit: PROVEN_LOCALLY

mcp: 21_OF_21_PASS
api: LIVE_PASS
cli: LIVE_PASS
web: LIVE_AUTHENTICATED_AND_UNAUTHENTICATED_PASS

backup_restore: PASS_WITHOUT_MANAGED_GIT_BUNDLE
repository_hygiene: 340_FILES_PASS_NO_TRACKED_SECRETS
```

## Remaining evidence limits

- The v0.2.1 local run used Node 25 while its historical CI target used Node 20. Active compatibility is superseded by the clean v0.3 P0 Node 24 run
  recorded above.
- Optional extraction candidates and semantic embedding providers were not
  installed or simulated.
- Retrieval Level A/B and the scale fixture do not replace a curator-reviewed,
  held-out production corpus.
- The external vault was intentionally not used as release evidence.
- Raw evidence export remains disabled by default.
- Effective distributed tracing and production alerting are absent.
- Agent usability was checked deterministically; no controlled LLM comparison
  established missed-rule rate, incorrect-claim rate or completion quality.
- The annotated tag resolves the documentation closure commit; the source tree
  and tagged clean checkout both finished with no pending tracked or untracked
  files.
