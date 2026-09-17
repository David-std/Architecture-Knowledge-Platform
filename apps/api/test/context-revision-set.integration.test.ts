import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  DEFAULT_KNOWLEDGE_PROFILE_V1,
  NEUTRAL_KNOWLEDGE_PROFILE_V1,
  canonicalKnowledgeProfileJson,
} from "@akp/contracts/knowledge-profile";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = randomUUID();
const vaultId = randomUUID();

function stablePolicyValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stablePolicyValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stablePolicyValue(nested)]),
  );
}

function expectedDefaultPolicyRevision(): string {
  const profile = DEFAULT_KNOWLEDGE_PROFILE_V1;
  const policy = {
    lifecycles: profile.lifecycles ?? {},
    evidencePolicies: profile.evidencePolicies ?? {},
    reviewPolicies: profile.reviewPolicies ?? {},
    retrievalPolicy: profile.retrievalPolicy ?? {},
    promotionPolicy: profile.promotionPolicy ?? {},
    freshnessPolicy: profile.freshnessPolicy ?? {},
    connectorPolicy: profile.connectorPolicy ?? null,
    modelRoleConstraints: profile.modelRoleConstraints ?? [],
  };
  return createHash("sha256")
    .update(JSON.stringify(stablePolicyValue(policy)))
    .digest("hex");
}
const token = `context-revision-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,'git:r1',$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/context-revision-${vaultId}`,
      "Context revision integration vault",
      `context-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into vault_index_revisions(
       space_id,vault_id,corpus_revision,lexical_revision,vector_revision,
       graph_revision,context_pack_revision,retrieval_configuration_version,
       status,warnings
     ) values($1,$2,'corpus:r1','corpus:r1','vector:r1','corpus:r1',
              'corpus:r1','rrf-v1','READY','[]'::jsonb)`,
    [spaceId, vaultId],
  );
  await db.pool.query(
    "insert into users(id,email,display_name) values($1,$2,'Context Revision Actor')",
    [actorId, `${actorId}@example.test`],
  );
  await db.pool.query(
    "insert into memberships(user_id,space_id,role,path_prefix) values($1,$2,'VIEWER',null)",
    [actorId, spaceId],
  );
  await grantVaultMembership(db, {
    userId: actorId,
    vaultId,
    role: "VIEWER",
    pathPrefix: null,
    permissions: ["knowledge:read", "source:read"],
  });
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'context revision integration',$3::jsonb)`,
    [
      actorId,
      tokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read", "source:read"],
          },
        ],
      }),
    ],
  );
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    await db.pool.query(
      "delete from audit_events where resource_type='agent_session' and space_id=$1 and vault_id=$2",
      [spaceId, vaultId],
    );
    await db.pool.query("delete from agent_sessions where vault_id=$1", [
      vaultId,
    ]);
    await db.pool.query(
      "update vaults set active_knowledge_profile_revision_id=null where id=$1",
      [vaultId],
    );
    await db.pool.query(
      "delete from knowledge_profile_revisions where vault_id=$1",
      [vaultId],
    );
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.pool.query(
      "delete from memberships where user_id=$1 and space_id=$2",
      [actorId, spaceId],
    );
    await db.pool.query("delete from users where id=$1", [actorId]);
    await db.pool.query("delete from vault_index_revisions where vault_id=$1", [
      vaultId,
    ]);
    await db.pool.query("update vaults set enabled=false where id=$1", [
      vaultId,
    ]);
    await db.close();
  }
});

describe("workspace context revision pinning", () => {
  it("pins a coherent revision set and rejects strict work after drift", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        spaceId,
        vaultId,
        purpose: "Pin a coherent workspace context revision",
        contextBudget: 4096,
      },
    });
    expect(created.statusCode).toBe(201);
    const initial = created.json() as {
      id: string;
      contextRevisionSetHash: string;
      contextRevisionSet: {
        dimensions: Record<string, { status: string; revision: string | null }>;
        profile: {
          source: string;
          revisionId: string | null;
          profileId: string;
          version: string;
          hash: string;
        };
        policy: { revision: string };
      };
    };
    expect(initial.contextRevisionSetHash).toMatch(/^[a-f0-9]{64}$/);
    expect(initial.contextRevisionSet.dimensions).toMatchObject({
      knowledgeGit: { status: "AVAILABLE", revision: "git:r1" },
      corpus: { status: "AVAILABLE", revision: "corpus:r1" },
      lexical: { status: "AVAILABLE", revision: "corpus:r1" },
      vector: { status: "AVAILABLE", revision: "vector:r1" },
      graph: { status: "AVAILABLE", revision: "corpus:r1" },
      contextPack: { status: "AVAILABLE", revision: "corpus:r1" },
      retrievalConfiguration: { status: "AVAILABLE", revision: "rrf-v1" },
      code: { status: "UNAVAILABLE", revision: null },
      runtime: { status: "UNAVAILABLE", revision: null },
      temporal: { status: "UNAVAILABLE", revision: null },
      community: { status: "UNAVAILABLE", revision: null },
    });
    const defaultCanonical = canonicalKnowledgeProfileJson(
      DEFAULT_KNOWLEDGE_PROFILE_V1,
    );
    const defaultProfileHash = createHash("sha256")
      .update(defaultCanonical)
      .digest("hex");
    expect(initial.contextRevisionSet.profile).toMatchObject({
      source: "DEFAULT",
      revisionId: null,
      profileId: DEFAULT_KNOWLEDGE_PROFILE_V1.profileId,
      version: DEFAULT_KNOWLEDGE_PROFILE_V1.version,
      hash: defaultProfileHash,
    });
    expect(initial.contextRevisionSet.policy.revision).toBe(
      expectedDefaultPolicyRevision(),
    );

    const initialState = await app.inject({
      method: "GET",
      url: `/v1/sessions/${initial.id}/state`,
      headers,
    });
    expect(initialState.statusCode).toBe(200);
    expect(initialState.json()).toMatchObject({
      contextRevision: {
        status: "CURRENT",
        changedDimensions: [],
        pinned: { revisionSetHash: initial.contextRevisionSetHash },
        current: { revisionSetHash: initial.contextRevisionSetHash },
      },
    });

    const canonical = canonicalKnowledgeProfileJson(
      NEUTRAL_KNOWLEDGE_PROFILE_V1,
    );
    const profileHash = createHash("sha256").update(canonical).digest("hex");
    const profileRevisionId = randomUUID();
    await db.pool.query(
      `insert into knowledge_profile_revisions(
         id,space_id,vault_id,profile_id,version,profile_hash,canonical_profile,
         status,compatibility_class,activated_at
       ) values($1,$2,$3,$4,$5,$6,$7,'ACTIVE','NON_BREAKING',now())`,
      [
        profileRevisionId,
        spaceId,
        vaultId,
        NEUTRAL_KNOWLEDGE_PROFILE_V1.profileId,
        NEUTRAL_KNOWLEDGE_PROFILE_V1.version,
        profileHash,
        canonical,
      ],
    );
    await db.pool.query(
      `update vaults
          set current_revision='git:r2',active_knowledge_profile_revision_id=$2
        where id=$1`,
      [vaultId, profileRevisionId],
    );
    await db.pool.query(
      `update vault_index_revisions
          set corpus_revision='corpus:r2',lexical_revision='corpus:r2',
              vector_revision='vector:r2',graph_revision='corpus:r2',
              context_pack_revision='corpus:r2',
              retrieval_configuration_version='rrf-v2',updated_at=now()
        where space_id=$1 and vault_id=$2`,
      [spaceId, vaultId],
    );

    const changed = await app.inject({
      method: "GET",
      url: `/v1/sessions/${initial.id}/state`,
      headers,
    });
    expect(changed.statusCode).toBe(200);
    const changedBody = changed.json() as {
      contextRevision: { status: string; changedDimensions: string[] };
    };
    expect(changedBody.contextRevision.status).toBe("CHANGED");
    expect(changedBody.contextRevision.changedDimensions).toEqual(
      expect.arrayContaining([
        "knowledgeGit",
        "corpus",
        "lexical",
        "vector",
        "graph",
        "contextPack",
        "retrievalConfiguration",
        "profile",
        "policy",
      ]),
    );

    const staleClaim = await app.inject({
      method: "POST",
      url: `/v1/sessions/${initial.id}/claims`,
      headers,
      payload: { workKey: "packages/compiler/**", leaseSeconds: 120 },
    });
    expect(staleClaim.statusCode).toBe(409);
    expect(staleClaim.json()).toMatchObject({
      code: "CONTEXT_REVISION_CHANGED",
    });

    const replacement = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        spaceId,
        vaultId,
        purpose: "Start against the current context revision",
        contextBudget: 4096,
      },
    });
    expect(replacement.statusCode).toBe(201);
    const replacementBody = replacement.json() as {
      id: string;
      contextRevisionSetHash: string;
      contextRevisionSet: {
        dimensions: Record<string, { revision: string | null }>;
        profile: { source: string; revisionId: string | null; hash: string };
      };
    };
    expect(replacementBody.contextRevisionSetHash).not.toBe(
      initial.contextRevisionSetHash,
    );
    expect(replacementBody.contextRevisionSet.dimensions).toMatchObject({
      knowledgeGit: { revision: "git:r2" },
      corpus: { revision: "corpus:r2" },
      vector: { revision: "vector:r2" },
    });
    expect(replacementBody.contextRevisionSet.profile).toMatchObject({
      source: "DURABLE_REVISION",
      revisionId: profileRevisionId,
      hash: profileHash,
    });

    const replacementState = await app.inject({
      method: "GET",
      url: `/v1/sessions/${replacementBody.id}/state`,
      headers,
    });
    expect(replacementState.statusCode).toBe(200);
    expect(replacementState.json()).toMatchObject({
      contextRevision: {
        status: "CURRENT",
        changedDimensions: [],
      },
    });
  });
});
