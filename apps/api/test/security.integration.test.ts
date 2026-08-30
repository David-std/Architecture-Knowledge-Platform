import { mkdtemp, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Postgres, claimNextIngestJob } from "@akp/postgres";
import type { FastifyInstance } from "fastify";

const defaultSpace = "00000000-0000-0000-0000-000000000003";
const secondSpace = "00000000-0000-0000-0000-000000000099";
const admin = "00000000-0000-0000-0000-000000000002";
const integrationToken = `akp-security-integration-${randomUUID()}`;
const integrationTokenHash = createHash("sha256")
  .update(integrationToken)
  .digest("hex");
const headers = { authorization: `Bearer ${integrationToken}` };

let app: FastifyInstance;
let db: Postgres;
let allowedRoot: string;
let defaultVaultId: string;
let secondVaultId: string;

beforeAll(async () => {
  if (!process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required for integration tests.");
  allowedRoot = await mkdtemp(path.join(tmpdir(), "akp-ingest-allowed-"));
  process.env.AKP_INGEST_ROOTS = allowedRoot;
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `
    insert into spaces(id,organization_id,slug,name,visibility,knowledge_repo_path)
    values($1,'00000000-0000-0000-0000-000000000001','security-fixture',
           'Security fixture','PRIVATE','')
    on conflict(id) do nothing
    `,
    [secondSpace],
  );
  await db.pool.query(
    `
    insert into memberships(user_id,space_id,role,path_prefix)
    values($1,$2,'VIEWER','shared')
    on conflict do nothing
    `,
    [admin, secondSpace],
  );
  const defaultVault = await db.pool.query<{ id: string }>(
    "select id from vaults where space_id=$1 and enabled=true order by created_at limit 1",
    [defaultSpace],
  );
  if (!defaultVault.rows[0]) {
    const vaultId = randomUUID();
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
      [
        vaultId,
        defaultSpace,
        path.join(allowedRoot, "canonical-vault"),
        "Security integration vault",
        "fixture:initial",
        `security-fixture-${vaultId.slice(0, 8)}`,
      ],
    );
    defaultVaultId = vaultId;
  } else {
    defaultVaultId = defaultVault.rows[0].id;
  }
  const secondVault = await db.pool.query<{ id: string }>(
    "select id from vaults where space_id=$1 and enabled=true order by created_at limit 1",
    [secondSpace],
  );
  if (secondVault.rows[0]) {
    secondVaultId = secondVault.rows[0].id;
  } else {
    secondVaultId = randomUUID();
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
      [
        secondVaultId,
        secondSpace,
        path.join(allowedRoot, "second-canonical-vault"),
        "Second security integration vault",
        "fixture:initial",
        `security-second-${secondVaultId.slice(0, 8)}`,
      ],
    );
  }
  // Fresh migration 013 has no vault rows to inherit space memberships from.
  // Register explicit fixture grants so reindex reaches its confirmation
  // contract instead of failing at the vault authorization boundary.
  await db.pool.query(
    `
    insert into vault_memberships(user_id,vault_id,role,path_prefix,permissions)
    values($1,$2,'ADMIN',null,
           '["knowledge:read","source:read","source:write",
             "knowledge:propose","knowledge:review","eval:run","admin"]'::jsonb)
    on conflict(user_id,vault_id,role,path_prefix) do update
      set permissions=excluded.permissions,enabled=true
    `,
    [admin, defaultVaultId],
  );
  await db.pool.query(
    `
    insert into vault_memberships(user_id,vault_id,role,path_prefix,permissions)
    values($1,$2,'VIEWER','shared','["knowledge:read","source:read"]'::jsonb)
    on conflict(user_id,vault_id,role,path_prefix) do update
      set permissions=excluded.permissions,enabled=true
    `,
    [admin, secondVaultId],
  );
  await db.pool.query(
    `
    insert into api_tokens(user_id,token_hash,label,scopes)
    values($1,$2,'security integration',$3::jsonb)
    `,
    [
      admin,
      integrationTokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId: defaultSpace,
            pathPrefix: null,
            permissions: [
              "knowledge:read",
              "source:read",
              "source:write",
              "knowledge:propose",
              "knowledge:review",
              "eval:run",
              "admin",
            ],
          },
        ],
      }),
    ],
  );
  // Keep the fresh-DB projection assertion meaningful: one canonical
  // managed document must produce at least one structural unit.
  await db.pool.query(
    `
    insert into knowledge_documents(
      space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
      current_revision,body_cache,frontmatter,aliases,raw_links
    ) values($1,$2,'managed/security-fixture.md','SECURITY-FIXTURE',
             'Security fixture','note','ACTIVE','CURATED','fixture:initial',
             '# Security fixture\n\nA projection fixture.',
             '{"id":"SECURITY-FIXTURE","title":"Security fixture"}'::jsonb,
             '{}','[]')
    on conflict(vault_id,path) where vault_id is not null do update set
      lifecycle='ACTIVE',current_revision=excluded.current_revision,
      body_cache=excluded.body_cache,frontmatter=excluded.frontmatter,
      raw_links=excluded.raw_links
    `,
    [defaultSpace, defaultVaultId],
  );
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      integrationTokenHash,
    ]);
    await db.close();
  }
});

describe("API security boundaries", () => {
  it("rejects missing and invalid tokens", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/v1/status" })).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/v1/status",
          headers: { authorization: "Bearer invalid" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("returns a client error instead of leaking malformed database identifiers", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/ingest/not-a-uuid",
      headers,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "INVALID_IDENTIFIER" });
  });

  it("does not project ADMIN from one space into a VIEWER membership", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers,
      payload: {
        spaceId: secondSpace,
        vaultId: secondVaultId,
        summary: "must be denied",
        changes: [
          {
            path: "shared/denied.md",
            content: "---\nid: TEST-DENIED\ntype: note\n---\nDenied",
          },
        ],
      },
    });
    expect(response.statusCode).toBe(403);
  });

  it("enforces private-vault grants and their effective path prefix for proposals and reviews", async () => {
    const suffix = randomUUID();
    const vaultId = randomUUID();
    const vaultKey = `scope-boundary-${vaultId.slice(0, 8)}`;
    const reviewId = randomUUID();
    await db.pool.query(
      `
      insert into vaults(
        id,space_id,canonical_path,name,read_only,current_revision,
        vault_key,local_path,visibility,enabled
      ) values($1,$2,$3,'Private scope boundary fixture',true,'fixture:scope',$4,$3,'PRIVATE',true)
      `,
      [
        vaultId,
        defaultSpace,
        path.join(allowedRoot, `scope-${suffix}`),
        vaultKey,
      ],
    );
    try {
      const withoutGrant = await app.inject({
        method: "POST",
        url: "/v1/proposals",
        headers,
        payload: {
          spaceId: defaultSpace,
          vaultId,
          changes: [
            {
              path: "public/no-grant.md",
              content: "---\nid: NO-GRANT\ntype: note\n---\nDenied",
            },
          ],
        },
      });
      expect(withoutGrant.statusCode).toBe(403);
      expect(withoutGrant.json().code).toBe("VAULT_ACCESS_DENIED");

      await db.pool.query(
        `
        insert into vault_memberships(user_id,vault_id,role,path_prefix,permissions)
        values($1,$2,'ADMIN','public',
          '["knowledge:read","source:read","source:write",
            "knowledge:propose","knowledge:review","eval:run","admin"]'::jsonb)
        `,
        [admin, vaultId],
      );
      const outsidePrefix = await app.inject({
        method: "POST",
        url: "/v1/proposals",
        headers,
        payload: {
          spaceId: defaultSpace,
          vaultId,
          changes: [
            {
              path: "private/outside-prefix.md",
              content: "---\nid: OUTSIDE-PREFIX\ntype: note\n---\nDenied",
            },
          ],
        },
      });
      expect(outsidePrefix.statusCode).toBe(403);
      expect(outsidePrefix.json().code).toBe("PATH_SCOPE_DENIED");

      const pathScopedReindex = await app.inject({
        method: "POST",
        url: "/v1/reindex",
        headers,
        payload: {
          spaceId: defaultSpace,
          vaultId,
          confirm: "REBUILD_DERIVED_PROJECTIONS",
        },
      });
      expect(pathScopedReindex.statusCode).toBe(403);
      expect(pathScopedReindex.json().code).toBe("PATH_SCOPE_DENIED");

      await db.pool.query(
        `
        insert into reviews(
          id,space_id,vault_id,branch_name,base_commit,head_commit,status,
          author_id,impact_manifest,validation_report
        ) values($1,$2,$3,'scope-review-branch','base','head','PENDING',$4,$5::jsonb,$6::jsonb)
        `,
        [
          reviewId,
          defaultSpace,
          vaultId,
          admin,
          JSON.stringify({
            proposedChanges: [{ path: "public/review.md" }],
          }),
          JSON.stringify({}),
        ],
      );
      await db.pool.query(
        "update vault_memberships set enabled=false where user_id=$1 and vault_id=$2",
        [admin, vaultId],
      );
      const reviewerWithoutGrant = await app.inject({
        method: "POST",
        url: `/v1/reviews/${reviewId}/decision`,
        headers,
        payload: { decision: "APPROVE", reason: "must be denied" },
      });
      expect(reviewerWithoutGrant.statusCode).toBe(403);
      expect(reviewerWithoutGrant.json().code).toBe("PATH_SCOPE_DENIED");
    } finally {
      await db.pool.query("delete from review_comments where review_id=$1", [
        reviewId,
      ]);
      await db.pool.query("delete from reviews where id=$1", [reviewId]);
      await db.pool.query("delete from vault_memberships where vault_id=$1", [
        vaultId,
      ]);
      await db.pool.query("delete from vaults where id=$1", [vaultId]);
    }
  });

  it("intersects explicit API-token scopes with current memberships and path prefixes", async () => {
    const suffix = randomUUID();
    const token = `akp-limited-${suffix}`;
    const allowedId = `E2E-SCOPE-ALLOWED-${suffix}`;
    const deniedId = `E2E-SCOPE-DENIED-${suffix}`;
    const documentIds = [randomUUID(), randomUUID()];
    const hash = createHash("sha256").update(token).digest("hex");
    await db.pool.query(
      `
      insert into api_tokens(user_id,token_hash,label,scopes)
      values($1,$2,'limited integration token',$3::jsonb)
      `,
      [
        admin,
        hash,
        JSON.stringify({
          spaces: [
            {
              spaceId: defaultSpace,
              pathPrefix: "shared",
              permissions: ["knowledge:read"],
            },
          ],
        }),
      ],
    );
    await db.pool.query(
      `
      insert into knowledge_documents(
        id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,current_revision,
        body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
      ) values
        ($1,$3,$10,$4,$5,'Permitted document','note','ACTIVE','HUMAN_REVIEWED','scope-test',
         'Permitted content.','{}'::jsonb,'{}','concept',$6,10,'[]'::jsonb),
        ($2,$3,$10,$7,$8,'Private document','note','ACTIVE','HUMAN_REVIEWED','scope-test',
         'Private content.','{}'::jsonb,'{}','concept',$9,10,'[]'::jsonb)
      `,
      [
        documentIds[0],
        documentIds[1],
        defaultSpace,
        `shared/allowed-${suffix}.md`,
        allowedId,
        suffix.replaceAll("-", "").padEnd(64, "a").slice(0, 64),
        `private/denied-${suffix}.md`,
        deniedId,
        suffix.replaceAll("-", "").padEnd(64, "b").slice(0, 64),
        defaultVaultId,
      ],
    );
    const limitedHeaders = { authorization: `Bearer ${token}` };
    try {
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/documents/${encodeURIComponent(allowedId)}`,
            headers: limitedHeaders,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/documents/${encodeURIComponent(deniedId)}`,
            headers: limitedHeaders,
          })
        ).statusCode,
      ).toBe(404);
      const deniedSearch = await app.inject({
        method: "POST",
        url: "/v1/search",
        headers: limitedHeaders,
        payload: {
          query: deniedId,
          spaceId: defaultSpace,
          vaultId: defaultVaultId,
          types: [],
          minimumTrust: "UNVERIFIED",
          mode: "COMPILED_ONLY",
          limit: 10,
        },
      });
      expect(deniedSearch.statusCode).toBe(200);
      expect(deniedSearch.json().hits).toHaveLength(0);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/sources",
            headers: limitedHeaders,
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      await db.pool.query("delete from api_tokens where token_hash=$1", [hash]);
      await db.pool.query(
        "delete from knowledge_documents where id=any($1::uuid[])",
        [documentIds],
      );
    }
  });

  it("preserves a narrow token scope when it is exchanged for a web session", async () => {
    const suffix = randomUUID();
    const token = `akp-session-scope-${suffix}`;
    const hash = createHash("sha256").update(token).digest("hex");
    const allowedId = `E2E-SESSION-ALLOWED-${suffix}`;
    const deniedId = `E2E-SESSION-DENIED-${suffix}`;
    const documentIds = [randomUUID(), randomUUID()];
    await db.pool.query(
      `
      insert into api_tokens(user_id,token_hash,label,scopes)
      values($1,$2,'limited session integration token',$3::jsonb)
      `,
      [
        admin,
        hash,
        JSON.stringify({
          spaces: [
            {
              spaceId: defaultSpace,
              pathPrefix: "shared",
              permissions: ["knowledge:read"],
            },
          ],
        }),
      ],
    );
    await db.pool.query(
      `
      insert into knowledge_documents(
        id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,current_revision,
        body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
      ) values
        ($1,$3,$10,$4,$5,'Session allowed document','note','ACTIVE','HUMAN_REVIEWED','scope-test',
         'Allowed through session.','{}'::jsonb,'{}','concept',$6,10,'[]'::jsonb),
        ($2,$3,$10,$7,$8,'Session private document','note','ACTIVE','HUMAN_REVIEWED','scope-test',
         'Denied through session.','{}'::jsonb,'{}','concept',$9,10,'[]'::jsonb)
      `,
      [
        documentIds[0],
        documentIds[1],
        defaultSpace,
        `shared/session-allowed-${suffix}.md`,
        allowedId,
        suffix.replaceAll("-", "").padEnd(64, "c").slice(0, 64),
        `private/session-denied-${suffix}.md`,
        deniedId,
        suffix.replaceAll("-", "").padEnd(64, "d").slice(0, 64),
        defaultVaultId,
      ],
    );
    let sessionId: string | undefined;
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/auth/session",
        headers: { authorization: `Bearer ${token}` },
        payload: { durationMinutes: 10 },
      });
      expect(created.statusCode).toBe(201);
      sessionId = created.json().id as string;
      const cookieLines = Array.isArray(created.headers["set-cookie"])
        ? created.headers["set-cookie"]
        : [String(created.headers["set-cookie"])];
      const sessionPair = cookieLines
        .map((line) => line.split(";", 1)[0])
        .find((line) => line?.startsWith("akp_session="));
      expect(sessionPair).toBeTruthy();
      const sessionHeaders = {
        cookie: String(sessionPair),
        "x-csrf-token": created.json().csrfToken as string,
      };
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/documents/${encodeURIComponent(allowedId)}`,
            headers: sessionHeaders,
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/v1/documents/${encodeURIComponent(deniedId)}`,
            headers: sessionHeaders,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/status",
            headers: sessionHeaders,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: sessionHeaders,
            payload: {
              purpose: "must not create whole-space session",
              spaceId: defaultSpace,
              vaultId: defaultVaultId,
            },
          })
        ).statusCode,
      ).toBe(403);
    } finally {
      if (sessionId)
        await db.pool.query("delete from web_sessions where id=$1", [
          sessionId,
        ]);
      await db.pool.query("delete from api_tokens where token_hash=$1", [hash]);
      await db.pool.query(
        "delete from knowledge_documents where id=any($1::uuid[])",
        [documentIds],
      );
    }
  });

  it("fails closed for malformed path scopes instead of treating them as whole-space", async () => {
    const token = `akp-malformed-scope-${randomUUID()}`;
    const hash = createHash("sha256").update(token).digest("hex");
    await db.pool.query(
      "insert into api_tokens(user_id,token_hash,label,scopes) values($1,$2,'malformed scope',$3::jsonb)",
      [
        admin,
        hash,
        JSON.stringify({
          spaces: [
            {
              spaceId: defaultSpace,
              pathPrefix: "/",
              permissions: ["knowledge:read"],
            },
          ],
        }),
      ],
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/status",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("PERMISSION_DENIED");
    } finally {
      await db.pool.query("delete from api_tokens where token_hash=$1", [hash]);
    }
  });

  it("partitions idempotency by concrete credential scope and concrete resource URL", async () => {
    const suffix = randomUUID();
    const limitedToken = `akp-idempotency-limited-${suffix}`;
    const limitedHash = createHash("sha256").update(limitedToken).digest("hex");
    const key = `credential-scope-${suffix}`;
    await db.pool.query(
      "insert into api_tokens(user_id,token_hash,label,scopes) values($1,$2,'idempotency limited',$3::jsonb)",
      [
        admin,
        limitedHash,
        JSON.stringify({
          spaces: [
            {
              spaceId: defaultSpace,
              pathPrefix: "shared",
              permissions: ["knowledge:read"],
            },
          ],
        }),
      ],
    );
    const payload = {
      purpose: `credential partition ${suffix}`,
      contextBudget: 512,
      spaceId: defaultSpace,
      vaultId: defaultVaultId,
    };
    try {
      const broad = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: { ...headers, "idempotency-key": key },
        payload,
      });
      expect(broad.statusCode).toBe(201);
      const restricted = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: {
          authorization: `Bearer ${limitedToken}`,
          "idempotency-key": key,
        },
        payload,
      });
      expect(restricted.statusCode).toBe(403);
      expect(restricted.json().code).toBe("PATH_SCOPE_DENIED");
      await db.pool.query("delete from agent_sessions where id=$1", [
        broad.json().id,
      ]);

      const errors = [randomUUID(), randomUUID()];
      await db.pool.query(
        "insert into error_book(id,space_id,vault_id,error_type,root_cause) values($1,$3,$4,'RETRIEVAL_FAILURE','first'),($2,$3,$4,'RETRIEVAL_FAILURE','second')",
        [errors[0], errors[1], defaultSpace, defaultVaultId],
      );
      const routeKey = `concrete-url-${suffix}`;
      const resolution = {
        verificationResult: "Same body, distinct resource.",
      };
      const first = await app.inject({
        method: "POST",
        url: `/v1/error-book/${errors[0]}/resolve`,
        headers: { ...headers, "idempotency-key": routeKey },
        payload: resolution,
      });
      const second = await app.inject({
        method: "POST",
        url: `/v1/error-book/${errors[1]}/resolve`,
        headers: { ...headers, "idempotency-key": routeKey },
        payload: resolution,
      });
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      const resolved = await db.pool.query(
        "select count(*)::int count from error_book where id=any($1::uuid[]) and status='RESOLVED'",
        [errors],
      );
      expect(resolved.rows[0]?.count).toBe(2);
      await db.pool.query("delete from error_book where id=any($1::uuid[])", [
        errors,
      ]);
      await db.pool.query(
        "delete from idempotency_records where idempotency_key=any($1::text[])",
        [[key, routeKey]],
      );
    } finally {
      await db.pool.query("delete from agent_sessions where purpose=$1", [
        payload.purpose,
      ]);
      await db.pool.query("delete from api_tokens where token_hash=$1", [
        limitedHash,
      ]);
      await db.pool.query(
        "delete from idempotency_records where idempotency_key=any($1::text[])",
        [[key]],
      );
    }
  });

  it("marks an expired idempotency lease abandoned rather than replaying an uncertain write", async () => {
    const key = `expired-lease-${randomUUID()}`;
    const payload = {
      purpose: `expired idempotency fixture ${randomUUID()}`,
      spaceId: defaultSpace,
      vaultId: defaultVaultId,
    };
    try {
      const initial = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: { ...headers, "idempotency-key": key },
        payload,
      });
      expect(initial.statusCode).toBe(201);
      await db.pool.query(
        `
        update idempotency_records
           set state='IN_PROGRESS',response=null,response_status=0,
               lease_owner='interrupted-worker',lease_expires_at=now()-interval '1 minute'
         where idempotency_key=$1
        `,
        [key],
      );
      const retried = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: { ...headers, "idempotency-key": key },
        payload,
      });
      expect(retried.statusCode).toBe(409);
      expect(retried.json().code).toBe(
        "IDEMPOTENCY_LEASE_EXPIRED_REQUIRES_RECOVERY",
      );
      const state = await db.pool.query(
        "select state from idempotency_records where idempotency_key=$1",
        [key],
      );
      expect(state.rows[0]?.state).toBe("ABANDONED");
      await db.pool.query("delete from agent_sessions where id=$1", [
        initial.json().id,
      ]);
    } finally {
      await db.pool.query("delete from agent_sessions where purpose=$1", [
        payload.purpose,
      ]);
      await db.pool.query(
        "delete from idempotency_records where idempotency_key=$1",
        [key],
      );
    }
  });

  it("rejects traversal, remote URLs, and local files outside configured ingest roots", async () => {
    const traversal = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers,
      payload: {
        spaceId: defaultSpace,
        vaultId: defaultVaultId,
        summary: "traversal fixture",
        changes: [{ path: "../secret.md", content: "unsafe" }],
      },
    });
    expect(traversal.statusCode).toBe(400);

    const outside = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers,
      payload: {
        spaceId: defaultSpace,
        vaultId: defaultVaultId,
        sourceUri: path.resolve("README.md"),
        policy: "REVIEW_REQUIRED",
      },
    });
    expect(outside.statusCode).toBe(403);

    const remote = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers,
      payload: {
        spaceId: defaultSpace,
        vaultId: defaultVaultId,
        sourceUri: "http://127.0.0.1:19000/minio/health/live",
        policy: "REVIEW_REQUIRED",
      },
    });
    expect(remote.statusCode).toBe(403);
    expect(remote.json()).toMatchObject({ code: "SOURCE_PATH_NOT_ALLOWED" });
  });

  it("deduplicates write retries by idempotency key", async () => {
    const source = path.join(allowedRoot, "fixture.md");
    const idempotencyKey = `integration-idempotency-${randomUUID()}`;
    await writeFile(source, "# Fixture", "utf8");
    const payload = {
      spaceId: defaultSpace,
      vaultId: defaultVaultId,
      sourceUri: source,
      policy: "REVIEW_REQUIRED",
      idempotencyKey,
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers,
      payload,
    });
    const second = await app.inject({
      method: "POST",
      url: "/v1/ingest",
      headers,
      payload,
    });
    expect(first.statusCode).toBe(202);
    expect(second.statusCode).toBe(202);
    expect(second.json().jobId).toBe(first.json().jobId);
    await db.pool.query(
      "delete from idempotency_records where actor_id=$1 and operation='POST /v1/ingest' and idempotency_key=$2",
      [admin, idempotencyKey],
    );
    await db.pool.query("delete from ingest_jobs where id=$1", [
      first.json().jobId,
    ]);
  });

  it("redacts raw source paths and object keys from job/source reads", async () => {
    const suffix = randomUUID();
    const sourceId = randomUUID();
    const jobId = randomUUID();
    const sourcePath = path.join(allowedRoot, `raw-${suffix}.pdf`);
    const objectKey = `sha256/${suffix}/raw.pdf`;
    const sourceHash = suffix.replaceAll("-", "").padEnd(64, "a").slice(0, 64);
    await db.pool.query(
      `
      insert into sources(
        id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
        object_key,status,metadata
      ) values($1,$2,$3,$4,$5,'application/pdf',$6,11,$7,'ACTIVE',$8::jsonb)
      `,
      [
        sourceId,
        defaultSpace,
        defaultVaultId,
        `Raw boundary fixture ${suffix}`,
        sourcePath,
        sourceHash,
        objectKey,
        JSON.stringify({ sourceUri: sourcePath, objectKey }),
      ],
    );
    await db.pool.query(
      `
      insert into ingest_jobs(
        id,space_id,vault_id,source_uri,state,payload,stage_outputs,created_by
      ) values($1,$2,$3,$4,'RECEIVED',$5::jsonb,$6::jsonb,$7)
      `,
      [
        jobId,
        defaultSpace,
        defaultVaultId,
        sourcePath,
        JSON.stringify({
          sourceUri: sourcePath,
          nested: { source_path: sourcePath },
        }),
        JSON.stringify({ raw: { key: objectKey, sourceUri: sourcePath } }),
        admin,
      ],
    );
    await db.pool.query(
      `insert into ingest_job_events(job_id,state,event_type,payload)
       values($1,'RECEIVED','SUBMITTED',$2::jsonb)`,
      [jobId, JSON.stringify({ sourceUri: sourcePath, object_key: objectKey })],
    );
    try {
      const jobs = await app.inject({
        method: "GET",
        url: "/v1/ingest",
        headers,
      });
      expect(jobs.statusCode).toBe(200);
      const listedJob = (
        jobs.json().jobs as Array<Record<string, unknown>>
      ).find((row) => row.id === jobId);
      expect(listedJob).toBeTruthy();
      expect(listedJob).not.toHaveProperty("source_uri");
      expect(JSON.stringify(listedJob)).not.toContain(sourcePath);

      const detail = await app.inject({
        method: "GET",
        url: `/v1/ingest/${jobId}`,
        headers,
      });
      expect(detail.statusCode).toBe(200);
      expect(JSON.stringify(detail.json())).not.toContain(sourcePath);
      expect(JSON.stringify(detail.json())).not.toContain(objectKey);
      expect(detail.json().events[0].payload).not.toHaveProperty("sourceUri");

      const sources = await app.inject({
        method: "GET",
        url: "/v1/sources",
        headers,
      });
      expect(sources.statusCode).toBe(200);
      const listedSource = (
        sources.json().sources as Array<Record<string, unknown>>
      ).find((row) => row.id === sourceId);
      expect(listedSource).toBeTruthy();
      expect(listedSource).not.toHaveProperty("source_uri");
      expect(JSON.stringify(listedSource)).not.toContain(sourcePath);
      expect(JSON.stringify(listedSource)).not.toContain(objectKey);

      const source = await app.inject({
        method: "GET",
        url: `/v1/sources/${sourceId}`,
        headers,
      });
      expect(source.statusCode).toBe(200);
      expect(source.json()).not.toHaveProperty("source_uri");
      expect(source.json()).not.toHaveProperty("object_key");
      expect(JSON.stringify(source.json())).not.toContain(sourcePath);
      expect(JSON.stringify(source.json())).not.toContain(objectKey);

      const vaultPath = (
        await db.pool.query<{ local_path: string }>(
          "select local_path from vaults where id=$1",
          [defaultVaultId],
        )
      ).rows[0]?.local_path;
      expect(vaultPath).toBeTruthy();

      const status = await app.inject({
        method: "GET",
        url: "/v1/status",
        headers,
      });
      expect(status.statusCode).toBe(200);
      expect(JSON.stringify(status.json())).not.toContain(vaultPath!);

      const vaults = await app.inject({
        method: "GET",
        url: "/v1/vaults",
        headers,
      });
      expect(vaults.statusCode).toBe(200);
      expect(JSON.stringify(vaults.json())).not.toContain(vaultPath!);
    } finally {
      await db.pool.query("delete from ingest_job_events where job_id=$1", [
        jobId,
      ]);
      await db.pool.query("delete from ingest_jobs where id=$1", [jobId]);
      await db.pool.query("delete from sources where id=$1", [sourceId]);
    }
  });

  it("replays generic POST operations only for an identical request", async () => {
    const key = `session-${randomUUID()}`;
    const requestHeaders = { ...headers, "idempotency-key": key };
    const payload = {
      purpose: "generic idempotency integration fixture",
      contextBudget: 512,
      spaceId: defaultSpace,
      vaultId: defaultVaultId,
    };
    const first = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: requestHeaders,
      payload,
    });
    const replay = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: requestHeaders,
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);

    const conflict = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: requestHeaders,
      payload: { ...payload, purpose: "different request" },
    });
    expect(conflict.statusCode).toBe(409);
    await db.pool.query("delete from agent_sessions where id=$1", [
      first.json().id,
    ]);
  });

  it("does not replay a write after the vault grant used by the original request is revoked", async () => {
    const key = `vault-revocation-${randomUUID()}`;
    const purpose = `vault revocation fixture ${randomUUID()}`;
    const payload = {
      purpose,
      contextBudget: 512,
      spaceId: defaultSpace,
      vaultId: defaultVaultId,
    };
    try {
      const first = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: { ...headers, "idempotency-key": key },
        payload,
      });
      expect(first.statusCode).toBe(201);
      const revoked = await db.pool.query(
        `update vault_memberships
            set enabled=false
          where user_id=$1 and vault_id=$2
          returning id`,
        [admin, defaultVaultId],
      );
      expect(revoked.rowCount).toBeGreaterThan(0);
      const replay = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: { ...headers, "idempotency-key": key },
        payload,
      });
      expect(replay.statusCode).toBe(403);
      expect(replay.json().code).not.toBeUndefined();
      await db.pool.query("delete from agent_sessions where id=$1", [
        first.json().id,
      ]);
    } finally {
      await db.pool.query(
        "update vault_memberships set enabled=true where user_id=$1 and vault_id=$2",
        [admin, defaultVaultId],
      );
      await db.pool.query("delete from agent_sessions where purpose=$1", [
        purpose,
      ]);
      await db.pool.query(
        "delete from idempotency_records where idempotency_key=$1",
        [key],
      );
    }
  });

  it("rechecks inherited vault visibility and enabled state before idempotent replay", async () => {
    const vaultId = randomUUID();
    const key = `vault-state-${randomUUID()}`;
    const purpose = `vault state fixture ${randomUUID()}`;
    const vaultKey = `state-fixture-${vaultId.slice(0, 8)}`;
    const vaultPath = path.join(allowedRoot, vaultKey);
    const payload = {
      purpose,
      contextBudget: 512,
      spaceId: defaultSpace,
      vaultId,
    };
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,'Idempotency state fixture',true,'fixture:state',
                $4,$3,'TEAM',true)`,
      [vaultId, defaultSpace, vaultPath, vaultKey],
    );
    try {
      const first = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: { ...headers, "idempotency-key": key },
        payload,
      });
      expect(first.statusCode).toBe(201);

      await db.pool.query(
        "update vaults set visibility='PRIVATE' where id=$1",
        [vaultId],
      );
      const privateReplay = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: { ...headers, "idempotency-key": key },
        payload,
      });
      expect(privateReplay.statusCode).toBe(403);

      await db.pool.query(
        "update vaults set visibility='TEAM',enabled=false where id=$1",
        [vaultId],
      );
      const disabledReplay = await app.inject({
        method: "POST",
        url: "/v1/sessions",
        headers: { ...headers, "idempotency-key": key },
        payload,
      });
      expect(disabledReplay.statusCode).toBe(403);
    } finally {
      await db.pool.query("delete from agent_sessions where purpose=$1", [
        purpose,
      ]);
      await db.pool.query("delete from audit_events where vault_id=$1", [
        vaultId,
      ]);
      await db.pool.query(
        "delete from idempotency_records where idempotency_key=$1",
        [key],
      );
      await db.pool.query("delete from vaults where id=$1", [vaultId]);
    }
  });

  it("claims a generic idempotency key before concurrent handlers can mutate twice", async () => {
    const key = `concurrent-${randomUUID()}`;
    const purpose = `concurrent idempotency fixture ${randomUUID()}`;
    const requestHeaders = { ...headers, "idempotency-key": key };
    const payload = {
      purpose,
      contextBudget: 512,
      spaceId: defaultSpace,
      vaultId: defaultVaultId,
    };
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: "POST",
          url: "/v1/sessions",
          headers: requestHeaders,
          payload,
        }),
      ),
    );
    expect(
      responses.every((response) => [201, 425].includes(response.statusCode)),
    ).toBe(true);
    const persisted = await db.pool.query(
      "select id from agent_sessions where purpose=$1",
      [purpose],
    );
    expect(persisted.rowCount).toBe(1);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: requestHeaders,
      payload,
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(String(persisted.rows[0]?.id));
    await db.pool.query("delete from agent_sessions where purpose=$1", [
      purpose,
    ]);
    await db.pool.query(
      "delete from idempotency_records where actor_id=$1 and operation='POST /v1/sessions' and idempotency_key=$2",
      [admin, key],
    );
  });

  it("propagates staleness and closes explicit contradiction clusters", async () => {
    const suffix = randomUUID();
    const sourceId = randomUUID();
    const dependentId = randomUUID();
    await db.pool.query(
      `
      insert into knowledge_documents(
        id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,current_revision,
        body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
      ) values
        ($1,$3,$10,$4,$5,'Governance source fixture','claim','ACTIVE','HUMAN_REVIEWED',
         'integration-fixture','A controlled source statement.','{}'::jsonb,'{}','claim',$6,10,'[]'::jsonb),
        ($2,$3,$10,$7,$8,'Governance dependent fixture','rule','ACTIVE','HUMAN_REVIEWED',
         'integration-fixture','A controlled downstream rule.','{}'::jsonb,'{}','rule',$9,10,'[]'::jsonb)
      `,
      [
        sourceId,
        dependentId,
        defaultSpace,
        `managed/test/governance-source-${suffix}.md`,
        `E2E-GOVERNANCE-SOURCE-${suffix}`,
        suffix.padEnd(64, "0").slice(0, 64),
        `managed/test/governance-dependent-${suffix}.md`,
        `E2E-GOVERNANCE-DEPENDENT-${suffix}`,
        suffix.replaceAll("-", "").padEnd(64, "1").slice(0, 64),
        defaultVaultId,
      ],
    );
    await db.pool.query(
      `
      insert into knowledge_relations(
        space_id,from_document_id,to_document_id,relation_type,provenance
      ) values($1,$2,$3,'requires','integration-test')
      `,
      [defaultSpace, dependentId, sourceId],
    );
    try {
      const invalidated = await app.inject({
        method: "POST",
        url: `/v1/knowledge/${sourceId}/invalidate`,
        headers,
        payload: { severity: "WARN", reason: "integration staleness fixture" },
      });
      expect(invalidated.statusCode).toBe(200);
      expect(invalidated.json().impacted).toHaveLength(2);
      const stale = await db.pool.query(
        "select id,refresh_status from knowledge_documents where id=any($1::uuid[])",
        [[sourceId, dependentId]],
      );
      expect(
        stale.rows.every(
          (row) => row.refresh_status === "STALE_PENDING_REVIEW",
        ),
      ).toBe(true);

      const created = await app.inject({
        method: "POST",
        url: "/v1/contradictions",
        headers,
        payload: {
          topic: "integration contradiction fixture",
          documentIds: [sourceId, dependentId],
          authority: "synthetic-test",
          scope: "integration",
        },
      });
      expect(created.statusCode).toBe(201);
      const clusterId = created.json().id as string;
      const resolved = await app.inject({
        method: "POST",
        url: `/v1/contradictions/${clusterId}/resolve`,
        headers,
        payload: {
          resolution: "Synthetic conflict closed by the integration test.",
          documentOutcomes: [
            { documentId: sourceId, lifecycle: "ACTIVE" },
            { documentId: dependentId, lifecycle: "SUPERSEDED" },
          ],
        },
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().status).toBe("RESOLVED");
      const final = await db.pool.query(
        "select id,lifecycle,refresh_status from knowledge_documents where id=any($1::uuid[])",
        [[sourceId, dependentId]],
      );
      expect(final.rows.find((row) => row.id === sourceId)).toMatchObject({
        lifecycle: "ACTIVE",
        refresh_status: "CURRENT",
      });
      expect(final.rows.find((row) => row.id === dependentId)).toMatchObject({
        lifecycle: "SUPERSEDED",
        refresh_status: "INVALID",
      });
    } finally {
      await db.pool.query(
        "delete from contradiction_clusters where space_id=$1 and topic='integration contradiction fixture'",
        [defaultSpace],
      );
      await db.pool.query(
        "delete from knowledge_relations where from_document_id=any($1::uuid[]) or to_document_id=any($1::uuid[])",
        [[sourceId, dependentId]],
      );
      await db.pool.query(
        "delete from knowledge_documents where id=any($1::uuid[])",
        [[sourceId, dependentId]],
      );
    }
  });

  it("reclaims an expired job lease after a worker restart", async () => {
    const jobId = randomUUID();
    await db.pool.query(
      `
      insert into ingest_jobs(
        id,space_id,source_uri,state,payload,lease_owner,lease_expires_at,heartbeat_at,created_at
      ) values($1,$2,$3,'HASHED','{}'::jsonb,'terminated-worker',now()-interval '1 minute',
               now()-interval '2 minutes',now()-interval '100 years')
      `,
      [jobId, defaultSpace, path.join(allowedRoot, "restart-fixture.md")],
    );
    try {
      const claimed = await claimNextIngestJob(db, "recovery-worker", 60);
      expect(claimed).toMatchObject({
        id: jobId,
        lease_owner: "recovery-worker",
      });
      const persisted = await db.pool.query(
        "select lease_owner,lease_expires_at > now() active from ingest_jobs where id=$1",
        [jobId],
      );
      expect(persisted.rows[0]).toMatchObject({
        lease_owner: "recovery-worker",
        active: true,
      });
    } finally {
      await db.pool.query("delete from ingest_jobs where id=$1", [jobId]);
    }
  });

  it("requires explicit confirmation and rebuilds only a scoped fixture vault", async () => {
    const vaultId = randomUUID();
    const documentId = randomUUID();
    const vaultKey = `reindex-fixture-${vaultId.slice(0, 8)}`;

    await db.pool.query(
      `
      insert into vaults(
        id,space_id,canonical_path,name,read_only,current_revision,
        vault_key,local_path,visibility,enabled
      ) values($1,$2,$3,'Reindex fixture vault',true,'fixture:reindex',$4,$3,'PRIVATE',true)
      `,
      [
        vaultId,
        defaultSpace,
        path.join(allowedRoot, `reindex-${vaultId}`),
        vaultKey,
      ],
    );
    await db.pool.query(
      `
      insert into vault_memberships(user_id,vault_id,role,path_prefix,permissions)
      values($1,$2,'ADMIN',null,
             '["knowledge:read","source:read","source:write",
               "knowledge:propose","knowledge:review","eval:run","admin"]'::jsonb)
      `,
      [admin, vaultId],
    );
    await db.pool.query(
      `
      insert into knowledge_documents(
        id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
        current_revision,body_cache,frontmatter,aliases,raw_links
      ) values($1,$2,$3,'managed/reindex-fixture.md','REINDEX-FIXTURE',
               'Reindex fixture','note','ACTIVE','CURATED','fixture:reindex',
               '# Reindex fixture\n\nA deliberately small projection fixture.',
               '{"id":"REINDEX-FIXTURE","title":"Reindex fixture"}'::jsonb,
               '{}'::text[],'[]'::jsonb)
      `,
      [documentId, defaultSpace, vaultId],
    );

    try {
      const missingVault = await app.inject({
        method: "POST",
        url: "/v1/reindex",
        headers,
        payload: { spaceId: defaultSpace },
      });
      expect(missingVault.statusCode).toBe(400);
      expect(missingVault.json()).toMatchObject({
        code: "REINDEX_VAULT_REQUIRED",
      });

      const missingConfirmation = await app.inject({
        method: "POST",
        url: "/v1/reindex",
        headers,
        payload: { spaceId: defaultSpace, vaultId },
      });
      expect(missingConfirmation.statusCode).toBe(409);
      expect(missingConfirmation.json()).toMatchObject({
        code: "REINDEX_CONFIRMATION_REQUIRED",
      });

      const rebuilt = await app.inject({
        method: "POST",
        url: "/v1/reindex",
        headers,
        payload: {
          spaceId: defaultSpace,
          vaultId,
          confirm: "REBUILD_DERIVED_PROJECTIONS",
        },
      });
      expect(rebuilt.statusCode, rebuilt.body).toBe(200);
      expect(rebuilt.json()).toMatchObject({
        status: "REBUILT_FROM_CURRENT_CANONICAL_REVISION",
      });
      expect(rebuilt.json().projection.unitCount).toBeGreaterThan(0);
    } finally {
      await db.pool.query(
        "delete from knowledge_relations where from_document_id=$1 or to_document_id=$1",
        [documentId],
      );
      await db.pool.query("delete from context_packets where vault_id=$1", [
        vaultId,
      ]);
      await db.pool.query("delete from knowledge_lint_runs where vault_id=$1", [
        vaultId,
      ]);
      await db.pool.query(
        "delete from incremental_index_runs where vault_id=$1",
        [vaultId],
      );
      await db.pool.query(
        "delete from vault_index_revisions where vault_id=$1",
        [vaultId],
      );
      await db.pool.query("delete from knowledge_units where vault_id=$1", [
        vaultId,
      ]);
      await db.pool.query(
        "delete from embedding_generations where vault_id=$1",
        [vaultId],
      );
      await db.pool.query(
        "delete from knowledge_versions where document_id=$1",
        [documentId],
      );
      await db.pool.query("delete from embeddings where document_id=$1", [
        documentId,
      ]);
      await db.pool.query("delete from knowledge_documents where id=$1", [
        documentId,
      ]);
      await db.pool.query("delete from audit_events where vault_id=$1", [
        vaultId,
      ]);
      await db.pool.query("delete from vault_memberships where vault_id=$1", [
        vaultId,
      ]);
      await db.pool.query("delete from vaults where id=$1", [vaultId]);
    }
  });

  it("retires a source and blocks every dependent document", async () => {
    const suffix = randomUUID();
    const sourceRecordId = randomUUID();
    const compiledId = randomUUID();
    const dependentId = randomUUID();
    const sourceHash = suffix.replaceAll("-", "").padEnd(64, "a").slice(0, 64);
    await db.pool.query(
      `
      insert into sources(id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,object_key)
      values($1,$2,$3,'Retirement fixture',$4,'text/markdown',$5,1,$6)
      `,
      [
        sourceRecordId,
        defaultSpace,
        defaultVaultId,
        `fixture://${suffix}`,
        sourceHash,
        `sha256/test/${sourceHash}`,
      ],
    );
    await db.pool.query(
      `
      insert into knowledge_documents(
        id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,current_revision,
        body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
      ) values
        ($1,$3,$4,$5,$6,'Compiled source fixture','source','ACTIVE','HUMAN_REVIEWED',
         'integration-fixture','Compiled source.',$7::jsonb,'{}','source',$8,10,'[]'::jsonb),
        ($2,$3,$4,$9,$10,'Dependent rule fixture','rule','ACTIVE','HUMAN_REVIEWED',
         'integration-fixture','Dependent rule.','{}'::jsonb,'{}','rule',$11,10,'[]'::jsonb)
      `,
      [
        compiledId,
        dependentId,
        defaultSpace,
        defaultVaultId,
        `managed/test/retirement-source-${suffix}.md`,
        `SRC-INGEST-${sourceHash.slice(0, 12).toUpperCase()}`,
        JSON.stringify({ source_sha256: sourceHash }),
        sourceHash,
        `managed/test/retirement-dependent-${suffix}.md`,
        `E2E-RETIREMENT-DEPENDENT-${suffix}`,
        sourceHash.split("").reverse().join(""),
      ],
    );
    await db.pool.query(
      `
      insert into knowledge_relations(
        space_id,from_document_id,to_document_id,relation_type,provenance
      ) values($1,$2,$3,'derives_from','integration-test')
      `,
      [defaultSpace, dependentId, compiledId],
    );
    try {
      const retired = await app.inject({
        method: "POST",
        url: `/v1/sources/${sourceRecordId}/retire`,
        headers,
        payload: { reason: "Controlled source-retirement integration test" },
      });
      expect(retired.statusCode).toBe(200);
      expect(retired.json().source.status).toBe("RETIRED");
      expect(retired.json().impacted).toHaveLength(2);
      const state = await db.pool.query(
        "select refresh_status from knowledge_documents where id=any($1::uuid[])",
        [[compiledId, dependentId]],
      );
      expect(
        state.rows.every((row) => row.refresh_status === "STALE_BLOCKED"),
      ).toBe(true);
    } finally {
      await db.pool.query(
        "delete from knowledge_relations where from_document_id=any($1::uuid[]) or to_document_id=any($1::uuid[])",
        [[compiledId, dependentId]],
      );
      await db.pool.query(
        "delete from knowledge_documents where id=any($1::uuid[])",
        [[compiledId, dependentId]],
      );
      await db.pool.query("delete from sources where id=$1", [sourceRecordId]);
    }
  });

  it("exchanges an authorized token for a revocable HttpOnly session with CSRF enforcement", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/auth/session",
      headers,
      payload: { durationMinutes: 10 },
    });
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id as string;
    const csrfToken = created.json().csrfToken as string;
    const setCookie = created.headers["set-cookie"];
    const cookieLines = Array.isArray(setCookie)
      ? setCookie
      : [String(setCookie)];
    const sessionPair = cookieLines
      .map((line) => line.split(";", 1)[0])
      .find((line) => line?.startsWith("akp_session="));
    expect(sessionPair).toBeTruthy();
    expect(cookieLines.join(";")).toContain("HttpOnly");

    const authenticated = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: String(sessionPair) },
    });
    expect(authenticated.statusCode).toBe(200);
    expect(authenticated.json().actor.authenticationKind).toBe("WEB_SESSION");

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { cookie: String(sessionPair) },
      payload: {
        purpose: "csrf must fail",
        spaceId: defaultSpace,
        vaultId: defaultVaultId,
      },
    });
    expect(missingCsrf.statusCode).toBe(403);
    expect(missingCsrf.json().code).toBe("CSRF_TOKEN_REQUIRED");

    const withCsrf = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers: { cookie: String(sessionPair), "x-csrf-token": csrfToken },
      payload: {
        purpose: "web session integration",
        contextBudget: 512,
        spaceId: defaultSpace,
        vaultId: defaultVaultId,
      },
    });
    expect(withCsrf.statusCode).toBe(201);
    await db.pool.query("delete from agent_sessions where id=$1", [
      withCsrf.json().id,
    ]);

    const revoked = await app.inject({
      method: "POST",
      url: "/v1/auth/session/revoke",
      headers: { cookie: String(sessionPair), "x-csrf-token": csrfToken },
      payload: {},
    });
    expect(revoked.statusCode).toBe(200);
    const afterRevoke = await app.inject({
      method: "GET",
      url: "/v1/auth/session",
      headers: { cookie: String(sessionPair) },
    });
    expect(afterRevoke.statusCode).toBe(401);
    await db.pool.query("delete from web_sessions where id=$1", [sessionId]);
  });

  it("dry-runs a candidate schema without mutating the canonical corpus", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/schema/dry-run",
      headers,
      payload: {
        spaceId: defaultSpace,
        vaultId: defaultVaultId,
        candidateVersion: `integration-${randomUUID()}`,
        requiredFrontmatterFields: ["id", "integration_required_field"],
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().compatibilityStatus).toBe("MIGRATION_REQUIRED");
    expect(response.json().affectedDocumentCount).toBeGreaterThan(0);
    expect(response.json().corpusUnchanged).toBe(true);
    expect(response.json().corpusFingerprintAfter).toBe(
      response.json().corpusFingerprintBefore,
    );
    await db.pool.query("delete from schema_dry_runs where id=$1", [
      response.json().id,
    ]);
  });

  it("turns an Error Book entry into an active regression eval and resolves it", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/error-book",
      headers,
      payload: {
        spaceId: defaultSpace,
        vaultId: defaultVaultId,
        errorType: "RETRIEVAL_FAILURE",
        rootCause: "Synthetic regression fixture",
        correction: "Require the expected CQRS dossier",
        metadata: {
          sourcePath: "C:\\Users\\fixture\\private.pdf",
          nested: {
            note: "/tmp/private-evidence.pdf",
            retainedId: "diagnostic-1",
          },
        },
      },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().metadata).toEqual({
      nested: {
        note: "[REDACTED_PATH]",
        retainedId: "diagnostic-1",
      },
    });
    const errorId = created.json().id as string;
    const regression = await app.inject({
      method: "POST",
      url: `/v1/error-book/${errorId}/regression`,
      headers,
      payload: {
        query: "¿Puede CQRS usar la misma base de datos?",
        goldDocuments: ["cqrs-capability-model"],
        critical: true,
      },
    });
    expect(regression.statusCode).toBe(201);
    const caseId = regression.json().caseId as string;
    const persisted = await db.pool.query(
      "select active,critical from eval_cases where id=$1",
      [caseId],
    );
    expect(persisted.rows[0]).toMatchObject({ active: true, critical: true });
    const resolved = await app.inject({
      method: "POST",
      url: `/v1/error-book/${errorId}/resolve`,
      headers,
      payload: {
        verificationResult: "Regression fixture created and verified.",
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().status).toBe("RESOLVED");
    await db.pool.query("delete from eval_cases where id=$1", [caseId]);
    await db.pool.query("delete from error_book where id=$1", [errorId]);
  });

  it("persists an executable scheduled lint report", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/lint/run",
      headers,
      payload: { trigger: "SCHEDULED" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().status).toBe("COMPLETED");
    const ids = (response.json().results as Array<{ id: string }>).map(
      (result) => result.id,
    );
    const persisted = await db.pool.query(
      "select count(*)::int count from knowledge_lint_runs where id=any($1::uuid[]) and trigger='SCHEDULED'",
      [ids],
    );
    expect(persisted.rows[0]?.count).toBe(ids.length);
    await db.pool.query(
      "delete from knowledge_lint_runs where id=any($1::uuid[])",
      [ids],
    );
  });

  it("shows audit events only for whole vaults where the actor is ADMIN", async () => {
    const action = `audit-isolation-${randomUUID()}`;
    await db.pool.query(
      `
      insert into audit_events(
        organization_id,space_id,vault_id,actor_id,action,resource_type,metadata
      )
      values
        ('00000000-0000-0000-0000-000000000001',$1,$3::uuid,$5,$6,'fixture',
         jsonb_build_object('vaultId',($3::uuid)::text)),
        ('00000000-0000-0000-0000-000000000001',$2,$4::uuid,$5,$6,'fixture',
         jsonb_build_object('vaultId',($4::uuid)::text))
      `,
      [defaultSpace, secondSpace, defaultVaultId, secondVaultId, admin, action],
    );
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/audit-events?action=${encodeURIComponent(action)}`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().events).toHaveLength(1);
      expect(response.json().events[0].space_id).toBe(defaultSpace);
    } finally {
      await db.pool.query("delete from audit_events where action=$1", [action]);
    }
  });

  it("exports only sanitized audit metadata and denies path-scoped admin tokens", async () => {
    const vault = await db.pool.query<{ id: string }>(
      "select id from vaults where space_id=$1 and enabled=true order by created_at limit 1",
      [defaultSpace],
    );
    const vaultId = vault.rows[0]?.id;
    if (!vaultId) throw new Error("Audit export integration vault is missing");
    const token = `akp-audit-path-scoped-${randomUUID()}`;
    const tokenHash = createHash("sha256").update(token).digest("hex");
    await db.pool.query(
      `insert into api_tokens(user_id,token_hash,label,scopes)
       values($1,$2,'audit export path-scope fixture',$3::jsonb)`,
      [
        admin,
        tokenHash,
        JSON.stringify({
          spaces: [
            {
              spaceId: defaultSpace,
              pathPrefix: "shared",
              permissions: ["admin"],
            },
          ],
        }),
      ],
    );
    const confirm = "EXPORT_SANITIZED_AUDIT_BUNDLE";
    try {
      const denied = await app.inject({
        method: "GET",
        url: `/v1/audit/export/${vaultId}/metadata?confirm=${confirm}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(denied.statusCode).toBe(403);

      const metadata = await app.inject({
        method: "GET",
        url: `/v1/audit/export/${vaultId}/metadata?confirm=${confirm}`,
        headers,
      });
      expect(metadata.statusCode).toBe(200);
      expect(metadata.json()).toMatchObject({
        status: "READY",
        schemaVersion: "1.0",
        vaultId,
        continuation: null,
      });
      expect(metadata.json().manifestHash).toMatch(/^[a-f0-9]{64}$/);

      const bundle = await app.inject({
        method: "GET",
        url: `/v1/audit/export/${vaultId}?confirm=${confirm}&maxPackets=1`,
        headers,
      });
      expect(bundle.statusCode).toBe(200);
      expect(bundle.headers["content-type"]).toContain("application/zip");
      expect(bundle.headers["x-akp-bundle-hash"]).toMatch(/^[a-f0-9]{64}$/);
      const payload = bundle.rawPayload.toString("utf8");
      expect(payload).toContain("BUNDLE_METADATA.json");
      expect(payload).not.toContain("body_cache");
      expect(payload).not.toContain("source_uri");
      expect(payload).not.toContain('"excerpt"');
    } finally {
      await db.pool.query("delete from api_tokens where token_hash=$1", [
        tokenHash,
      ]);
      await db.pool.query(
        "delete from audit_events where resource_id=$1 and action like 'audit.export%'",
        [vaultId],
      );
    }
  });
});
