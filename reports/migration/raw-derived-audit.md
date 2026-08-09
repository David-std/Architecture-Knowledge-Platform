# Raw and derived audit

| Class                                  | Canonical/preserved location         | Agent use                                   |
| -------------------------------------- | ------------------------------------ | ------------------------------------------- |
| Operational compiled notes             | external vault                       | normal retrieval subject to trust/lifecycle |
| Curated recovery routers               | `Resources/source-collection`        | normal source route; human-reviewed         |
| Web clips and local recovery artifacts | `Resources/source-collection`        | raw fallback only                           |
| Transfer packs/acquisition manifests   | `Resources/transfer-packs`           | archived provenance; never normal guidance  |
| Licensed originals                     | external `Resources/private-library` | selective locator-based recovery only       |
| Managed approved notes                 | managed Git repository               | normal retrieval after human review         |
| Units/FTS/vectors/graph/packets        | PostgreSQL                           | derived, rebuildable                        |
| Raw source bytes                       | MinIO SHA-256 keys                   | immutable input/evidence recovery           |

The platform does not copy protected books into its source repository.
