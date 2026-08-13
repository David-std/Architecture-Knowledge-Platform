# Audit and evidence export contract

`@akp/audit-export` is a pure serializer for an authorized vault projection. It
does not open a filesystem, object store, database connection, or network
connection. Callers must perform authentication, vault-scope checks, and
metadata-only database queries before constructing an `AuditBundleInput`.

The package emits a deterministic logical bundle containing:

- `VAULT_MANIFEST.jsonl`, `SOURCE_MANIFEST.jsonl`, `DOCUMENTS.jsonl`,
  `RELATIONS.jsonl`, and `EVIDENCE_INDEX.jsonl`;
- `VALIDATION_RESULTS.json`, `RETRIEVAL_BENCHMARK.json`, and
  `GAPS_AND_CONTRADICTIONS.json`;
- optional `SAMPLE_CONTEXT_PACKETS/<safe-id>.json`; and
  `BUNDLE_METADATA.json`.

Rows are canonicalized and sorted by stable identifiers. ZIP entries are
uncompressed, sorted, and use fixed headers, so equal inputs (including
`generated_at`) produce byte-identical output and the same SHA-256
`bundle_hash`. A live HTTP export should record its generation timestamp in
metadata; consumers that need reproducible comparisons should persist that
timestamp and all revisions in the input metadata.

## Redaction and limits

The serializer removes keys matching secret, token, password, credential,
authorization, private-key, object-key, blob, binary, raw, body, bytes, host
path, and data conventions (case-insensitive). Strings are UTF-8 bounded and marked when
truncated. It never receives or reads original blobs, licensed source files,
object-store keys, host paths, bearer tokens, cookies, or credentials. The HTTP
adapter exports evidence locators and hashes without excerpts. Sample packet
files contain only revision/hash/budget and section identifiers; query text,
citations and section content are omitted.

Default and hard limits are deliberately finite: 10,000 sources; 20,000
documents; 50,000 relations; 50,000 evidence rows; 20 context packets; 16 KiB
per string; and 50 MiB total bundle bytes. A caller may lower these limits but
cannot raise them. Exceeding the total byte budget raises
`AUDIT_EXPORT_LIMIT_EXCEEDED`.

`locatorFilters` applies exact matching to evidence `locator` objects. An empty
filter set exports all authorized evidence; a non-empty set exports rows that
match at least one filter.

## API integration boundary

The API adapter requires an authenticated `admin`, validates the requested
vault through the vault registry, requires an unrestricted
(`pathPrefix = null`) membership, and requires the literal query confirmation
`EXPORT_SANITIZED_AUDIT_BUNDLE`. It returns the ZIP only to the requesting
actor, sets `Cache-Control: no-store`, and records an `audit.export` event containing only
the vault id/key, bundle hash, and row counts. Unauthorized vaults should not
be distinguishable from missing vaults. No export is sent to an external
destination.

The CLI writes a ZIP only when `--output` is explicit and the canonical target
is below an existing `AKP_EXPORT_ROOTS` entry. It rejects traversal, symlink
escape and overwriting. Without `--output`, the response body is cancelled and
only schema version, hash and byte metadata are printed.

The adapter should expose lower-than-hard limits and locator selection through
query parameters, map malformed parameters to `400`, path-scope denials to
`403`, unknown vaults to `404`, and total-size violations to `413`.

## Raw evidence export (explicitly disabled by default)

Raw bytes are a separate, higher-risk capability and are never included in the
sanitized audit ZIP or transferred through MCP. The API exposes these routes
only when `AKP_ENABLE_RAW_EVIDENCE_EXPORT=true` (the current baseline keeps this
flag `false`) and all raw object-store
credentials are supplied explicitly:

- `GET /v1/evidence/export/{vaultId}/{evidenceId}`;
- `GET /v1/evidence/export/{vaultId}?evidenceId=...` or with a JSON `locator`.

Every request requires the distinct literal `EXPORT_RAW_EVIDENCE`, an explicit
vault, `source:read` (or `admin`), and an effective path scope. Locator-only
selection must resolve to exactly one evidence row. The adapter verifies that
the source belongs to the vault, artifact/source hashes agree, the object
store's deterministic key and stat agree with the recorded SHA-256 and byte
size, and then reads and hashes the bounded object before sending it. The hard
limit is 50 MiB; callers may lower it with `maxBytes`. Responses contain only
the bytes plus a safe fixed filename, media type, byte count and SHA-256 header;
object keys, bearer tokens and host paths are not response metadata. A success
creates an `evidence.raw_export` audit event containing IDs, a locator hash,
byte count and SHA-256 only. Raw content itself is not sanitized, so this
capability must remain disabled unless the deployment explicitly accepts that
egress.

The CLI command is deliberately separate from the existing metadata command:

```text
akp evidence export-raw --vault-id <uuid> --evidence-id <uuid> \
  --confirm EXPORT_RAW_EVIDENCE --output <path-under-AKP_EXPORT_ROOTS>
```

It refuses missing selectors, traversal, symlink escape and overwrite. Without
`--output`, it cancels the body and prints only the verified response digest
and byte metadata. The existing `akp evidence export` command remains the
sanitized locator-manifest operation.
