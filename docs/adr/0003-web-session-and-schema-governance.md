# ADR 0003 — Opaque web sessions and executable schema dry runs

- Status: accepted
- Date: 2026-08-01

## Context

The initial Web adapter reused a server-side API token. That supported a local
smoke but did not provide a human session lifecycle or CSRF boundary. Schema
governance also existed only as policy text, so compatibility and affected
document counts could not be executed before a migration.

## Decision

Bearer tokens remain the automation/MCP credential. A bearer token can be
exchanged for a random opaque browser session. PostgreSQL stores only SHA-256
hashes of the session and CSRF secrets. Session cookies are HttpOnly,
SameSite=Strict, expiring and revocable; every session-authenticated write must
present the CSRF token. Permissions and spaces are recomputed from current
memberships on every request.

Schema proposals use `POST /v1/schema/dry-run`. The operation reads a
repeatable, read-only corpus snapshot, fingerprints it before and after,
evaluates required metadata and type compatibility, persists the report, and
returns affected-document samples plus mandatory approval/reindex/eval steps.
It never applies the schema or edits the corpus.

## Consequences

- The Web UI can operate without exposing a long-lived token to server-rendered
  pages after login.
- Compromising a database dump does not reveal session or CSRF plaintext.
- OIDC, MFA and distributed session storage remain deployment extensions.
- Schema compatibility is measurable, but applying a schema still requires a
  reviewed migration and rollback plan.
- Integration tests cover expiry/revocation behavior indirectly through live
  authentication, CSRF denial and explicit revocation; broader browser threat
  testing remains desirable.
