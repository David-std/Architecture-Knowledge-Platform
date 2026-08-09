# Vault import evidence

The latest authoritative run is `8e579e4c-e852-46cf-895f-dfebcf6372cf`; see `vault-import-latest.md`. Compared with the earlier parser, the curation-aware importer:

- promotes only explicitly curated source-recovery documents;
- assigns path-derived IDs to raw/archive material, preventing copied IDs from colliding;
- quarantines acquisition/download manifests;
- reads explicit source/evidence/claim/rule/context-pack dependencies;
- keeps ambiguous wikilinks as `related_to`;
- creates tombstones for removed imported documents;
- scopes relation replacement to the imported vault.

No automatic content rewrite or fabricated link was performed.
