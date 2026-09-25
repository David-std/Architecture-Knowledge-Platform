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
  X->>X: bounded stream, hash verification, capability routing
  X-->>W: artifacts + locators + extractor/provider version
  X->>X: delete temporary file
  W->>D: source, artifacts, evidence and identity result
```

Hash mismatch fails with `IMMUTABLE_OBJECT_HASH_MISMATCH`. DOCX paragraphs and
tables and PPTX slides/notes carry source-hash locators. OCR-capable routes
produce page and region provenance when the selected local/provider capability
is configured; an unavailable explicitly requested capability fails closed with
`CAPABILITY_NOT_CONFIGURED` rather than fabricating an artifact. Audio/video
transcription is optional and requires an administrator-configured transcription
endpoint; video demux additionally requires local ffmpeg. Visual captioning is
reported separately and is never implied by transcription. Long stages renew
their lease. Another worker can reclaim the job only after lease expiry.

## Compilation, review and publication

```mermaid
sequenceDiagram
  participant W as Worker/compiler
  participant D as PostgreSQL
  participant G as Managed Git repository
  participant R as Reviewer
  participant P as Projection worker
  W->>D: identity and materiality classification
  alt identical representation
    W->>D: NO_MATERIAL
  else new, update or disputed
    W->>G: isolated review worktree + commit
    W->>D: validation, probes, impact, REVIEW_REQUIRED
    R->>D: approve/reject/request changes with reason
    alt approved
      D->>D: acquire publication lock
      D->>D: persist PUBLISHING intent
      D->>G: squash merge exact reviewed head onto expected base
      D->>D: atomically mark APPROVED + append durable publication events
      D-->>P: causal outbox delivery
      P->>D: rebuild exact/lexical/vector/graph/context projections
    else rejected
      D->>D: retain auditable rejection without main-branch write
    end
  end
```

Canonical publication and projection maintenance are deliberately separated.
After the reviewed Git commit succeeds, the API finalizes the review and appends
`KnowledgePublished`, `CorpusRevisionPublished` and the projection requests in
one PostgreSQL transaction. Lexical, vector, graph and ContextPacket state is
then rebuilt asynchronously by the durable outbox worker; an ordinary
projection failure is retried, quarantined or reconciled and does not revert
canonical Git.

If Git moved but database finalization fails, publication compensation attempts
a Git revert before returning the review to `CHANGES_REQUESTED`. If that state
cannot be attributed or compensated safely, the review moves to
`PUBLICATION_RECOVERY_REQUIRED` and requires explicit reconciliation. A crash
after the Git commit and before database finalization is recovered only when the
current main commit can be matched exactly to the durable `PUBLISHING` intent;
otherwise reconciliation fails closed.

Rollback is itself a new canonical publication. The managed repository creates
a Git revert commit and the database appends a new `CorpusRevisionPublished`
root event plus the same projection invalidation/update fanout, so derived state
converges to the rollback revision through the normal durable lifecycle.

## Retrieval and ContextPacket

```mermaid
flowchart TD
  Q["Query + principal"] --> Scope["Resolve authorized scopes/resources"]
  Scope --> Constraints["Profile + temporal + revision constraints"]
  Constraints --> Planner["Intent / query-shape planner"]
  Planner --> Exact["Exact / alias"]
  Planner --> FTS["Lexical / FTS"]
  Planner --> Vector["Vector, optional"]
  Planner --> Code["Code / symbol"]
  Planner --> Graph["Typed graph / PPR / community"]
  Planner --> Temporal["Temporal"]
  Planner --> Raw["Raw/source fallback"]
  Exact --> Truth["Lifecycle + support + truth + freshness validation"]
  FTS --> Truth
  Vector --> Truth
  Code --> Truth
  Graph --> Truth
  Temporal --> Truth
  Raw --> Truth
  Truth --> Fusion["RRF / bounded fusion"]
  Fusion --> Rerank["Optional rerank"]
  Rerank --> Assemble["Dedupe + diversity + conflict coverage"]
  Assemble --> Packet["Evidence-aware ContextPacket"]
  Packet --> Verify["Final revision-set verification"]
```

Authorization constrains candidate generation before graph/vector/community expansion. Truth-valid retrieval rejects stale or unsupported derived candidates before they can displace valid candidates during fusion or reranking. Optional channels may degrade independently, but they cannot resurrect candidates rejected by authorization, lifecycle, temporal or support policy.

## Workspace coordination and promotion

```text
┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────────┐
│ READ       │ → │ WORK       │ → │ VERIFY     │ → │ CAPTURE/HANDOFF│
│ bootstrap  │   │ code/tools │   │ support    │   │ durable state  │
└────────────┘   └────────────┘   └────────────┘   └───────┬────────┘
                                                              │
                                                    durable knowledge?
                                                              │
                                                              ▼
┌────────────┐   ┌────────────┐   ┌────────────┐   ┌────────────┐
│ EVOLVE     │ ← │ PUBLISH    │ ← │ REVIEW     │ ← │ PROMOTE    │
│ next read  │   │ Git+events │   │ human/policy│  │ candidate  │
└────────────┘   └────────────┘   └────────────┘   └────────────┘
```

Work claims and handoffs are durable coordination state. Promotion creates a governed review candidate; only the existing review/publication path can produce approved managed-Git knowledge.

## Browser authentication

```mermaid
sequenceDiagram
  participant B as Browser
  participant V as Web server
  participant A as API
  participant D as PostgreSQL
  B->>V: submit scoped bearer token by POST form
  V->>A: exchange scoped bearer token
  A->>D: store session and CSRF hashes + expiry
  A-->>V: HttpOnly SameSite session cookie + CSRF token
  V-->>B: set cookies and redirect to workspace
  B->>V: session cookie on read
  V->>A: forward session cookie
  A->>D: validate session and current memberships
  B->>V: submit authorized write
  V->>A: cookie + X-CSRF-Token on write
  V->>A: revoke session
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
  Hash --> Isolated["Isolated restore verification"]
  Isolated --> Checks["Applied migration manifest + Git/MinIO integrity + rebuild checks"]
```
