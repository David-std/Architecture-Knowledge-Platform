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
  `Set-Cookie` headers. Vault enabled/visibility state plus explicit and
  inherited grants are included in the current authorization fingerprint, so a
  replay after revocation fails closed.
- Ingestion, extractor and publication paths validate roots/hash/content; Git
  drafts use isolated worktrees, duplicate-path rejection, immutable reviewed
  head checks, cleanup and scoped authorization.
- Backup v3 records a fixed non-secret artifact inventory with hash/size,
  exact migrations and an optional verified managed Git bundle.

## Executed evidence

- 34 API integration tests (26 security/governance, 7 publication and 1
  product-lifecycle E2E):
  invalid credentials/identifiers,
  cross-space projection, narrow session scope, malformed prefix failure,
  idempotency partition/lease, traversal, CSRF, staleness, reindex, schema,
  Error Book, lint and audit isolation.
  invalid frontmatter cleanup, duplicate paths, competing decisions, changed
  draft tip rejection, vault-scoped outbox publication and rejected draft
  cleanup. The current source also asserts that status and vault metadata omit
  local paths, canonical host paths and raw-source object keys.
- The product-lifecycle suite additionally proves that unapproved and rejected
  content cannot enter search, while rollback removes the approved content
  through a tombstone and incremental index update.
- Unauthenticated Web server renders now redirect to `/login` instead of
  turning the missing-session boundary into HTTP 500. Two unit regressions and
  live unauthenticated/authenticated page smokes cover the behavior.
- ContextPacket regression coverage keeps an explicit indirect prompt-injection
  payload inside the untrusted evidence section and does not create permission,
  tool-policy or publication-policy fields. The Python extractor regression
  removes script/style/noscript content and active HTML attributes while
  preserving visible text.
- The dependency audit initially found vulnerable transitive Hono 4.12.32.
  The workspace now pins 4.13.5; the repeated audit reports zero known
  vulnerabilities. The final tracked-file secret scan passed across 340
  classified files.

## Residual risks

- No PostgreSQL RLS or external WORM audit ledger; isolation remains application
  enforced.
- Git publication and the database/outbox transaction still span different
  resource managers; compensation and reconciliation replace an atomic
  distributed commit.
- Local identity has no OIDC/MFA/device assurance. Backups are integrity-hashed
  but not encrypted or remotely replicated; MinIO Object Lock is disabled.
- Secret scanning is heuristic and excludes ignored material by design. Python
  dependencies use ranges rather than a fully hashed lock.
- The adversarial corpus is small. This baseline is not ready to expose as a
  public multi-tenant internet service without the listed hardening.
