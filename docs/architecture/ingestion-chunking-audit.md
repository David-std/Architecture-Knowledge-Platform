# Ingestion, chunking and indexing audit (2026-10-01)

Initial audit at `eb5c605a` of how documents became retrievable units, checked against code and aggregate counts from a private vault (549 documents at the current lexical revision), a public Markdown fixture and a synthetic two-page PDF. Vault contents stay local.

## Initial pipeline (before the corrections below)

- **Vault import** (`packages/vault-importer/src/index.ts`): without a front-matter title, the title is the filename slug; transfer packs are archived; units come from `parseKnowledgeUnits`.
- **Chunking** (`packages/retrieval/src/chunking.ts`): one container-only `DOCUMENT` unit with the full body, one container-only `SECTION` unit per heading, and embedding-eligible atomic units for paragraphs, lists, tables, code, equations and images. Atomic heading paths omit the document title. `semanticType` re-types units with regular expressions over the heading path and the first 240 characters, where most alternatives match as substrings.
- **Embeddings** (`packages/indexing/src/embedding-index.ts`): `passage: ` plus the unit body, cut at 512 tokens, with no title or heading.
- **Lexical vectors** (migrations 023 and 055): heading path (A), unit key and type (B), body (C) with the `simple` configuration, so no stemming, stop words or accent folding. The document title appears only in document-level vectors.
- **Hit unit and excerpt** (`apps/api/src/routes/search.ts`): the strict lexical query ANDs every token; the best unit is chosen from all units, containers included, by an unnormalized `ts_rank_cd`; the excerpt is a 1,200-character focus window, or a hard slice of the document body for hits without a unit.
- **PDFs**: the default extractor emits one text block per page; Docling is optional. The worker renders the extracted artifact into a draft Markdown note that is then chunked.

## Initial measurements (not regenerated projections)

| Defect                                                       | Measurement                                                                                          |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Containers chosen as the hit unit                            | 82.5% of top-10 lexical hits over 113 questions; strict AND hits average 4,211 characters            |
| Strict AND lexical channel                                   | returned a candidate for 10 of 113 questions                                                         |
| Redundant SECTION containers                                 | 68% of curated sections have the same body as their only child                                       |
| Title and heading disagree                                   | 268 of 362 active documents use an English filename slug as title while the first heading is Spanish |
| Link-only, label-only or tiny units still embedding-eligible | 6 curated and 135 unverified link-only units; 196 unverified label-only units                        |
| Atomic units longer than the excerpt window                  | 29 curated, 56 unverified; 24 of 94 curated tables exceed 1,200 characters                           |
| Accented lexemes the accent-folded OR query cannot match     | 8.6% of distinct curated lexemes                                                                     |
| Archived and old-revision units                              | 72% of all units, plus 6,115 units from an old revision                                              |
| Units typed only from their heading                          | 72 curated units                                                                                     |
| PDF evidence excerpts                                        | 20 of 40 keep hyphenated line breaks, 12 are capped at 2,000 characters, 11 are nearly empty         |

## Original OCR and document extraction probe

- **Per-page text extractor**: no headings, running headers and page footers kept, tables flattened, hyphenation kept.
- **Docling**: headings detected but not nested; a table without detected column headers yields `headers=[]` and the renderer drops it; page-2 content was missing in the native-adapter probe (attribution corrected below); the running header was removed correctly.
- **Worker rendering, for every extractor**: an `akp-locator` HTML comment precedes each block and the chunker does not strip comments, so 8 of 17 eligible units in the Markdown fixture were comment-only and every machine-extracted paragraph was typed `EVIDENCE`. The fixture table lost its data row. Only a 6,000-character preview becomes units.

## Corrections verified in the local review

- Lexical best-unit selection now prefers eligible leaf units to containers, preserving a container fallback only when no leaf matches. Strict lexical and vector units take precedence over loose assertion recall for the same document. Length normalization and a broader lexical strategy remain separate work.
- The assertion-recall query preserves accented NFC lexemes to match PostgreSQL's existing `simple` dictionary. The index has not been silently changed to accent-folded search.
- Markdown comments are masked only where the Markdown parser identifies real HTML comments. Literal comments inside code survive. Original line positions and `sourceCommentSpans` preserve traceability; their text does not become evidence or embeddings.
- Semantic-type patterns now match whole words. Link-only prose/list units remain traceable but are ineligible for embeddings; arbitrary short labels are not removed by a length threshold.
- Review drafts now contain complete artifact material; only the UI preview is bounded. Headerless and ragged tables retain every data cell under neutral positional headers. The first data row is not invented as a semantic header.
- Worker render-to-chunk regressions retain a fact beyond 6,000 characters and a headerless table while excluding locator comments from atomic evidence.
- The configured and native Docling adapters now reject incomplete conversions before mapping. A real two-page probe returned `PARTIAL_SUCCESS` with a page-2 backend parse error, which the previous adapters ignored. This demonstrates silent partial-success handling, **not a proven mapper defect**. The mapper cannot reconstruct content the provider never produced. `DOCLING_CONVERSION_INCOMPLETE` exposes no provider-controlled error text.
- The real configured Docling provider still passes native HTML and scanned-PDF OCR tests. Base extractor tests, native mapper regressions and worker/chunker tests also pass. Optional OCR dependencies remain explicitly selected.

[Docling's conversion result](https://docling-project.github.io/docling/reference/document_converter/) distinguishes complete, partial and failed conversion; [pipeline timeouts](https://docling-project.github.io/docling/reference/pipeline_options/) can also return partial output. AKP now enforces its complete-artifact contract at this boundary.

These changes do not reindex the imported vault automatically. The original measurements above describe existing projections. Regeneration must use a new generation or the normal indexing workflow; imported Markdown remains read-only.

## Remaining work, in priority order

1. Measure length-normalized lexical ranking and per-document channel ranks against independent sources; leaf preference alone does not solve topical ranking noise.
2. Index units with title and heading context: a new embedding input strategy and regenerated lexical columns.
3. Evaluate tiny-block merging and label-only eligibility without removing terse assertions or identifiers. Comments, link-only eligibility and whole-word semantic typing are now covered.
4. Evaluate provider heading hierarchy and direct artifact-to-unit construction. Complete review rendering and headerless table retention are now covered.
5. Evaluate layout-aware de-hyphenation, repeated headers/footers and empty-page observability. Do not invent absent pages, erase blank pages, merge unrelated providers or enable OCR without configuration.
6. If accent-insensitive search is retained, version the dictionary and query/index migration together; current assertion recall intentionally preserves accents.
7. Use the first heading as the title when front matter has none, keeping the slug as an alias.
8. Split long units and add table-row units.
9. Skip redundant sections, and purge old-revision units and stale generations.
