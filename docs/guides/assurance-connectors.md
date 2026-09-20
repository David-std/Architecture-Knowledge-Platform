# Assurance and Connector Guide

## What this feature is

Continuous Assurance runs bounded detectors over durable AKP state and records normalized findings. Source connectors ingest signed, sequence-ordered external events into an untrusted projection with durable checkpoints.

Assurance findings are diagnostics, never canonical knowledge. Connector objects remain external/untrusted projections even when they are searchable or linked into work context.

## When to use it

Use Continuous Assurance for grounding, freshness, contradiction, graph/temporal/code health, connector drift/deletion, orphan work, stale handoff and related operational checks.

Use source connectors when an external system can deliver authenticated ordered UPSERT/DELETE events and AKP must preserve source identity, permissions fidelity and no-gap checkpoint semantics.

## Configuration

Assurance runs are scoped to one space/vault and select an allowed detector set. They use durable attempts, leases, cancellation and an idempotency key.

A connector registration defines connector key, source system, public key, bounded descriptor and active/disabled state. Connector events carry source-owned sequence, source version, operation, object identity, permission fidelity, optional ACL fingerprint and a payload hash.

Connector policy in an active Knowledge Profile can restrict allowed access modes and require permission fidelity.

## Normal workflow

1. Register an authenticated connector or start an assurance run.
2. Connector events enter the durable inbox in source sequence order.
3. Only contiguous valid events advance the connector checkpoint.
4. UPSERT updates the current external projection; DELETE creates a tombstone rather than silently removing history.
5. Assurance detectors inspect current durable/derived state and create normalized findings with evidence references.
6. Operators acknowledge, suppress or resolve findings through the lifecycle surface.
7. A finding that should become canonical guidance must enter the normal promotion/review workflow.

## Security and governance boundaries

Connector payload is `UNTRUSTED_EXTERNAL`. A signed delivery authenticates the source event but does not grant the content canonical trust.

Replay/duplicate identity and sequence constraints prevent a valid old event from silently advancing the checkpoint twice. Permission uncertainty is explicit and can restrict use of connector content.

Assurance work is lease-fenced and idempotent. A stale worker cannot overwrite a newer lease result.

Connector secrets/private credentials must not be persisted in generic errors or audit metadata.

## Degraded and offline behavior

A gap in connector sequence blocks later application until the missing event is resolved; AKP does not skip ahead and pretend the checkpoint is current.

Retryable apply failures keep the event pending with a bounded attempt budget. Exhausted events are surfaced by doctor/operations rather than retried forever.

Assurance runs can resume from their durable cursor after worker interruption. A detector failure is recorded without manufacturing a successful finding set.

## Failure and recovery

Connector registrations, checkpoints, inbox events and assurance findings are durable backup state. After restore, pending events retain their sequence/attempt state.

Use `pnpm akp doctor --format human` to identify exhausted connector events and open critical findings. Restart workers only after fixing the underlying provider/data condition when retries are exhausted.

Revoking or disabling a connector prevents further trusted application of its events; retained tombstones/checkpoints preserve provenance.

## Example

An external issue tracker sends sequences 10, 11 and 13. AKP applies 10 and 11, keeps 13 pending because 12 is missing, and does not advance the durable checkpoint past 11. An assurance detector can surface connector freshness or ACL drift without turning issue text into approved knowledge.

## Limitations

Connector permission fidelity depends on what the source system can express and sign. `WORKSPACE_WIDE` or `NONE` fidelity is weaker than exact ACL mapping and should be treated accordingly.

Continuous Assurance detects configured classes of inconsistency; it is not a proof that every possible semantic or security defect is absent.
