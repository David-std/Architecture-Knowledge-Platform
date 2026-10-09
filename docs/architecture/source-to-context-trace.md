# Source-to-context pipeline: S1 source authority trace

- **Reviewed:** 2026-10-08, draft PR #38. Initial trace at `6b54e2b3`; source-projection binding updated in `d7d85b2c`, pending same-head CI verification.
- **Scope:** S1.1 source/persistence/reader trace. This is a static code and SQL-path audit, **not** a passing compiler ON/OFF database integration, OCR quality claim or S1 exit certification.
- **Authorities:** immutable raw bytes in object storage and `sources`; sanitized `DocumentArtifact` in `source_artifacts`; reviewed Markdown in managed Git/`knowledge_documents`; evidence excerpts, plans, index units and model output are derived or provisional.

## 1. Actual write path

1. `apps/api/src/routes/ingest.ts` checks `source:write` and authorized scope, rejects disallowed source paths, and inserts an ingest job with its source URI in operational state. Job responses redact local paths and object-store keys.
2. `apps/worker/src/worker.ts`, `RECEIVED`: `objects.putImmutable` content-addresses the bytes and optionally verifies the caller-provided SHA. The SQL-fenced `RECEIVED → HASHED` transition inserts/reuses `sources` by `(vault_id, sha256)` or `(space_id, sha256)`; `stage_outputs.raw` carries bucket/key/hash, and `sourceId` records the SQL source identity.
3. `HASHED → STORED` checks that the raw object still exists. `NORMALIZING` downloads it to a temporary file, independently hashes the bytes, calls `/v1/extract-upload`, and requires a matching source ID/hash/media type, extractor/version and a valid `DocumentArtifact` through `parseCanonicalExtractionResponse` in `apps/worker/src/document-artifact.ts`. The worker sanitizes paths and provider metadata.
4. In the SQL-fenced `NORMALIZING → ANALYZING` transition, one `source_artifacts` row stores `document_artifact`, extractor/version, source hash, configuration hash and structured content hash (upsert identity `source_id + extractor + extractor_version + configuration_hash`). A linked `evidence` row stores machine-extracted evidence, locator and excerpt. Provider start/success/failure events are durable.
5. `ANALYZING` checks for an active knowledge document with the same source SHA, then invokes `buildCompilationStage` if new material is needed. An existing source SHA can lead to `NO_MATERIAL`, but the structured source was persisted in the previous stage.
6. If the compiler route is disabled or no eligible model exists, `sourceSummaryFallback` calls `renderDocumentArtifactDraft` with the **persisted, identity-verified complete source Markdown** in a `source-summary` machine draft, with `source_id`, `source_artifact_id`, SHA and an explicit human-review warning.
7. If a compiler route is eligible, `buildCompilationStage` invokes `prepareGroundedKnowledgeCompilation` and `executePreparedGroundedKnowledgeCompilation`. The returned `CompilationPlan.proposedChanges` is **generative proposed knowledge**, not guaranteed to be a complete faithful source Markdown projection.
8. `PLANNED` writes the plan's files to a managed Git draft branch; `DRAFTED` validates; `VALIDATING` creates a pending `reviews` record. Publication remains governed by the separate review path, not by LLM output.

## 2. Read and index paths

- `apps/api/src/routes/operator.ts`, `GET /v1/operator/sources/:id`, remains a sanitized operational preview of structured `DocumentArtifact`, metadata, descendants and reviews. It exposes Markdown hash/version metadata but **not** the complete Markdown body, avoiding a misleading changed-body/unchanged-hash response.
- `apps/api/src/routes/knowledge.ts`, `GET /v1/sources/:id/artifacts/:artifactId/markdown`, is the authorized, pathless-vault-only **exact-byte** Markdown read. It returns the stored UTF-8 content, SHA, source/artifact hashes and a machine-extracted noncanonical trust marker; rejects missing/legacy projections and integrity failure. It never sanitizes or paraphrases the content bytes after hashing and includes `Cache-Control: no-store`.
- `apps/api/src/routes/knowledge.ts`, `GET /v1/sources/:id`, is a separate metadata/evidence response; it does not return a full Markdown projection. No full Markdown read API is demonstrated by either of these endpoints.
- `apps/web/app/sources/[id]/page.tsx` reads structured artifact blocks/headings/tables/figures for a source preview; it is not proof of independently persisted Markdown.
- `packages/indexing/src/index.ts`, `rebuildChangedUnits`, reads approved `knowledge_documents.body_cache` from managed Git indexing and feeds `parseKnowledgeUnits`; a source artifact may be linked via validated `frontmatter.source_artifact_id`. This path does **not** independently index an arbitrary unapproved `source_artifacts.document_artifact` as approved knowledge. That distinction is desirable for authority, but source retrieval needs an explicitly authorized, noncanonical channel if required by the user journey.
- `renderDocumentArtifactMarkdown` in `apps/worker/src/document-artifact.ts` renders complete structured material; `renderDocumentArtifactPreview` bounds a **presentation copy**. `worker.ts` calls `selectEvidenceFragment` with a 4,000-character preview, so the resulting `evidence.excerpt` must **not** be mistaken for full extracted text.

## 3. Concrete discrepancy at the S1.2 boundary

**Proven from code:** raw bytes and the structured sanitized `DocumentArtifact` are persisted independently of the compiler. The reviewed Git draft path differs across the two modes.

**Implemented in draft PR #38, pending final CI:** an explicit, hashed, independently persisted **faithful Markdown projection** tied to the same source-artifact identity and extractor configuration. On a new compilation path, the worker reloads it from the authorized `source_artifacts` row and rejects source/structured-artifact hash or renderer mismatches before model routing; fallback consumes those persisted bytes, while the generative plan remains separate proposed knowledge. A full real-database compiler ON/OFF parity integration and direct permission-scoped source-unit indexing remain unproven; the exact-byte authorized download now has a first-party E2E assertion in the product-lifecycle integration suite.

The remaining gap is independent user-facing source retrieval and full compiler-mode E2E parity; it is **not** proof that the original bytes or structured artifact are lost when the LLM is enabled. It also does not justify treating extracted source text as an approved rule.

## 4. Single-owner correction to prove before cutover

- **Implemented (CI pending):** `source_artifacts` owns one derived, complete source Markdown projection created before optional compiler selection; a SHA and renderer version are preserved. A candidate cannot become approved knowledge without managed Git review.
- **Implemented (CI pending):** `apps/worker/src/source-projection-backfill.ts` and `scripts/backfill-source-markdown.ts` provide a narrowly targeted, dry-run-first reconstruction of historical missing Markdown from the **existing structured artifact only**. They verify exact space/vault/source/artifact/SHA, ACTIVE source/enabled vault, extractor/configuration/structured JSON hashes, existing sanitization, full nonempty Markdown and idempotency under an artifact row lock. Hash/identity mismatch is an error requiring manual inspection/re-extraction. They do not access original MinIO blobs, recompute OCR, change reviews, modify Git or index knowledge. The existing 091 migration remains unchanged.
- **Partially implemented (CI pending):** the exact-byte authorized source artifact endpoint preserves original SHA/renderer identity and denies unscoped reads without exposing raw source URI, object-store keys or provider credentials; extension to explicitly revision-pinned source spans and source-unit indexing remains open.
- Avoid an old/new parallel renderer: migrate the existing fallback draft and any API consumer to the one renderer/contract before removing superseded paths. A UI preview remains a bounded view and may not define searchable content.
- Keep Source → Markdown and Source → LLM proposal as separate flows; a failed model/disabled vector subsystem must not invalidate the already persisted source.

## 5. Required behavioral proof (still open)

- In a disposable real PostgreSQL/object-store integration, ingest the **same** fixture with compiler OFF and an eligible local/mock compiler ON. Assert equal raw SHA, artifact/content SHA, full Markdown hash and ordered page/table/row/character locators before review; assert distinct proposal modes and no automatic publication.
- Compare complete Markdown and indexed source units against fixtures: plain Markdown, DOCX tables, two-page digital PDF, rasterized OCR scan, embedded code, headerless/ragged tables, long material past the UI preview bound and successive revisions.
- Fail closed for corrupt files, required OCR without capability, deliberately partial provider output, source/locator hash mismatch and revoked/cross-vault reads. Model mocks validate wiring, not semantic quality.
- Prove that new approved managed-Git revisions rebuild only the intended authorized derived generation and that stale/archived content is not admitted.
- Record SQL migrations, exact consumers, one-time backfill/reindex, negative tests, CI SHA and recovery before marking S1.2–S1.10 or S1 complete.

## Existing regression evidence and limits

`apps/worker/test/document-artifact.test.ts` exercises sanitized identity, full structured rendering, tables, captions, locators, preview behavior and rendering into knowledge units. `apps/api/test/document-intelligence.integration.test.ts` and `apps/api/test/product-lifecycle.integration.test.ts` exercise parts of durable artifact/ingest behavior. The [ingestion/chunking audit](ingestion-chunking-audit.md) documents known fixes and the absence of a full ON/OFF source projection parity gate. **These tests are not an end-to-end proof of source Markdown persistence in both compiler modes.**

Related contracts: [core redesign execution specification](core-redesign-execution-spec.md), [roadmap](core-redesign-roadmap.md) and [repository standards](repository-standards.md).

### S1.10 persisted-source ON/OFF parity regression (partial)

The PostgreSQL integration test at `apps/worker/test/source-markdown-parity.integration.test.ts` seeds **one** immutable-source identity and structured DocumentArtifact with a **legacy NULL Markdown projection**, then checks guarded dry-run, exact-target refusal, apply and idempotent reapply before comparing both compiler modes. It preserves page/table/paragraph locators and a nonpublished evidence row. It reloads that same persisted representation and calls the **real** `buildCompilationStage` with model routing disabled and with a locally scoped mocked compiler. It checks both source Markdown hashes, renderer versions, the original locator set, full text beyond the preview, distinct provisional plans and the absence of automatically published knowledge. PostgreSQL enforces the projection digest constraint. The test is skipped without `DATABASE_URL` and is expected to run in the provisioned CI database.

**Boundary:** This is a persisted-stage ON/OFF test, not two uploads of the same source through MinIO and the extractor. The actual source-ingest/worker/OCR and publication tests remain separately covered, while a combined two-mode raw-file-to-index parity path, source-unit permissions/revision handling and **large-scale audited migration/re-extraction for invalid historical artifacts** are still S1 exit gaps. An in-process mocked provider verifies model-routing wiring, not generated knowledge quality.

### Historical Markdown projection recovery (bounded operator workflow)

The operation is **manual**, requires \`DATABASE_URL\` and explicit UUIDs for the space, vault, source and artifact, plus the source SHA-256. Read \`sources\` and \`source_artifacts\` with an authorized operator's SQL inspection first. Run without \`--apply\` to validate and print a metadata-only dry run; inspect \`DRY_RUN\`, source SHA and derived Markdown hash before repeating with \`--apply\`. This command handles **one artifact**, not a scan or bulk update:

\`\`\`sh
pnpm backfill:source-markdown --space-id <space-uuid> --vault-id <vault-uuid> --source-id <source-uuid> --artifact-id <artifact-uuid> --source-sha256 <64-hex-source-sha>
pnpm backfill:source-markdown --space-id <space-uuid> --vault-id <vault-uuid> --source-id <source-uuid> --artifact-id <artifact-uuid> --source-sha256 <64-hex-source-sha> --apply
\`\`\`

The CLI deliberately logs only identifiers, computed digest, version, length and status. Existing correct projections produce \`ALREADY_MATERIALIZED\` without rewrite. Corrupt, redaction-unsafe or stale representations fail closed: use controlled original-source re-extraction after investigation, not an automatic parser fallback. Migration 091 allows legacy NULL records; no schema edit or mutable knowledge publication is necessary. A verified source projection is still machine-extracted evidence, not an approved Git document.
