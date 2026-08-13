# Remaining real gaps

These are explicit product or assurance limits, not hidden placeholders.

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

## Evidence limits

1. The retrieval benchmark is `LOGIC_ONLY_SYNTHETIC`. Its 19 cases/slices and
   ten configurations validate the harness, not production retrieval quality.
2. `productionDefault.selected` remains `null`; vector search remains disabled
   until a real held-out benchmark justifies an ADR-backed choice.
3. Optional document-intelligence candidates were skipped honestly. The nine
   deterministic fixtures do not prove OCR or advanced scientific extraction.
4. Final commands ran under Node 25.2.0 and Python 3.14.0; CI targets Node 20
   and Python 3.12 and must remain the canonical compatibility gate.
5. Python dependencies use lower bounds without a hashed lock file.
6. The external source vault retains unresolved wikilinks and has no Git
   history. Warnings are preserved rather than repaired without evidence.
7. Security coverage is meaningful but not exhaustive; no internet-facing
   or formally verified multi-tenant claim is made.
8. The private recovery ZIP contains database/object-store/managed-Git data and
   must not be committed or shared publicly.

## Release closure still pending

- Merge the validated worktree into the permanent platform repository.
- Perform the final staged private-file audit.
- Create the release commit and annotated tag `v0.2.0-platform-megagoal`.

Until those steps occur, `PROJECT_STATE.md` intentionally says
`release-candidate-validated`, not `baseline-stable`.
