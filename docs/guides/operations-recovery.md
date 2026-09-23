# Operations and Recovery Guide

## What this feature is

AKP operations combine liveness/readiness, OpenTelemetry, durable job/outbox diagnostics, `doctor`, backup/restore verification and rebuildable projection recovery.

The recovery contract distinguishes durable authority/state from rebuildable derived projections. PostgreSQL and source/managed-Git state are restored; vector, graph, community and context projections can be reconciled/rebuilt from that durable authority.

## When to use it

Use this guide for routine health checks, deployment changes, dependency outages, backup verification, disaster-recovery drills and post-restore validation.

For workstation setup commands, also see the [Local Operations Runbook](../runbooks/local-operations.md).

## Configuration

Core health dependencies are PostgreSQL, raw object storage and the extractor. Optional OpenTelemetry uses standard OTLP environment variables; `AKP_OTEL_HEALTH_URL` can provide a reliable collector health probe for doctor.

`AKP_BACKUP_DIR` selects the backup location doctor inspects. `AKP_BACKUP_MAX_AGE_HOURS` controls its recency warning threshold.

`AKP_MANAGED_REPO` identifies managed Git. Backup v4 records migration inventory, per-artifact SHA-256, durable-state coverage, rebuildable-state policy and non-secret configuration metadata.

## Normal workflow

1. Check `/health/liveness` for process health and `/health/readiness` for required dependencies.
2. Run `pnpm akp doctor --format human` for a broad operational diagnosis.
3. Inspect durable jobs, outbox retries/quarantine, profile/revision parity, vector/graph/truth/community state, connectors, federation peers and critical findings.
4. Capture a backup to a new/empty directory.
5. Run isolated restore verification and managed-Git restore verification.
6. Rebuild derived projections when the manifest declares `REBUILD_DERIVED_PROJECTIONS`.
7. Run doctor again and validate retrieval/runtime gates before resuming normal shared traffic.

Doctor also supports JSON output for automation. A `FAIL` sets a nonzero exit status; `WARN`/`UNKNOWN` preserve distinctions such as an optional exporter with no reliable health URL.

## Security and governance boundaries

Backup metadata explicitly excludes secrets. Federation rows persist credential references, not bearer-token material; provider credentials are deployment configuration.

Diagnostic failures use bounded machine-safe codes rather than persisting arbitrary source/provider messages.

Backup directories, private reports and `.env` are not product repository artifacts. Secret scanning and repository hygiene remain release gates.

## Degraded and offline behavior

Collector failure does not make core AKP unavailable. Required data dependencies do affect readiness.

Quarantined outbox deliveries and exhausted connector events require operator action; AKP does not loop indefinitely.

An unavailable optional vector/model/federation provider can degrade only when the active policy allows it. A required authority/revision mismatch fails closed.

## Failure and recovery

Backup v4 includes PostgreSQL, MinIO data, a managed Git bundle when configured and non-secret metadata. Restore verification checks hashes, migrations and required durable tables in an isolated database/volume.

Managed-Git restore clones the bundle into a new repository, verifies revision/file inventory and proves that searchable derived state can be rebuilt.

Federation circuit state, workspace state, truth/support records, connector checkpoints and profile revisions survive PostgreSQL recovery. Rebuildable projections should be regenerated against the restored authority revisions.

## Example

After a PostgreSQL host loss, restore the verified dump and MinIO archive, restore managed Git, rebuild projections, then run doctor. If graph revisions are absent but canonical Git/truth/source state is intact, graph health may be WARN/UNKNOWN until rebuild completes; operators should not mark the system healthy by manually editing projection rows.

## Limitations

Backup encryption, remote replication and WORM retention are deployment responsibilities. The built-in backup format proves integrity/recoverability, not off-site disaster strategy.

Doctor is an operational diagnostic surface, not a formal proof of semantic correctness. Competitive/retrieval quality remains covered by evaluation suites.
