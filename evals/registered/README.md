# Registered retrieval datasets

Versioned, redistributable datasets used to evaluate retrieval against shipped product documentation live here.

`public-product-corpus.json` defines the source-document set and vault grouping. `public-product-corpus-cases.jsonl` defines held-out labelled queries and expected evidence.

Each evaluation records source hashes, model revision, retrieval configuration, runtime versions, and evidence level so results remain reproducible. This dataset measures retrieval quality for the public documentation corpus only; it does not represent customer vaults, private corpora, or production traffic.
