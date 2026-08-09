# Remaining real gaps

These are genuine product or assurance limits after the executable local
baseline. They are not hidden release tasks and should remain visible to future
agents and reviewers.

## Product and operational gaps

1. `DEFERRED` — OIDC, SAML, MFA, device assurance and centralized enterprise
   identity are absent. Browser identity is a local opaque session derived from
   a scoped bearer credential.
2. `DEFERRED` — No Obsidian companion plugin, file watcher or Web Clipper.
   Obsidian is a human editor; the platform API is the integration boundary.
3. `CONTRACT_ONLY` — OCR/vision understanding, audio transcription and video
   transcript/visual evidence return `CAPABILITY_NOT_CONFIGURED`.
4. `PARTIALLY_IMPLEMENTED` — Repository evidence inventories commits, files,
   symbols, dependencies and deterministic test links but lacks language-server
   depth, runtime coverage and mutation-backed proof.
5. `PARTIALLY_IMPLEMENTED` — Review pages support decisions, diffs and
   evidence, but not collaborative autosave, rich inline conflict resolution
   or mature editorial UX.
6. `PARTIALLY_IMPLEMENTED` — Publication uses compensation across Git and
   PostgreSQL; it is not a single distributed transaction. The repository lock
   prevents normal overlap but is not a durable cross-node fencing protocol.
7. `DEFERRED` — HA, PostgreSQL RLS, managed secrets, encrypted/object-locked
   backups, quotas and cross-node session coordination are outside this local
   baseline.

## Evidence limits

1. The gold set has four critical cases. The 11-configuration benchmark is a
   regression smoke, not broad quality evidence.
2. `lexical+graph` is the recommendation for that exact smoke set. Current
   planner behavior remains intent-specific; a wider held-out dataset and ADR
   are required before treating the outcome as a global default.
3. Recovery proved one isolated v3 backup/restore path. It does not inject
   every possible worker, object-store or post-publication failure.
4. MinIO content hashes provide integrity, not WORM retention or encryption.
5. The source vault has 100 unresolved wikilinks and no Git history. They are
   preserved as warnings rather than fabricated repairs.
6. The original vault remains read-only by authorization. Review output goes to
   a separate managed repository.
7. Adversarial input, prompt-injection and cross-space coverage is meaningful
   but small; no exhaustive security claim is made.
8. Python dependencies use lower-bounded ranges without a dedicated hashed lock
   file. The clean Python 3.12 run is reproducible at the command level but not
   a fully pinned supply-chain guarantee.

## Closure record\n\nThe 30 vault validators/evals, deterministic 872-file manifest, private ZIP, staged private-file audit, final functional commit and annotated `v0.1.17-knowledge-baseline` tag were completed at baseline closure. The items above remain deliberately visible because they are real product or assurance limits, not release placeholders.
