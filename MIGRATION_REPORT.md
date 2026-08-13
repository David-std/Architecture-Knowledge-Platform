# Vault migration report

## Preservation gate

- Source vault: `C:\Users\david\Documents\Architecture-Knowledge-System`
- Pre-platform ZIP: `C:\Users\david\Documents\Architecture-Knowledge-System-pre-platform-2026-07-29.zip`
- ZIP size: 649,726,650 bytes
- ZIP SHA-256: `36047B031E5D2CDBAFDEC0E6A97BEA9709C8479B1871D043FB982FCDDCD657CD`
- Physical manifest before/after: `4dc3f0bfab2ee4ca0c3cc25767a3818d8d053a53eb3ca76e1e0c2e92288c7c0a` over 871 files
- Vault Git status: not a Git repository; importer revision is a deterministic content snapshot
- `.obsidian`: present

No platform code, index, cache or job state was written into the vault.

## Latest import result

Run `8e579e4c-e852-46cf-895f-dfebcf6372cf` imported 548 Markdown files: 361 operational and 187 raw. It preserved 354 stable operational IDs, resolved 1,192 relations and reduced the operational graph to two connected components. There were zero import errors, 100 unresolved ordinary wikilinks and six intentional acquisition-backlog quarantine warnings.

## Raw/derived audit

- `Resources/transfer-packs/**`: archived provenance; never normal agent guidance.
- Non-curated clips/PDF indexes under `Resources/source-collection/**`: raw recovery evidence.
- Ten source-collection guides/maps with explicit `status: curated`: promoted to source-layer human-reviewed routers.
- Operational notes in `00-system` through `90-agent-layer`, examples and projects: compiled projection.
- PostgreSQL FTS, units, embeddings, graph and packets: derived and disposable.
- Licensed originals: stay in the external private library and are not copied into this repository.

## Known schema/content gaps

- 100 wikilinks do not resolve deterministically; they remain warnings, not fabricated edges.
- `applies_to` values such as framework tags are taxonomy values, not graph nodes, and are intentionally not forced into relations.
- The vault is not Git-versioned, so the initial source revision is a snapshot hash rather than a commit.
- Controlled write enablement for the original vault is not performed. New reviewed material is published to a separate managed repository.

Detailed artifacts live under `reports/migration/`.

## Platform schema extension — 2026-08-12

The source-vault preservation result above is unchanged. The executable
platform added append-only migrations `013`–`016` for VaultRegistry,
event/outbox delivery, structural incremental indexes and the canonical
DocumentArtifact contract. A fresh database applied all 16 migrations and the
v3 recovery smoke restored the exact 16 names/checksums. This extension changes
derived platform state only; it does not mutate the external vault.
