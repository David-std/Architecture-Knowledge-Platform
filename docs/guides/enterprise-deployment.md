# Enterprise Deployment Guide

## What this feature is

AKP supports local and shared-node deployments while preserving a local-first security posture. A shared deployment centralizes the API, worker, PostgreSQL coordination state and rebuildable projections without changing the authority of managed Git or source evidence.

The deployment model separates service availability from model/provider availability. Optional LLM, embedding and document-intelligence providers are selected explicitly and may have stricter data-residency boundaries than the deployment as a whole.

## When to use it

Use a Team Node when multiple authorized users or agents need shared workspace state, common indexes and one database authority.

Use federated organization mode only when separate nodes must remain independently authorized and query each other through the bounded federation contract.

The default configuration is not intended for direct hostile internet or hostile multi-tenant exposure. Add transport security, managed identity/secrets and stronger database isolation before such exposure.

## Configuration

Start from `.env.example`, but replace every credential placeholder. Core runtime settings include:

- `DATABASE_URL`.
- `AKP_RAW_ENDPOINT`, `AKP_RAW_BUCKET` and MinIO credentials.
- `AKP_EXTRACTOR_URL` and `AKP_EXTRACTOR_TOKEN`.
- `AKP_MANAGED_REPO`.
- `AKP_API_TOKEN` and `AKP_API_TOKEN_SCOPES`.
- `AKP_CONTEXT_FABRIC_MODE` and `AKP_CONTEXT_FABRIC_NODE_ID` for shared deployments.
- `AKP_VECTOR_ENABLED` for optional vector retrieval.
- OpenTelemetry exporter settings when telemetry is required.

Legacy knowledge compilation can use `AKP_LLM_PROVIDER`, `AKP_LLM_BASE_URL`, `AKP_LLM_MODEL` and related timeout/retry settings. Role-policy routing additionally supports explicit endpoint references and residency classification; endpoint credentials remain deployment secrets and are not persisted in policy.

For federated peers, PostgreSQL stores only a `credentialRef` naming an environment variable. The referenced secret is resolved by the API process and is not returned by peer APIs.

## Normal workflow

1. Install dependencies with the frozen lockfile.
2. Start PostgreSQL, MinIO and the extractor.
3. Apply migrations before starting writable services.
4. Provision scoped credentials.
5. Start API, worker and Web from the same product revision.
6. Verify liveness/readiness and run `pnpm akp doctor --format human`.
7. Import or register approved vaults and sources.
8. Enable optional providers only after endpoint, trust and residency requirements are configured.
9. Configure backup and restore verification before treating the node as shared operational state.

For a Team Node, the API and worker claim the configured node identity in PostgreSQL. A different identity cannot silently adopt the database.

## Security and governance boundaries

Services bind to loopback by default in workstation use. Publishing ports on a routable interface is an operator decision and should sit behind transport security.

Tokens are scoped by space, path and permission. Do not use an administrative whole-space token for normal agent traffic.

Raw source bytes and provider output have no publication authority. Canonical knowledge still requires governed review and Git publication.

Model residency is enforced from the most restrictive applicable source/data, organization, space and profile boundary. Organization policy is an enterprise-wide upper constraint; a space or source may tighten it further, while role configuration and fallback preference can never relax it. An endpoint registered as externally allowed cannot satisfy a local-only route merely because a model policy is mislabeled.

Do not place provider API keys, federation bearer tokens or signed URLs in persisted policy or diagnostics.

## Degraded and offline behavior

The API exposes liveness separately from readiness. PostgreSQL, object storage or extractor outages can make readiness fail while the process remains alive.

Optional retrieval/model channels may degrade when the active policy allows it. Model fallback is attempted only when the failing route permits safe degradation and the fallback already satisfies the effective residency requirement.

Federation peer failure is isolated by timeout, bounded response size and a durable circuit breaker. Local results remain usable for optional peers unless the caller explicitly requires every peer.

## Failure and recovery

Backups contain PostgreSQL, MinIO data, a managed Git bundle when configured, and non-secret configuration metadata. Restore validation checks hashes, migration inventory, durable state tables and a rebuildable lexical projection.

Run `pnpm akp doctor --format human` after restart or restore. Rebuild derived projections when the restore manifest declares `REBUILD_DERIVED_PROJECTIONS`.

OpenTelemetry collector failure must not make core product functions unavailable. When a reliable collector health endpoint is configured, doctor reports it separately.

## Example

A shared engineering deployment can run one Team Node with local document extraction, vector retrieval enabled and knowledge compilation routed to an organization-approved endpoint. Sensitive sources marked `LOCAL_ONLY` still bypass that external route and use only a compatible local model candidate or an explicit non-generative fallback.

## Limitations

Database row-level security is not the primary isolation boundary. Backup encryption, remote replication, WORM storage, OIDC/MFA and public-edge hardening remain deployment responsibilities.

Provider cost ceilings and exact input-token limits are enforced only when the provider integration can supply reliable accounting/tokenization; unsupported precision requirements fail closed rather than using guessed token counts.
