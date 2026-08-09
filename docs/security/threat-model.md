# Threat model

| Threat                             | Boundary                      | Current control                                                                                          | Residual risk                                                        |
| ---------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Cross-space read/write             | API/DB                        | permission-specific space list; membership role and path prefix evaluated together; integration tests    | no database RLS; application defect remains possible                 |
| Local file disclosure              | ingest/project scan           | canonical real path, registered allowlist roots, file-only/immutable-commit checks                       | deliberately broad allowlist broadens access                         |
| SSRF                               | ingest/extractor              | API rejects HTTP(S) ingest; remote content requires a captured local snapshot                            | URL capture service is deferred                                      |
| Path traversal                     | Git drafts                    | normalized relative Markdown paths, allowlisted prefix and isolated worktrees                            | Windows device/symlink matrix should expand                          |
| Review escape                      | concurrent drafts             | per-review worktrees, publication lock, optimistic base and regression test                              | Git+DB use compensation, not a distributed transaction               |
| Mutable raw substitution           | worker/object store/extractor | content-addressed MinIO key; worker rehash; authenticated multipart; extractor verifies expected SHA-256 | privileged MinIO credentials can delete objects; Object Lock absent  |
| Extractor impersonation            | worker/extractor              | shared secret header, loopback bind, bounded upload and hash check                                       | shared secret is not mTLS or per-job identity                        |
| Oversized upload/temp exhaustion   | extractor                     | configured maximum bytes, chunked streaming and temporary-file cleanup                                   | concurrent-volume quotas are not implemented                         |
| Default credential                 | authentication                | bootstrap credential revoked; provisioning requires strong non-default value                             | local secret rotation remains operator responsibility                |
| Session theft/CSRF                 | Web/API                       | random opaque session, hashes at rest, HttpOnly/SameSite cookie, expiry, revocation, CSRF header         | no OIDC/MFA/device assurance; XSS defenses still require maintenance |
| Malformed identifier/error leakage | API/DB                        | UUID validation returns structured HTTP 400 without database detail                                      | 26-case integration evidence recorded; rerun after security changes  |
| Prompt injection/malicious HTML    | extracted content/Web         | extracted material has no publish authority; HTML scripts removed; React escaping; human review          | adversarial corpus is small; indirect prompt injection evolves       |
| Secret commit                      | repository                    | ignored `.env`/backups/private reports and deterministic CI secret scan                                  | heuristic scanner is not managed DLP                                 |
| Backup disclosure/corruption       | operations                    | secrets excluded; per-file SHA-256; isolated restore smoke                                               | backups are not encrypted, WORM or remotely replicated               |
| Dependency/image drift             | supply chain                  | lockfile, frozen install, audit/peer gates and pinned container evidence                                 | Python dependencies and all CI actions are not fully hash/SHA pinned |
| Audit tampering                    | API/DB                        | scoped viewer and mutation audit events                                                                  | append-only behavior depends on database-role discipline             |

All services bind to `127.0.0.1` by default. Tokens are never accepted in query
strings. The platform is not approved for direct internet or hostile
multi-tenant exposure without RLS, managed identity/secrets, encrypted
recovery, stronger extractor identity and a larger adversarial test program.
