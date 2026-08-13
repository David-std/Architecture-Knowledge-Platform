# Residual artifacts report

Status: `IMPLEMENTED_AND_EXECUTED`

This report is regenerated during final closure together with
`REPOSITORY_FILE_CLASSIFICATION.json`. Its purpose is to make every non-product
or iteration-like artifact explicit without deleting unique information.

## Reviewed residue

| Path                         | Purpose                                                        | Still authoritative                       | Unique information                           | Referenced by               | Action                                       |
| ---------------------------- | -------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------- | --------------------------- | -------------------------------------------- |
| `GOAL_V2_PROGRESS.md`        | Historical implementation ledger from an earlier iteration     | No                                        | No; final state belongs in canonical reports | none after cleanup          | `DELETE_AFTER_MERGE`                         |
| `.work/`, `.tmp/`, `.cache/` | Local builds, research clones and transient evidence           | No                                        | No canonical product knowledge               | ignored operational tooling | `KEEP_CANONICAL` as ignored workspace policy |
| `reports/`                   | Reproducible machine-readable benchmark and migration evidence | Yes when referenced by a canonical report | Yes                                          | benchmark/migration reports | `KEEP_CANONICAL`                             |

No additional root-level `GOAL_*`, `*_PROGRESS`, iteration, scratch, temporary
handoff or draft-plan documents are authorized. On 2026-08-12 the hygiene gate
classified 320 tracked and unignored files, reported zero `UNKNOWN` entries and
passed both write and verification modes.
