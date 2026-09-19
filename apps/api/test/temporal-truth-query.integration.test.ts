import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  Postgres,
  PostgresTemporalTruthStore,
  grantVaultMembership,
} from "@akp/postgres";

const organizationId = randomUUID();
const spaceId = randomUUID();
const vaultId = randomUUID();
const actorId = randomUUID();
const sourceId = randomUUID();
const artifactId = randomUUID();
const token = `truth-reader-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };
let db: Postgres;
let app: FastifyInstance;
let oldFactId = "";
let newFactId = "";
let oldRevision = "";
let newRevision = "";

beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);

  await db.pool.query(
    "insert into organizations(id,slug,name) values($1,$2,'Truth query integration')",
    [organizationId, `truth-query-${organizationId.slice(0, 8)}`],
  );
  await db.pool.query(
    `insert into spaces(
       id,organization_id,slug,name,visibility,knowledge_repo_path
     ) values($1,$2,$3,'Truth query space','PRIVATE',$4)`,
    [
      spaceId,
      organizationId,
      `truth-query-${spaceId.slice(0, 8)}`,
      `/tmp/truth-query-${spaceId}`,
    ],
  );
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,'Truth query vault',true,'truth-query:r0',$4,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/truth-query-vault-${vaultId}`,
      `truth-query-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    "insert into users(id,email,display_name) values($1,$2,'Truth Query Reader')",
    [actorId, `${actorId}@example.test`],
  );
  await db.pool.query(
    "insert into memberships(user_id,space_id,role,path_prefix) values($1,$2,'CONTRIBUTOR',null)",
    [actorId, spaceId],
  );
  await grantVaultMembership(db, {
    userId: actorId,
    vaultId,
    role: "CONTRIBUTOR",
    pathPrefix: "security",
    permissions: ["knowledge:read"],
  });
  await db.pool.query(
    "insert into api_tokens(user_id,token_hash,label,scopes) values($1,$2,'truth query reader',$3::jsonb)",
    [
      actorId,
      tokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read"],
          },
        ],
      }),
    ],
  );
  await db.pool.query(
    `insert into sources(
       id,space_id,vault_id,title,source_uri,media_type,sha256,byte_size,
       object_key,status,metadata
     ) values($1,$2,$3,'Truth query source',$4,'text/plain',$5,4,$6,'ACTIVE','{}'::jsonb)`,
    [
      sourceId,
      spaceId,
      vaultId,
      `https://example.test/${sourceId}`,
      "a".repeat(64),
      `truth-query/${sourceId}.txt`,
    ],
  );
  await db.pool.query(
    `insert into source_artifacts(
       id,source_id,kind,object_key,source_hash,extractor,extractor_version,
       quality,metadata
     ) values($1,$2,'normalized',$3,$4,'fixture','1','HIGH','{}'::jsonb)`,
    [artifactId, sourceId, `truth-query/${artifactId}.json`, "a".repeat(64)],
  );

  const store = new PostgresTemporalTruthStore(db);
  const episode = await store.createSourceEpisode({
    spaceId,
    vaultId,
    sourceId,
    sourceArtifactId: artifactId,
    sourceHash: "a".repeat(64),
    locatorRefs: ["source:truth-query#tls"],
  });
  const support = await store.createSupportSet({
    spaceId,
    vaultId,
    sourceEpisodeIds: [episode.id],
  });
  const oldFact = await store.recordFact({
    spaceId,
    vaultId,
    scopeId: "security:tls",
    authorizationPath: "security/tls.md",
    subjectRef: "policy:transport",
    predicate: "tls_minimum",
    object: { version: "1.2" },
    validFrom: "2025-01-01T00:00:00.000Z",
    recordedAt: "2026-01-01T00:00:00.000Z",
    supportSetId: support.id,
    sourceEpisodeId: episode.id,
  });
  const newFact = await store.recordFact({
    spaceId,
    vaultId,
    scopeId: "security:tls",
    authorizationPath: "security/tls.md",
    subjectRef: "policy:transport",
    predicate: "tls_minimum",
    object: { version: "1.3" },
    validFrom: "2026-02-01T00:00:00.000Z",
    recordedAt: "2026-02-01T00:00:00.000Z",
    supportSetId: support.id,
    sourceEpisodeId: episode.id,
    supersedesFactId: oldFact.fact.id,
  });
  await store.recordFact({
    spaceId,
    vaultId,
    scopeId: "private:hidden",
    authorizationPath: "private/hidden.md",
    subjectRef: "policy:hidden",
    predicate: "secret",
    object: { visible: false },
    validFrom: "2025-01-01T00:00:00.000Z",
    recordedAt: "2026-03-01T00:00:00.000Z",
    supportSetId: support.id,
    sourceEpisodeId: episode.id,
  });
  oldFactId = oldFact.fact.id;
  newFactId = newFact.fact.id;
  oldRevision = oldFact.revision.revisionHash;
  newRevision = newFact.revision.revisionHash;

  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (db) {
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.pool.query(
      "delete from memberships where user_id=$1 and space_id=$2",
      [actorId, spaceId],
    );
    await db.pool.query("update vaults set enabled=false where id=$1", [
      vaultId,
    ]);
    await db.close();
  }
});

function query(path: string) {
  const separator = path.includes("?") ? "&" : "?";
  return app.inject({
    method: "GET",
    url: `${path}${separator}spaceId=${spaceId}&vaultId=${vaultId}`,
    headers,
  });
}

describe("temporal truth read boundary", () => {
  it("returns different current and historical truth at an explicit revision", async () => {
    const current = await query(
      "/v1/truth/facts?subjectRef=policy%3Atransport&predicate=tls_minimum&validAt=2026-09-01T00%3A00%3A00.000Z",
    );
    expect(current.statusCode, current.body).toBe(200);
    expect(current.json()).toMatchObject({
      mode: "CURRENT",
      facts: [
        {
          id: newFactId,
          object: { version: "1.3" },
          queryRevisionHash: expect.any(String),
        },
      ],
    });

    const historical = await query(
      `/v1/truth/facts?subjectRef=policy%3Atransport&predicate=tls_minimum&validAt=2026-09-01T00%3A00%3A00.000Z&truthRevisionHash=${oldRevision}`,
    );
    expect(historical.statusCode, historical.body).toBe(200);
    expect(historical.json()).toMatchObject({
      facts: [
        {
          id: oldFactId,
          object: { version: "1.2" },
          queryRevisionHash: oldRevision,
        },
      ],
    });
  });

  it("supports history, changed_since and support history without leaking other path scopes", async () => {
    const history = await query(
      "/v1/truth/facts?mode=HISTORY&subjectRef=policy%3Atransport",
    );
    expect(history.statusCode, history.body).toBe(200);
    const historyBody = history.json() as { facts: Array<{ id: string }> };
    expect(historyBody.facts.map((fact) => fact.id)).toEqual(
      expect.arrayContaining([oldFactId, newFactId]),
    );

    const changed = await query(
      "/v1/truth/facts?mode=HISTORY&changedSince=2026-01-15T00%3A00%3A00.000Z",
    );
    expect(changed.statusCode, changed.body).toBe(200);
    const changedBody = changed.json() as {
      facts: Array<{ id: string; authorizationPath: string }>;
    };
    expect(changedBody.facts.map((fact) => fact.id)).toEqual(
      expect.arrayContaining([oldFactId, newFactId]),
    );
    expect(
      changedBody.facts.every((fact) =>
        fact.authorizationPath.startsWith("security/"),
      ),
    ).toBe(true);
    expect(JSON.stringify(changedBody)).not.toContain("private/hidden.md");

    const support = await query(`/v1/truth/facts/${oldFactId}/support-history`);
    expect(support.statusCode, support.body).toBe(200);
    expect(support.json()).toMatchObject({
      fact: { id: oldFactId, authorizationPath: "security/tls.md" },
      supersessions: [
        {
          old_fact_id: oldFactId,
          new_fact_id: newFactId,
          truth_revision_hash: newRevision,
        },
      ],
    });
  });
});
