# Research and implementation log

## Inputs reviewed

- Unified Goal V2 and the architecture-platform blueprint.
- The external vault router, ontology, schemas, source gate, claims, profiles,
  context packs, evals and private-source indexes, always as read-only input.
- Required reference repositories at pinned commits, recorded in
  `RESEARCH_ADOPTION_MATRIX.md`.
- Official/runtime contracts represented by OpenAPI, AsyncAPI, MCP, PostgreSQL,
  MinIO, Git, Node/pnpm and Python tooling.

## Findings adopted and verified in this closure

- Scope snapshots plus membership re-intersection prevent bearer-to-browser
  scope expansion.
- Pathless workspace metadata requires whole-space authorization.
- Idempotency must distinguish concrete resource and credential scope and must
  abandon uncertain expired claims rather than replay them.
- A backup manifest must name its artifacts explicitly and compare an exact
  migration inventory; directory self-hashing is not recovery proof.
- Clean, versioned environments exposed a cross-shell test-exclusion error and
  four high-severity transitive dependency findings; both were corrected and
  rerun.
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

## Uncertainty retained

- Nineteen synthetic generic cases/slices cannot establish production
  retrieval quality.
- Docling, Marker and Chunkr were unavailable and remain unbenchmarked optional
  candidates; no comparative ranking was invented.
- Reference capabilities not reproduced locally remain conservative
  `UNKNOWN_NOT_REPRODUCED` assessments.
- Private/paid materials are not redistributed; their evidence status comes
  from the vault source/evidence metadata.
- Multinode fencing, RLS, Object Lock, encrypted backup and enterprise identity
  require human/operational work beyond this local baseline.
