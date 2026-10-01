# Ingestion, chunking and indexing audit (2026-10-01)

How documents become retrievable units, checked against code, aggregate counts from a private vault (549 documents at the current lexical revision), a public Markdown fixture and a synthetic two-page PDF. Vault contents stay local.

## Pipeline

- **Vault import** (`packages/vault-importer/src/index.ts`): without a front-matter title, the title is the filename slug; transfer packs are archived; units come from `parseKnowledgeUnits`.
- **Chunking** (`packages/retrieval/src/chunking.ts`): one container-only `DOCUMENT` unit with the full body, one container-only `SECTION` unit per heading, and embedding-eligible atomic units for paragraphs, lists, tables, code, equations and images. Atomic heading paths omit the document title. `semanticType` re-types units with regular expressions over the heading path and the first 240 characters, where most alternatives match as substrings.
- **Embeddings** (`packages/indexing/src/embedding-index.ts`): `passage: ` plus the unit body, cut at 512 tokens, with no title or heading.
- **Lexical vectors** (migrations 023 and 055): heading path (A), unit key and type (B), body (C) with the `simple` configuration, so no stemming, stop words or accent folding. The document title appears only in document-level vectors.
- **Hit unit and excerpt** (`apps/api/src/routes/search.ts`): the strict lexical query ANDs every token; the best unit is chosen from all units, containers included, by an unnormalized `ts_rank_cd`; the excerpt is a 1,200-character focus window, or a hard slice of the document body for hits without a unit.
- **PDFs**: the default extractor emits one text block per page; Docling is optional. The worker renders the extracted artifact into a draft Markdown note that is then chunked.

## Defects

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

## OCR and document extraction probe

- **Per-page text extractor**: no headings, running headers and page footers kept, tables flattened, hyphenation kept.
- **Docling**: headings detected but not nested; a table without detected column headers yields `headers=[]` and the renderer drops it; all page-2 content was missing from the artifact; the running header was removed correctly.
- **Worker rendering, for every extractor**: an `akp-locator` HTML comment precedes each block and the chunker does not strip comments, so 8 of 17 eligible units in the Markdown fixture were comment-only and every machine-extracted paragraph was typed `EVIDENCE`. The fixture table lost its data row. Only a 6,000-character preview becomes units.

## Fixes, in priority order

1. Choose an atomic unit, never a container, as the hit unit, with length-normalized ranking; keep the container only as a fallback.
2. Index units with title and heading context: a new embedding input strategy and regenerated lexical columns.
3. Clean units at chunk time: strip HTML comments into the locator, make link-only and label-only units ineligible for embedding, merge tiny blocks, type units from whole words in the body.
4. Fix draft rendering: keep locators out of the text, render tables without detected headers using the first row, nest headings, remove the preview cap or build units from artifact blocks.
5. Normalize extracted text: de-hyphenation, repeated header and footer removal, OCR for empty pages, and the missing-page defect in the Docling mapping.
6. Fold accents identically in the index and the query.
7. Use the first heading as the title when front matter has none, keeping the slug as an alias.
8. Split long units and add table-row units.
9. Skip redundant sections, and purge old-revision units and stale generations.
