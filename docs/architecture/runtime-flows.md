# Runtime flows

## Read-only vault import

```mermaid
flowchart LR
  Vault["External Obsidian vault"] -->|read-only snapshot| Importer["Vault importer"]
  Importer --> Identity["Stable IDs, aliases and lifecycle"]
  Importer --> Units["Hierarchical knowledge units"]
  Importer --> Edges["Typed dependency and related edges"]
  Identity --> DB["PostgreSQL projection"]
  Units --> DB
  Edges --> DB
  DB --> Index["Lexical, graph and optional vector indexes"]
```

The importer never writes indexes, runtime state or corrected metadata back to
the vault. Curated recovery maps remain operational knowledge. Copied
acquisition/download manifests are preserved as archived raw provenance and do
not enter normal agent retrieval.

## Immutable source ingestion and extraction

```mermaid
sequenceDiagram
  participant C as Client
  participant A as API
  participant D as PostgreSQL
  participant W as Worker
  participant O as MinIO
  participant X as Docker extractor
  C->>A: submit allowlisted source + idempotency key
  A->>D: create RECEIVED job
  W->>D: claim lease with fencing owner
  W->>O: stream source to SHA-256 object key
  W->>O: download immutable bytes
  W->>W: rehash materialized object
  W->>X: authenticated multipart + expected SHA-256
  X->>X: bounded stream, hash verification, extraction
  X-->>W: artifacts + locators + extractor version
  X->>X: delete temporary file
  W->>D: source, artifacts, evidence and identity result
```

Hash mismatch fails with `IMMUTABLE_OBJECT_HASH_MISMATCH`. DOCX paragraphs and
tables and PPTX slides/notes carry source-hash locators. Audio/video and
OCR/vision return `CAPABILITY_NOT_CONFIGURED` rather than a fabricated artifact.
Long stages renew their lease. Another worker can reclaim the job only after
lease expiry.

## Compilation, review and publication

```mermaid
sequenceDiagram
  participant W as Worker/compiler
  participant D as PostgreSQL
  participant G as Managed Git repository
  participant R as Reviewer
  W->>D: identity and materiality classification
  alt identical representation
    W->>D: NO_MATERIAL
  else new, update or disputed
    W->>G: isolated review worktree + commit
    W->>D: validation, probes, impact, REVIEW_REQUIRED
    R->>D: approve/reject/request changes with reason
    alt approved
      D->>D: acquire publication lock and verify base
      D->>G: squash merge exact review branch
      D->>D: versions, units, relations, lint and revisions
    else rejected
      D->>D: retain auditable rejection; no main-branch write
    end
  end
```

If a downstream projection step fails after Git publication, compensation
attempts a revert and records the failure in the Error Book.

## Retrieval and ContextPacket

```mermaid
flowchart LR
  Q["Scoped query"] --> Planner["Deterministic intent planner"]
  Planner --> Exact
  Planner --> FTS["PostgreSQL FTS"]
  Planner --> Vector["pgvector, feature-flagged"]
  Planner --> Graph["Typed graph"]
  Planner --> Packs["Context-pack router"]
  Planner --> Fallback["Raw/code fallback"]
  Exact --> RRF
  FTS --> RRF
  Vector --> RRF
  Graph --> RRF
  Packs --> RRF
  Fallback --> RRF
  RRF --> Policy["RBAC + lifecycle + trust + freshness"]
  Policy --> Packet["Budgeted ContextPacket"]
```

The executed four-case benchmark selected `lexical+graph`, tied in MRR with
`exact+lexical+graph`; stable configuration order broke the tie. This is only a
small regression-set choice. Vector remains disabled until a larger evaluation
justifies it. Packets retain retrieval channels/reasons, corpus and index
revisions, citations, conflicts, gaps and continuation handles.

## Browser authentication

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as API
  participant D as PostgreSQL
  B->>A: scoped bearer token, one-time exchange
  A->>D: store session and CSRF hashes + expiry
  A-->>B: HttpOnly SameSite session cookie + CSRF token
  B->>A: session cookie on read
  A->>D: validate session and current memberships
  B->>A: cookie + X-CSRF-Token on write
  B->>A: revoke
  A->>D: set revoked_at
```

## Schema governance, lint and Error Book

```mermaid
flowchart TD
  Schema["Candidate schema"] --> Dry["Repeatable read-only dry run"]
  Dry --> Fingerprint["Before/after corpus fingerprint"]
  Dry --> Compatibility["Compatibility + affected documents"]
  Compatibility --> Approval["Reviewed migration/rollback decision"]
  Merge["Merge/source/reindex"] --> Lint["Deterministic lint"]
  Schedule["Worker schedule"] --> Lint
  Failure["Recurring failure"] --> Book["Persistent Error Book entry"]
  Book --> Regression["Active regression eval"]
  Regression --> Verify["Correction verification and resolution"]
```

Dry-run never applies a migration. Lint findings are durable reports. Error
Book resolution requires a recorded verification result.

## Backup and isolated restore

```mermaid
flowchart LR
  PG["PostgreSQL dump"] --> Set["Manifested backup set"]
  MinIO["MinIO archive"] --> Set
  Git["Managed Git bundle"] --> Set
  Config["Non-secret configuration"] --> Set
  Set --> Hash["Per-file SHA-256"]
  Hash --> Isolated["Isolated restore smoke"]
  Isolated --> Checks["555 documents + 16 migrations + Git + MinIO archive"]
```
