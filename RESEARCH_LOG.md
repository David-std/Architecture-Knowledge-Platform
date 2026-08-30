# Research and implementation log

## Inputs reviewed

- Unified Goal V2 and the architecture-platform blueprint.
- The external vault router, ontology, schemas, source gate, claims, profiles,
  context packs, evals and private-source indexes, always as read-only input.
- Required reference repositories at pinned commits, recorded in the current
  `COMPETITIVE_AUDIT.md`; the superseded adoption matrix is archived under
  `docs/archive/iterations/`.
- Official/runtime contracts represented by OpenAPI, AsyncAPI, MCP, PostgreSQL,
  MinIO, Git, Node/pnpm and Python tooling.

## Findings adopted and verified in this closure

- Scope snapshots plus membership re-intersection prevent bearer-to-browser
  scope expansion.
- Pathless workspace metadata requires whole-space authorization.
- Idempotency must distinguish concrete resource and credential scope and must
  abandon uncertain expired claims rather than replay them.
- A replay fingerprint must also reflect current vault enabled/visibility state
  and inherited grants; otherwise a stored success can outlive authorization.
- A backup manifest must name its artifacts explicitly and compare an exact
  migration inventory; directory self-hashing is not recovery proof.
- Clean, versioned environments exposed a cross-shell test-exclusion error and
  four high-severity transitive dependency findings; both were corrected and
  rerun.
- The final dependency audit exposed three moderate and one low advisory in
  transitive Hono 4.12.32. Pinning 4.13.5 removed all known findings; unused
  `sanitize-html` runtime/type packages plus unused Fastify multipart/plugin
  packages were removed after a local import scan.
- Vault identity must be explicit and permission-intersected; a space alone is
  not a safe multi-vault retrieval boundary.
- Normal publication must commit durable events and leave indexing to an
  idempotent consumer; full rebuild belongs to explicit repair.
- Canonical extraction must preserve structured locators, content hashes,
  warnings and adapter configuration instead of flattening every medium.
- Structural containers support rehydration but must not be embedded as one
  dossier-wide vector.
- Benchmark selection remains unverified for production. The deterministic
  offline harness validates scoring/coverage only and leaves the default null.
- A full product lifecycle must exercise both mutable review state and the
  durable event boundary: revision request, publication, outbox delivery,
  indexing, retrieval, persisted context packet, rejection and rollback were
  therefore verified as one isolated integration scenario.
- Backfilled outbox consumers should be tested with a scoped disposable
  consumer. Draining unrelated historical deliveries makes the assertion
  timing-dependent and obscures the behavior under test.
- Outbox attempt identity must include the outcome when both `CLAIMED` and a
  terminal record are retained. Fresh-schema inspection belongs in the runtime
  gate because an incorrect dropped-constraint name can fail silently.
- Browser-facing server components must treat missing or expired sessions as
  navigation, not generic data-fetch failure. Protected routes now redirect to
  login and preserve Next.js redirect control flow.
- OpenTelemetry package presence is not observability proof. The local bridge
  was inspected at runtime and classified as proxy/no-op until a concrete
  provider, exporter, workflow spans and operational metrics are configured.
- Synthetic scale evidence is useful for regression bounds but cannot choose a
  production retrieval strategy. The 100,000-item run remains explicitly
  single-process, cumulative and cache-sensitive.
- Test discovery must exclude compiled workspace output. Building internal
  dependencies before source tests preserves clean-checkout bootstrap without
  double-counting `dist` copies.

## Uncertainty retained

- Nineteen synthetic generic cases/slices plus 13 curated cases across three
  fixture vaults cannot establish production retrieval quality.
- Docling, Marker and Chunkr were unavailable and remain unbenchmarked optional
  candidates; no comparative ranking was invented.
- Reference capabilities not reproduced locally remain conservative
  `UNKNOWN_NOT_REPRODUCED` assessments.
- Private/paid materials are not redistributed; their evidence status comes
  from the vault source/evidence metadata.
- Multinode fencing, RLS, Object Lock, encrypted backup and enterprise identity
  require human/operational work beyond this local baseline.
- No managed external Git repository was supplied for a destructive restore
  drill, so the database and object-store recovery proof does not claim an
  end-to-end managed-Git bundle restore.
