# S2 — authorized offline source rebinding (2026-10-18)

**Status:** implementation and synthetic unit tests only. Not an actual reader
study, not an independent holdout, and **not S2 gate acceptance**. The source
and question content of the calibration review never enters admission logic.

`s2AdmissionShadowSink` records _application_ decisions for `/v1/search` and
`/v1/context` with only hashed identifiers and excerpt-relative UTF-16 spans.
That record **cannot** prove a quote came from the original document. The
offline `rebindS2AdmissionToSource` function and its CLI check each admitted
reader span against an authorized source-unit snapshot at the recorded
revision. They do not modify production admission or call a model.

## Secure inputs

Create two JSON documents in a restricted local directory; **never commit**
source snapshots, queries, credentials, recorded session traces or reviewer
gold. First document (`--observations`):

```json
{
  "schemaVersion": "akp.s2.observed-admission-run.v1",
  "runId": "s2_authorized_run_001",
  "executedCommitSha": "<40-hex-commit>",
  "observations": [
    "<S2AdmissionShadowObservation records from the actual sink>"
  ]
}
```

Second document (`--sources`):

```json
{
  "schemaVersion": "akp.s2.authorized-snapshot-batch.v1",
  "runId": "s2_authorized_run_001",
  "frozenSourceManifestSha256": "<64-hex-SHA256-of-precommitted-source-manifest>",
  "snapshots": [
    {
      "query": "<actual question, held privately>",
      "authorizedVaultIds": ["<authorized vault ID>"],
      "candidates": [
        {
          "vaultId": "<matching vault>",
          "documentId": "<matching document>",
          "unitId": "<matching unit or null>",
          "revision": "<same revision that the reader saw>",
          "excerpt": "<exact SearchHit.excerpt bytes>",
          "sourceUnitText": "<exact original source unit bytes>",
          "sourceUnitSha256": "<64-hex independently pinned digest>"
        }
      ]
    }
  ]
}
```

For each distinct query plus authorized vault scope there must be exactly one
snapshot; its candidate list must match all recorded candidates, including
**rejected** ones. Search and context observations may reference that same
snapshot. Authorize the source fetch and verify both the manifest and the
original unit SHA-256 **independently** before the run. The CLI checks internal
hash consistency but cannot verify that external freeze or reviewer
independence; it always reports `sourceProvenanceExternallyVerified: false`.

Run from the repository root with a pinned Node/pnpm environment:

```sh
pnpm exec tsx scripts/s2-rebind-admission-shadow.ts \
  --observations /secure/s2-admissions.json \
  --sources /secure/s2-authorized-source-snapshot.json \
  --output /secure/s2-source-rebound.json
```

Output contains only hashes, status codes, absolute _source-unit_ UTF-16
offsets, counts and digests of the two input files. No source text, queries,
quotes or gold labels are serialized. Keep the output access-controlled too:
hashes are **pseudonyms, not anonymization**.

## Fail-closed checks and interpretation

The validator requires matching query/scope/candidate hashes, identical
vault/document/unit/revision identities, an authorized vault and a matching
SHA-256 for the original source unit. Missing/extra candidates, duplicate
candidate identities, stale revisions, unmatched excerpts and mismatched
digests are errors or explicit non-rebound statuses. A trimmed excerpt must
occur **exactly once** in the source unit; the evaluator does not guess which
occurrence is intended. It guards UTF-16 surrogate boundaries and checks the
reader's quote digest against both the excerpt slice and the source slice.

| Status                      | Meaning                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| `NOT_ADMITTED`              | A reader/shadow trace may exist, but the application did not admit this candidate  |
| `ADMITTED_NO_READER_SPAN`   | Application admission occurred without a reader span; not a proven source citation |
| `INVALID_EXCERPT_SPAN`      | Reader offsets or Unicode boundary invalid                                         |
| `SOURCE_EXCERPT_MISSING`    | Returned excerpt cannot be located byte-exactly in original unit                   |
| `SOURCE_EXCERPT_AMBIGUOUS`  | Repeated excerpt makes original offset ambiguous                                   |
| `SOURCE_SPAN_HASH_MISMATCH` | The quote bytes/digest are inconsistent                                            |
| `SOURCE_SPAN_REBOUND`       | Source-unit offset and quote digest are byte-exact for the supplied snapshot       |

`SOURCE_SPAN_REBOUND` is **not** proof that the quote answers the question,
that the gold span is covered, or that the final answer is correct. Reader
admission on a no-answer question requires _independent_ adjudicated gold to
calculate FAR. Report semantic citation precision, language/source strata,
request-level p95, degradation, answer correctness and manual/Obsidian paired
results in a separate locked evaluator. The CLI reports
`semanticPrecisionMeasured: false`, `falseAdmissionRate: null`,
`fullRequestP95Ms: null`, `gateAccepted: false`.

## Reproduction boundary

Unit tests `apps/api/test/s2-admission-shadow.test.ts` and
`apps/api/test/s2-source-rebind.test.ts` exercise synthetic Unicode and
source mismatches without storing authentic user data. No real admission
measurements were produced by adding this code. E5 remains shadow; S2 OPEN,
S3–S5 blocked; PR #38 must stay OPEN/DRAFT, with no merge or promotion.
