# Security report

## Implemented and executed local controls

- API tokens are SHA-256 stored. Provisioning validates UUID scopes, safe
  relative path prefixes and permissions; the default bootstrap credential is
  revoked.
- Web sessions persist the effective token scope snapshot and re-intersect it
  with current memberships. Cookies are opaque, HttpOnly, SameSite=Strict,
  expiring/revocable; session writes require CSRF.
- Role, space and path prefix are enforced server-side. Path-scoped actors are
  rejected from pathless whole-space metadata endpoints with `PATH_SCOPE_DENIED`
  rather than receiving global status, vault, graph, source, session, eval,
  schema, lint or audit data.
- Idempotency is keyed by actor, credential scope fingerprint, concrete URL and
  canonical request. Uncertain expired claims become `ABANDONED`; session
  exchange is intentionally excluded because a replay cannot safely reproduce
  `Set-Cookie` headers.
- Ingestion, extractor and publication paths validate roots/hash/content; Git
  drafts use isolated worktrees, duplicate-path rejection, immutable reviewed
  head checks, cleanup and scoped authorization.
- Backup v3 records a fixed non-secret artifact inventory with hash/size,
  exact migrations and an optional verified managed Git bundle.

## Executed evidence

- 21 security/governance integration tests: invalid credentials/identifiers,
  cross-space projection, narrow session scope, malformed prefix failure,
  idempotency partition/lease, traversal, CSRF, staleness, reindex, schema,
  Error Book, lint and audit isolation.
- 5 publication integration tests: invalid frontmatter cleanup, duplicate
  paths, competing decisions, changed draft tip rejection and rejected draft
  cleanup.
- Clean Node 20 high-severity audit has no high finding (1 low and 3 moderate
  remain); secrets scan covered 221 tracked/untracked repository files under
  its documented policy.

## Residual risks

- No PostgreSQL RLS or external WORM audit ledger; isolation remains application
  enforced.
- Git and database projection use compensation rather than atomic distributed
  commit; publication lock lacks a durable cross-node fencing protocol.
- Local identity has no OIDC/MFA/device assurance. Backups are integrity-hashed
  but not encrypted or remotely replicated; MinIO Object Lock is disabled.
- Secret scanning is heuristic and excludes ignored material by design. Python
  dependencies use ranges rather than a fully hashed lock.
- The adversarial corpus is small. This baseline is not ready to expose as a
  public multi-tenant internet service without the listed hardening.
