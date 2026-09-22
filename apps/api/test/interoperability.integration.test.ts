import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  NEUTRAL_KNOWLEDGE_PROFILE_V1,
  canonicalKnowledgeProfileJson,
} from "@akp/contracts/knowledge-profile";
import { GitKnowledgeStore } from "@akp/git-store";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const adminId = "00000000-0000-0000-0000-000000000002";
const vaultId = randomUUID();
const token = `interop-admin-${randomUUID()}`;
const headers = { authorization: `Bearer ${token}` };
const tokenHash = createHash("sha256").update(token).digest("hex");
const profileRevisionId = randomUUID();
const roundTripVaultId = randomUUID();
const roundTripProfileRevisionId = randomUUID();

let app: FastifyInstance;
let db: Postgres;
let fixtureRoot: string;
const previousManagedRepository = process.env.AKP_MANAGED_REPO;
const reviewIds = new Set<string>();

function bundle(overrides: Record<string, unknown> = {}) {
  return {
    format: "OKF",
    version: "0.2",
    bundleId: "integration-foreign-bundle",
    exportedAt: "2026-09-15T00:00:00.000Z",
    source: { system: "Foreign Knowledge System" },
    documents: [
      {
        id: "FOREIGN-ATTESTED-1",
        externalId: "FOREIGN-ADR-1",
        aliases: ["foreign-cache-guidance"],
        sourcePath: "knowledge/notes/cache-guidance.md",
        title: "Foreign cache guidance",
        kind: "note",
        lifecycle: "DRAFT",
        trust: "ATTESTED",
        body: "# Foreign cache guidance\n\nThis externally attested statement remains an unverified local candidate until AKP review policy approves it. The text is intentionally substantive enough to exercise the actual Markdown validation path.",
        frontmatter: { trust: "ATTESTED" },
        evidence: [{ id: "FOREIGN-E-1", trust: "ATTESTED" }],
        provenance: { origin: "foreign-authority" },
      },
    ],
    relations: [],
    ...overrides,
  };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-interop-"));
  process.env.AKP_MANAGED_REPO = path.join(fixtureRoot, "managed");
  db = new Postgres(process.env.DATABASE_URL);

  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'interop-integration',$3::jsonb) on conflict(token_hash) do nothing`,
    [
      adminId,
      tokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: [
              "knowledge:read",
              "knowledge:propose",
              "knowledge:review",
            ],
          },
        ],
      }),
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       git_repository,default_branch,local_path,content_roots,source_roots,
       schema_profile,eval_pack,retrieval_config,permissions,visibility,enabled
     ) values($1,$2,$3,'Interop Vault',true,'interop:source','interop-vault',null,'main',$3,
       array['.']::text[],array[]::text[],'{}'::jsonb,
       '{"name":"generic","version":"1","enabled":true,"criticalCases":[]}'::jsonb,
       '{}'::jsonb,'{}'::jsonb,'PRIVATE',true)`,
    [vaultId, spaceId, path.join(fixtureRoot, "readonly-vault")],
  );
  await grantVaultMembership(db, {
    userId: adminId,
    vaultId,
    role: "ADMIN",
    permissions: [
      "knowledge:read",
      "source:read",
      "source:write",
      "knowledge:propose",
      "knowledge:review",
      "eval:run",
      "admin",
    ],
  });
  const canonical = canonicalKnowledgeProfileJson(NEUTRAL_KNOWLEDGE_PROFILE_V1);
  const hash = createHash("sha256").update(canonical).digest("hex");
  await db.pool.query(
    `insert into knowledge_profile_revisions(
       id,space_id,vault_id,profile_id,version,profile_hash,canonical_profile,
       status,compatibility_class,created_by,validation_report,validated_at,activated_at
     ) values($1,$2,$3,$4,$5,$6,$7,'ACTIVE','NON_BREAKING',$8,'{}'::jsonb,now(),now())`,
    [
      profileRevisionId,
      spaceId,
      vaultId,
      NEUTRAL_KNOWLEDGE_PROFILE_V1.profileId,
      NEUTRAL_KNOWLEDGE_PROFILE_V1.version,
      hash,
      canonical,
      adminId,
    ],
  );
  await db.pool.query(
    "update vaults set active_knowledge_profile_revision_id=$2 where id=$1",
    [vaultId, profileRevisionId],
  );

  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       git_repository,default_branch,local_path,content_roots,source_roots,
       schema_profile,eval_pack,retrieval_config,permissions,visibility,enabled
     ) values($1,$2,$3,'Interop Round Trip Vault',true,'interop:roundtrip','interop-roundtrip-vault',null,'main',$3,
       array['.']::text[],array[]::text[],'{}'::jsonb,
       '{"name":"generic","version":"1","enabled":true,"criticalCases":[]}'::jsonb,
       '{}'::jsonb,'{}'::jsonb,'PRIVATE',true)`,
    [roundTripVaultId, spaceId, path.join(fixtureRoot, "roundtrip-vault")],
  );
  await grantVaultMembership(db, {
    userId: adminId,
    vaultId: roundTripVaultId,
    role: "ADMIN",
    permissions: [
      "knowledge:read",
      "source:read",
      "source:write",
      "knowledge:propose",
      "knowledge:review",
      "eval:run",
      "admin",
    ],
  });
  await db.pool.query(
    `insert into knowledge_profile_revisions(
       id,space_id,vault_id,profile_id,version,profile_hash,canonical_profile,
       status,compatibility_class,created_by,validation_report,validated_at,activated_at
     ) values($1,$2,$3,$4,$5,$6,$7,'ACTIVE','NON_BREAKING',$8,'{}'::jsonb,now(),now())`,
    [
      roundTripProfileRevisionId,
      spaceId,
      roundTripVaultId,
      NEUTRAL_KNOWLEDGE_PROFILE_V1.profileId,
      NEUTRAL_KNOWLEDGE_PROFILE_V1.version,
      hash,
      canonical,
      adminId,
    ],
  );
  await db.pool.query(
    "update vaults set active_knowledge_profile_revision_id=$2 where id=$1",
    [roundTripVaultId, roundTripProfileRevisionId],
  );
  vi.resetModules();
  const module = await import("../src/server.js");
  app = module.buildServer();
  await app.ready();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    if (reviewIds.size) {
      await db.pool.query("delete from reviews where id=any($1::uuid[])", [
        [...reviewIds],
      ]);
    }
    await db.pool.query(
      "update vaults set active_knowledge_profile_revision_id=null where id=any($1::uuid[])",
      [[vaultId, roundTripVaultId]],
    );
    await db.pool.query(
      "delete from knowledge_profile_revisions where vault_id=any($1::uuid[])",
      [[vaultId, roundTripVaultId]],
    );
    await db.pool.query(
      "delete from vault_memberships where vault_id=any($1::uuid[])",
      [[vaultId, roundTripVaultId]],
    );
    await db.pool.query(
      "delete from knowledge_relations where space_id=$1 and (from_document_id in (select id from knowledge_documents where vault_id=$2) or to_document_id in (select id from knowledge_documents where vault_id=$2))",
      [spaceId, vaultId],
    );
    await db.pool.query("delete from knowledge_documents where vault_id=$1", [
      vaultId,
    ]);
    await db.pool.query(
      "delete from audit_events where vault_id=any($1::uuid[])",
      [[vaultId, roundTripVaultId]],
    );
    await db.pool.query("delete from vaults where id=any($1::uuid[])", [
      [vaultId, roundTripVaultId],
    ]);
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.close();
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (previousManagedRepository === undefined)
    delete process.env.AKP_MANAGED_REPO;
  else process.env.AKP_MANAGED_REPO = previousManagedRepository;
});

describe("OKF interoperability", () => {
  it("creates a review-first candidate and never promotes foreign trust", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/interoperability/import/okf",
      headers,
      payload: { spaceId, vaultId, bundle: bundle() },
    });
    expect(response.statusCode).toBe(201);
    const created = response.json() as {
      reviewId: string;
      headCommit: string;
      trustDisposition: string;
    };
    reviewIds.add(created.reviewId);
    expect(created.trustDisposition).toBe("LOCAL_UNVERIFIED_REVIEW_REQUIRED");
    const review = await db.pool.query<{
      status: string;
      head_commit: string;
      impact_manifest: {
        proposedChanges: Array<{ path: string }>;
        interoperability: Record<string, unknown>;
      };
    }>("select status,head_commit,impact_manifest from reviews where id=$1", [
      created.reviewId,
    ]);
    expect(review.rows[0]?.status).toBe("PENDING");
    expect(review.rows[0]?.impact_manifest.interoperability).toMatchObject({
      format: "OKF",
      version: "0.2",
      reviewRequired: true,
      targetPathsDerivedFromProfile: true,
      trustDisposition: "LOCAL_UNVERIFIED_REVIEW_REQUIRED",
    });
    const targetPath = review.rows[0]?.impact_manifest.proposedChanges[0]?.path;
    expect(targetPath).toMatch(/^knowledge\/note\/OKF-[A-F0-9]{16}\.md$/);
    const store = new GitKnowledgeStore(process.env.AKP_MANAGED_REPO!);
    const draft = await store.showFile(created.headCommit, targetPath!);
    expect(draft).toContain('trust: "UNVERIFIED"');
    expect(draft).toContain('foreign_trust: "ATTESTED"');
    const canonical = await db.pool.query(
      "select id from knowledge_documents where vault_id=$1 and path=$2",
      [vaultId, `managed/${targetPath}`],
    );
    expect(canonical.rowCount).toBe(0);
  });

  it("rejects unsafe imported paths before creating a review", async () => {
    const unsafeBundle = bundle({
      documents: [
        {
          ...(bundle().documents as Array<Record<string, unknown>>)[0],
          sourcePath: "../escape.md",
        },
      ],
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/interoperability/import/okf",
      headers,
      payload: { spaceId, vaultId, bundle: unsafeBundle },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "OKF_FOREIGN_PATH_UNSAFE" });
  });

  it("requires an explicit foreign type mapping", async () => {
    const foreign = bundle({
      documents: [
        {
          ...(bundle().documents as Array<Record<string, unknown>>)[0],
          kind: "foreign-decision",
        },
      ],
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/interoperability/import/okf",
      headers,
      payload: { spaceId, vaultId, bundle: foreign },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "OKF_KIND_MAPPING_REQUIRED",
    });
  });

  it("round-trips identity, provenance, relations, and trust into an isolated human-review candidate", async () => {
    const noteId = randomUUID();
    const procedureId = randomUUID();
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
         current_revision,body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
       ) values
       ($1,$3,$4,'knowledge/note/roundtrip-note.md','RT-NOTE-1','Round trip note','note','ACTIVE','HUMAN_REVIEWED',
        'roundtrip:note',$5,$6::jsonb,array['roundtrip-note']::text[],'knowledge',$7,64,'[]'::jsonb),
       ($2,$3,$4,'knowledge/procedure/roundtrip-procedure.md','RT-PROC-1','Round trip procedure','procedure','ACTIVE','HUMAN_REVIEWED',
        'roundtrip:procedure',$8,$9::jsonb,array['roundtrip-procedure']::text[],'knowledge',$10,64,'[]'::jsonb)`,
      [
        noteId,
        procedureId,
        spaceId,
        vaultId,
        "# Round trip note\n\nThe note explains the governed procedure.",
        JSON.stringify({
          type: "note",
          title: "Round trip note",
          status: "ACTIVE",
        }),
        createHash("sha256").update("roundtrip-note").digest("hex"),
        "# Round trip procedure\n\nThe procedure remains governed after exchange.",
        JSON.stringify({
          type: "procedure",
          title: "Round trip procedure",
          status: "ACTIVE",
        }),
        createHash("sha256").update("roundtrip-procedure").digest("hex"),
      ],
    );
    await db.pool.query(
      `insert into knowledge_relations(
         space_id,from_document_id,to_document_id,relation_type,weight,provenance,metadata
       ) values($1,$2,$3,'explains',1,'roundtrip-fixture',$4::jsonb)`,
      [spaceId, noteId, procedureId, JSON.stringify({ source: "roundtrip" })],
    );

    const exportedResponse = await app.inject({
      method: "POST",
      url: "/v1/interoperability/export",
      headers,
      payload: {
        spaceId,
        vaultId,
        format: "OKF_0_2",
        documentIds: [noteId, procedureId],
      },
    });
    expect(exportedResponse.statusCode).toBe(200);
    const exported = exportedResponse.json() as {
      format: string;
      version: string;
      source: { profileId?: string; profileVersion?: string };
      documents: Array<{ id: string; trust: string }>;
      relations: Array<{
        fromId: string;
        toId: string;
        type: string;
        provenance: string;
      }>;
    };
    expect(exported).toMatchObject({
      format: "OKF",
      version: "0.2",
      source: {
        profileId: NEUTRAL_KNOWLEDGE_PROFILE_V1.profileId,
        profileVersion: NEUTRAL_KNOWLEDGE_PROFILE_V1.version,
      },
    });
    expect(new Set(exported.documents.map((document) => document.id))).toEqual(
      new Set(["RT-NOTE-1", "RT-PROC-1"]),
    );
    expect(exported.relations).toContainEqual(
      expect.objectContaining({
        fromId: "RT-NOTE-1",
        toId: "RT-PROC-1",
        type: "explains",
        provenance: "roundtrip-fixture",
      }),
    );

    const importedResponse = await app.inject({
      method: "POST",
      url: "/v1/interoperability/import/okf",
      headers,
      payload: {
        spaceId,
        vaultId: roundTripVaultId,
        bundle: exported,
      },
    });
    expect(importedResponse.statusCode).toBe(201);
    const imported = importedResponse.json() as {
      reviewId: string;
      headCommit: string;
      status: string;
      trustDisposition: string;
    };
    reviewIds.add(imported.reviewId);
    expect(imported).toMatchObject({
      status: "PENDING",
      trustDisposition: "LOCAL_UNVERIFIED_REVIEW_REQUIRED",
    });

    const review = await db.pool.query<{
      status: string;
      head_commit: string;
      impact_manifest: {
        proposedChanges: Array<{ path: string }>;
        interoperability: {
          reviewRequired: boolean;
          trustDisposition: string;
        };
      };
    }>("select status,head_commit,impact_manifest from reviews where id=$1", [
      imported.reviewId,
    ]);
    expect(review.rows[0]).toMatchObject({
      status: "PENDING",
      impact_manifest: {
        interoperability: {
          reviewRequired: true,
          trustDisposition: "LOCAL_UNVERIFIED_REVIEW_REQUIRED",
        },
      },
    });
    const store = new GitKnowledgeStore(process.env.AKP_MANAGED_REPO!);
    const candidateBodies = await Promise.all(
      (review.rows[0]?.impact_manifest.proposedChanges ?? []).map((change) =>
        store.showFile(imported.headCommit, change.path),
      ),
    );
    const joined = candidateBodies.join("\n");
    expect(joined).toContain('"foreignDocumentId":"RT-NOTE-1"');
    expect(joined).toContain('"foreignDocumentId":"RT-PROC-1"');
    expect(joined).toContain('"foreignType":"explains"');
    expect(joined).toContain('"localType":"explains"');
    expect(joined).toContain('"provenance":"roundtrip-fixture"');
    expect(joined).toContain('foreign_trust: "HUMAN_REVIEWED"');
    expect(joined).toContain('trust: "UNVERIFIED"');

    const humanReview = await app.inject({
      method: "POST",
      url: `/v1/reviews/${imported.reviewId}/decision`,
      headers,
      payload: {
        decision: "REQUEST_CHANGES",
        reason:
          "Round-trip semantic inspection completed without auto-publication.",
      },
    });
    expect(humanReview.statusCode).toBe(200);
    expect(humanReview.json()).toMatchObject({
      id: imported.reviewId,
      status: "CHANGES_REQUESTED",
    });
    const canonicalTarget = await db.pool.query(
      "select id from knowledge_documents where vault_id=$1",
      [roundTripVaultId],
    );
    expect(canonicalTarget.rowCount).toBe(0);
  });

  it("exports OKF, JSON-LD and GraphML from authorized canonical knowledge", async () => {
    const documentId = randomUUID();
    await db.pool.query(
      `insert into knowledge_documents(
         id,space_id,vault_id,path,external_id,title,type,lifecycle,trust_tier,
         current_revision,body_cache,frontmatter,aliases,layer,content_hash,token_estimate,raw_links
       ) values($1,$2,$3,$4,'LOCAL-EXPORT-1','Local export','note','ACTIVE','HUMAN_REVIEWED',
         'export:1',$5,$6::jsonb,array['export-alias']::text[],'knowledge',$7,64,'[]'::jsonb)`,
      [
        documentId,
        spaceId,
        vaultId,
        "knowledge/note/local-export.md",
        "# Local export\n\nThis canonical local note is exported through the governed interoperability route with its identity, lifecycle and trust preserved.",
        JSON.stringify({
          type: "note",
          title: "Local export",
          status: "ACTIVE",
          knowledge_layer: "knowledge",
        }),
        createHash("sha256").update("local-export").digest("hex"),
      ],
    );
    const okf = await app.inject({
      method: "POST",
      url: "/v1/interoperability/export",
      headers,
      payload: {
        spaceId,
        vaultId,
        format: "OKF_0_2",
        documentIds: [documentId],
      },
    });
    expect(okf.statusCode).toBe(200);
    expect(okf.json()).toMatchObject({
      format: "OKF",
      version: "0.2",
      documents: [
        {
          id: "LOCAL-EXPORT-1",
          kind: "note",
          lifecycle: "ACTIVE",
          trust: "HUMAN_REVIEWED",
        },
      ],
    });
    const jsonLd = await app.inject({
      method: "POST",
      url: "/v1/interoperability/export",
      headers,
      payload: {
        spaceId,
        vaultId,
        format: "JSON_LD",
        documentIds: [documentId],
      },
    });
    expect(jsonLd.statusCode).toBe(200);
    expect(jsonLd.json()).toMatchObject({ "@type": "akp:KnowledgeBundle" });
    const graphMl = await app.inject({
      method: "POST",
      url: "/v1/interoperability/export",
      headers,
      payload: {
        spaceId,
        vaultId,
        format: "GRAPHML",
        documentIds: [documentId],
      },
    });
    expect(graphMl.statusCode).toBe(200);
    expect(graphMl.body).toContain("<graphml");
    expect(graphMl.body).toContain("LOCAL-EXPORT-1");
  });
});
