# Registered evaluation corpora

This directory contains small, versioned corpora whose source material is part of the product repository and can be redistributed with it. They are used to exercise the production retrieval path with real source text without treating synthetic fixtures as real-corpus evidence.

`public-product-corpus.json` registers repository documentation by relative path. The benchmark hashes those source files at execution time, loads the pinned multilingual embedding model, persists vectors in PostgreSQL/pgvector, and queries through the production retrieval/RRF implementation. `public-product-corpus-cases.jsonl` contains held-out labelled questions.

This corpus is intentionally limited to the Architecture Knowledge Platform documentation. Results measure this corpus only: they do not establish quality on private customer vaults, production traffic, extraction/chunking fidelity, or domain-general superiority. A production retrieval default must therefore remain a separate decision with explicit evidence and guardrails.
