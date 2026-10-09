# Source-to-context pipeline: S1 source authority trace

- **Reviewed:** 2026-10-08, draft PR #38, source code at `6b54e2b38d6e117c4a7751d3fdde193ce52d5309` (the subsequent S0 commits only update documentation).
- **Scope:** S1.1 source/persistence/reader trace. This is a static code and SQL-path audit, **not** a passing compiler ON/OFF database integration, OCR quality claim or S1 exit certification.
- **Authorities:** immutable raw bytes in object storage and `sources`; sanitized `DocumentArtifact` in `source_artifacts`; reviewed Markdown in managed Git/`knowledge_documents`; evidence excerpts, plans, index units and model output are derived or provisional.

## 1. Actual write path

1. `apps/api/src/routes/ingest.ts` checks `source:write` and authorized scope, rejects disallowed source paths, and inserts an ingest job with its source URI in operational state. Job responses redact local paths and object-store keys.
2. `apps/worker/src/worker.ts`, `RECEIVED`: `objects.putImmutable` content-addresses the bytes and optionally verifies the caller-provided SHA. The SQL-fenced `RECEIVED → HASHED` transition inserts/reuses `sources` by `(vault_id, sha256)` or `(space_id, sha256)`; `stage_outputs.raw` carries bucket/key/hash, and `sourceId` records the SQL source identity.
3. `HASHED → STORED` checks that the raw object still exists. `NORMALIZING` downloads it to a temporary file, independently hashes the bytes, calls `/v1/extract-upload`, and requires a matching source ID/hash/media type, extractor/version and a valid `DocumentArtifact` through `parseCanonicalExtractionResponse` in `apps/worker/src/document-artifact.ts`. The worker sanitizes paths and provider metadata.
4. In the SQL-fenced `NORMALIZING → ANALYZING` transition, one `source_artifacts` row stores `document_artifact`, extractor/version, source hash, configuration hash and structured content hash (upsert identity `source_id + extractor + extractor_version + configuration_hash`). A linked `evidence` row stores machine-extracted evidence, locator and excerpt. Provider start/success/failure events are durable.
5. `ANALYZING` checks for an active knowledge document with the same source SHA, then invokes `buildCompilationStage` if new material is needed. An existing source SHA can lead to `NO_MATERIAL`, but the structured source was persisted in the previous stage.
6. If the compiler route is disabled or no eligible model exists, `sourceSummaryFallback` calls `renderDocumentArtifactDraft` to place **the complete rendered artifact Markdown** in a `source-summary` machine draft, with `source_id`, `source_artifact_id`, SHA and an explicit human-review warning.
7. If a compiler route is eligible, `buildCompilationStage` invokes `prepareGroundedKnowledgeCompilation` and `executePreparedGroundedKnowledgeCompilation`. The returned `CompilationPlan.proposedChanges` is **generative proposed knowledge**, not guaranteed to be a complete faithful source Markdown projection.
8. `PLANNED` writes the plan's files to a managed Git draft branch; `DRAFTED` validates; `VALIDATING` creates a pending `reviews` record. Publication remains governed by the separate review path, not by LLM output.

## 2. Read and index paths

- `apps/api/src/routes/operator.ts`, `GET /v1/operator/sources/:id`, authorizes `source:read` and vault/space membership, then reads the `sources` record, structured `source_artifacts.document_artifact`, `evidence`, descendant knowledge documents and associated reviews. The operator route does **not** select a stored faithful Markdown field because no such field exists yet.
- `apps/api/src/routes/knowledge.ts`, `GET /v1/sources/:id`, is a separate metadata/evidence response; it does not return a full Markdown projection. No full Markdown read API is demonstrated by either of these endpoints.
- `apps/web/app/sources/[id]/page.tsx` reads structured artifact blocks/headings/tables/figures for a source preview; it is not proof of independently persisted Markdown.
- `packages/indexing/src/index.ts`, `rebuildChangedUnits`, reads approved `knowledge_documents.body_cache` from managed Git indexing and feeds `parseKnowledgeUnits`; a source artifact may be linked via validated `frontmatter.source_artifact_id`. This path does **not** independently index an arbitrary unapproved `source_artifacts.document_artifact` as approved knowledge. That distinction is desirable for authority, but source retrieval needs an explicitly authorized, noncanonical channel if required by the user journey.
- `renderDocumentArtifactMarkdown` in `apps/worker/src/document-artifact.ts` renders complete structured material; `renderDocumentArtifactPreview` bounds a **presentation copy**. `worker.ts` calls `selectEvidenceFragment` with a 4,000-character preview, so the resulting `evidence.excerpt` must **not** be mistaken for full extracted text.

## 3. Concrete discrepancy at the S1.2 boundary

**Proven from code:** raw bytes and the structured sanitized `DocumentArtifact` are persisted independently of the compiler. The reviewed Git draft path differs across the two modes.

**Not yet provided as a durable shared contract:** an explicit, hashed, independently persisted **faithful Markdown projection** tied to the same source-artifact identity and extractor configuration. The fallback constructs the source draft; a generative plan may instead contain selected knowledge changes. There is no ON/OFF invariant that independently compares the same source Markdown bytes and source locators before either plan is proposed.

This is a representation/availability gap; it is **not** proof that existing source bytes or the structured artifact are lost when the LLM is enabled. It also does not justify treating extracted source text as an approved rule.

## 4. Single-owner correction to prove before cutover

- Make `source_artifacts` (same original source, same structured artifact identity) the owner of one **derived, complete source Markdown projection**, computed deterministically from its sanitized `DocumentArtifact` **before** any optional compiler decision. Record the source SHA, artifact/configuration identity, renderer version and Markdown content hash. Do not create a second authoritative knowledge writer or silently promote a source extract to managed Git.
- Decide the schema/migration and one-time backfill only after listing existing artifact readers and persisted historical rows; new SQL must be append-only, with source-hash and digest invariants tested. Historical missing projections must be reported, backfilled or explicitly reprocessed rather than fabricated.
- Provide an authorized, revision-aware read surface for this projection; never leak raw source URIs, object-store keys or provider credentials. Keep source retrieval distinct from approved knowledge retrieval and preserve source-located units.
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
