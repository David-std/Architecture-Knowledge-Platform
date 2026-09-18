import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ConnectorCapabilities } from "@akp/contracts/connector-capabilities";
import {
  Postgres,
  grantVaultMembership,
  upsertContextFabricPeer,
} from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = randomUUID();
const adminId = randomUUID();
const vaultId = randomUUID();
const token = `context-fabric-${randomUUID()}`;
const adminToken = `context-fabric-admin-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const adminTokenHash = createHash("sha256").update(adminToken).digest("hex");
const headers = { authorization: `Bearer ${token}` };
const adminHeaders = { authorization: `Bearer ${adminToken}` };

let app: FastifyInstance;
let db: Postgres;
let sessionId = "";
let peerIds: string[] = [];

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
     ) values($1,$2,$3,$4,true,'fabric:r1',$5,$3,'PRIVATE',true)`,
    [
      vaultId,
      spaceId,
      `/tmp/context-fabric-${vaultId}`,
      "Context fabric integration vault",
      `context-fabric-${vaultId.slice(0, 8)}`,
    ],
  );
  await db.pool.query(
    `insert into users(id,email,display_name) values
      ($1,$2,'Context Fabric Actor'),
      ($3,$4,'Context Fabric Admin')`,
    [actorId, `${actorId}@example.test`, adminId, `${adminId}@example.test`],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix) values
      ($1,$3,'VIEWER',null),
      ($2,$3,'ADMIN',null)`,
    [actorId, adminId, spaceId],
  );
  await grantVaultMembership(db, {
    userId: actorId,
    vaultId,
    role: "VIEWER",
    pathPrefix: null,
    permissions: ["knowledge:read", "source:read"],
  });
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes) values
      ($1,$2,'context fabric actor',$3::jsonb),
      ($4,$5,'context fabric admin',$6::jsonb)`,
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
      adminId,
      adminTokenHash,
      JSON.stringify({
        spaces: [
          {
            spaceId,
            pathPrefix: null,
            permissions: ["knowledge:read", "admin"],
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
    if (peerIds.length) {
      await db.pool.query(
        "delete from context_fabric_peers where id=any($1::uuid[])",
        [peerIds],
      );
    }
    if (sessionId) {
      await db.pool.query(
        "delete from audit_events where resource_id=$1 or metadata->>'sessionId'=$1",
        [sessionId],
      );
      await db.pool.query("delete from agent_sessions where id=$1", [
        sessionId,
      ]);
    }
    await db.pool.query(
      "delete from api_tokens where token_hash=any($1::text[])",
      [[tokenHash, adminTokenHash]],
    );
    await db.pool.query(
      "delete from memberships where user_id=any($1::uuid[]) and space_id=$2",
      [[actorId, adminId], spaceId],
    );
    await db.pool.query("delete from users where id=any($1::uuid[])", [
      [actorId, adminId],
    ]);
    await db.pool.query("update vaults set enabled=false where id=$1", [
      vaultId,
    ]);
    await db.close();
  }
});

describe("team context fabric integration", () => {
  it("keeps external refs operational and reconciles offline drafts without last-write-wins", async () => {
    const capabilities = await app.inject({
      method: "GET",
      url: "/v1/context-fabric/capabilities",
      headers,
    });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({
      manifest: {
        contextApiVersion: "v1",
        requiredAuthenticationModes: ["BEARER_TOKEN", "WEB_SESSION"],
        supportedExchangeFormats: [
          { format: "OKF_0_2", import: true, export: true },
          { format: "JSON_LD", import: false, export: true },
          { format: "GRAPHML", import: false, export: true },
        ],
        graphCapabilities: {
          domains: ["EPISTEMIC", "WORK"],
          authorizationBeforeTraversal: true,
        },
        federationModes: ["CATALOG_ONLY"],
      },
      capabilities: {
        externalObjectRefs: true,
        queuedOfflineDrafts: true,
        staleReconnectDisclosure: true,
        lastWriteWinsApprovedKnowledge: false,
        federationRemoteQuery: false,
        writableDatabaseFileSync: false,
      },
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/sessions",
      headers,
      payload: {
        spaceId,
        vaultId,
        purpose: "Offline context fabric fixture",
        contextBudget: 2048,
      },
    });
    expect(created.statusCode).toBe(201);
    const createdSession = created.json() as {
      id: string;
      contextRevisionSetHash: string;
    };
    sessionId = createdSession.id;
    expect(createdSession.contextRevisionSetHash).toMatch(/^[a-f0-9]{64}$/);

    const externalRef = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/external-refs`,
      headers,
      payload: {
        provider: "github",
        objectType: "issue",
        externalId: "GH-42",
        canonicalUrl: "https://example.test/issues/42",
        sourceRevision: "etag-42",
        title: "External system of record item",
        authority: "SYSTEM_OF_RECORD",
        metadata: { state: "OPEN" },
      },
    });
    expect(externalRef.statusCode).toBe(201);
    const externalRefBody = externalRef.json() as {
      id: string;
      provider: string;
      objectType: string;
      externalId: string;
      authority: string;
    };
    expect(externalRefBody).toMatchObject({
      provider: "github",
      objectType: "issue",
      externalId: "GH-42",
      authority: "SYSTEM_OF_RECORD",
    });
    const externalRefOutbox = await db.pool.query<{
      space_id: string;
      vault_id: string;
      payload: Record<string, unknown>;
    }>(
      `select space_id,vault_id,payload from event_outbox
        where event_type='ExternalObjectRefUpserted' and resource_id=$1`,
      [externalRefBody.id],
    );
    expect(externalRefOutbox.rows).toHaveLength(1);
    expect(externalRefOutbox.rows[0]).toMatchObject({
      space_id: spaceId,
      vault_id: vaultId,
      payload: {
        sessionId,
        externalId: "GH-42",
        authority: "SYSTEM_OF_RECORD",
      },
    });

    const listedRefs = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/external-refs`,
      headers,
    });
    expect(listedRefs.statusCode).toBe(200);
    expect(
      (listedRefs.json() as { refs: Array<{ externalId: string }> }).refs,
    ).toContainEqual(expect.objectContaining({ externalId: "GH-42" }));

    const beforeDocuments = await db.pool.query<{ count: number }>(
      "select count(*)::int count from knowledge_documents where vault_id=$1",
      [vaultId],
    );

    const queued = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts`,
      headers,
      payload: {
        clientDraftId: "offline-1",
        baseRevisionSetHash: createdSession.contextRevisionSetHash,
        eventType: "FINDING",
        payload: {
          summary: "Offline finding that remains coordination state",
          evidence: "local-observation",
        },
      },
    });
    expect(queued.statusCode).toBe(201);
    const queuedDraft = queued.json() as { id: string; status: string };
    expect(queuedDraft.status).toBe("QUEUED");

    const duplicate = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts`,
      headers,
      payload: {
        clientDraftId: "offline-1",
        baseRevisionSetHash: createdSession.contextRevisionSetHash,
        eventType: "FINDING",
        payload: {
          summary: "Offline finding that remains coordination state",
          evidence: "local-observation",
        },
      },
    });
    expect(duplicate.statusCode).toBe(201);
    expect(duplicate.json()).toMatchObject({
      id: queuedDraft.id,
      status: "QUEUED",
    });
    const queueOutbox = await db.pool.query<{ count: number }>(
      `select count(*)::int count from event_outbox
        where event_type='OfflineDraftQueued' and resource_id=$1`,
      [queuedDraft.id],
    );
    expect(queueOutbox.rows[0]?.count).toBe(1);

    const applied = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts/${queuedDraft.id}/apply`,
      headers,
    });
    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ status: "APPLIED" });

    const appliedAgain = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts/${queuedDraft.id}/apply`,
      headers,
    });
    expect(appliedAgain.statusCode).toBe(200);
    expect(appliedAgain.json()).toMatchObject({ status: "APPLIED" });

    const appliedEvents = await db.pool.query<{ count: number }>(
      `select count(*)::int count from workspace_events
        where session_id=$1 and event_type='FINDING'
          and payload->>'summary'='Offline finding that remains coordination state'`,
      [sessionId],
    );
    expect(appliedEvents.rows[0]?.count).toBe(1);
    const reconciledOutbox = await db.pool.query<{ count: number }>(
      `select count(*)::int count from event_outbox
        where event_type='OfflineDraftReconciled' and resource_id=$1`,
      [queuedDraft.id],
    );
    expect(reconciledOutbox.rows[0]?.count).toBe(1);

    await db.pool.query(
      "update vaults set current_revision='fabric:r2' where id=$1",
      [vaultId],
    );
    const staleQueue = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts`,
      headers,
      payload: {
        clientDraftId: "offline-stale",
        baseRevisionSetHash: createdSession.contextRevisionSetHash,
        eventType: "NOTE",
        payload: { note: "must not last-write-wins across revision drift" },
      },
    });
    expect(staleQueue.statusCode).toBe(409);
    const staleDraft = staleQueue.json() as { id: string; status: string };
    expect(staleDraft.status).toBe("RECONCILE_REQUIRED");

    const staleApply = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/offline-drafts/${staleDraft.id}/apply`,
      headers,
    });
    expect(staleApply.statusCode).toBe(409);
    expect(staleApply.json()).toMatchObject({ status: "RECONCILE_REQUIRED" });

    const staleNote = await db.pool.query<{ count: number }>(
      `select count(*)::int count from workspace_events
        where session_id=$1 and payload->>'note'='must not last-write-wins across revision drift'`,
      [sessionId],
    );
    expect(staleNote.rows[0]?.count).toBe(0);
    const staleReconciledOutbox = await db.pool.query<{ count: number }>(
      `select count(*)::int count from event_outbox
        where event_type='OfflineDraftReconciled' and resource_id=$1`,
      [staleDraft.id],
    );
    expect(staleReconciledOutbox.rows[0]?.count).toBe(0);

    const organization = await db.pool.query<{ organization_id: string }>(
      "select organization_id from spaces where id=$1",
      [spaceId],
    );
    const organizationId = organization.rows[0]?.organization_id;
    expect(organizationId).toBeTruthy();
    const mirrorCapabilities = ConnectorCapabilities.parse({
      schemaVersion: 1,
      accessMode: "MIRROR_INDEXED",
      permissionFidelity: "SOURCE_ACL_EXACT",
      syncFidelity: "MIRROR",
      incrementalSync: true,
      deletionPropagation: "IMMEDIATE",
      freshnessSlaSeconds: 60,
      cursorOrWebhook: true,
      sourceAuthority: "SYSTEM_OF_RECORD",
      writeBack: "NONE",
      identityMapping: "EXACT",
      dataResidency: "ORG",
      replayable: true,
      auditTrail: "FULL",
      rateLimit: {
        kind: "DECLARED",
        requestsPerMinute: 600,
        onExceeded: "BACKOFF",
      },
      degradation: { onUnavailable: "STALE_READ", maxStaleSeconds: 900 },
      health: "HEALTHY",
    });
    const liveCapabilities = ConnectorCapabilities.parse({
      schemaVersion: 1,
      accessMode: "REFERENCE_LIVE",
      permissionFidelity: "NONE",
      syncFidelity: "APPEND",
      incrementalSync: false,
      deletionPropagation: "NONE",
      cursorOrWebhook: false,
      sourceAuthority: "REFERENCE",
      writeBack: "NONE",
      identityMapping: "NONE",
      dataResidency: "EXTERNAL",
      replayable: false,
      auditTrail: "METADATA_ONLY",
      rateLimit: {
        kind: "DECLARED",
        requestsPerMinute: 120,
        onExceeded: "FAIL_CLOSED",
      },
      degradation: { onUnavailable: "FAIL_CLOSED" },
      health: "HEALTHY",
    });
    const remoteRegistration = await app.inject({
      method: "POST",
      url: "/v1/context-fabric/peers",
      headers: {
        ...adminHeaders,
        "idempotency-key": "p2-hostile-remote-peer",
      },
      payload: {
        spaceId,
        peerKey: `integration-hostile-remote-${vaultId.slice(0, 8)}`,
        displayName: "Hostile remote-query fixture",
        endpoint: "http://127.0.0.1:9/unauthorized-object",
        discoveryMode: "REMOTE_QUERY",
        trustState: "APPROVED",
        capabilities: liveCapabilities,
        revision: "peer:remote:r1",
      },
    });
    expect(remoteRegistration.statusCode).toBe(201);
    expect(remoteRegistration.json()).toMatchObject({
      boundary: "DISCOVERY_METADATA_ONLY",
      networkContactPerformed: false,
      peer: {
        discoveryMode: "REMOTE_QUERY",
        trustState: "APPROVED",
      },
    });
    const remotePeerId = String(
      (remoteRegistration.json() as { peer: { id: string } }).peer.id,
    );

    const mirrorPeer = await upsertContextFabricPeer(db, {
      organizationId: organizationId!,
      spaceId,
      peerKey: `integration-mirror-${vaultId.slice(0, 8)}`,
      displayName: "Integration mirrored connector",
      discoveryMode: "MIRROR_BUNDLE",
      trustState: "DISCOVERED",
      capabilities: mirrorCapabilities,
      revision: "peer:mirror:r1",
      lastSeenAt: new Date(),
    });
    const livePeer = await upsertContextFabricPeer(db, {
      organizationId: organizationId!,
      spaceId,
      peerKey: `integration-live-${vaultId.slice(0, 8)}`,
      displayName: "Integration live-reference connector",
      discoveryMode: "CATALOG_ONLY",
      trustState: "DISCOVERED",
      capabilities: liveCapabilities,
      revision: "peer:live:r1",
      lastSeenAt: new Date(),
    });
    peerIds = [remotePeerId, mirrorPeer.id, livePeer.id];
    const peerOutbox = await db.pool.query<{
      organization_id: string;
      space_id: string;
      vault_id: string | null;
      payload: Record<string, unknown>;
    }>(
      `select organization_id,space_id,vault_id,payload from event_outbox
        where event_type='ContextFabricPeerRegistered' and resource_id=$1`,
      [mirrorPeer.id],
    );
    expect(peerOutbox.rows).toHaveLength(1);
    expect(peerOutbox.rows[0]).toMatchObject({
      organization_id: organizationId,
      space_id: spaceId,
      vault_id: null,
      payload: {
        boundary: "DISCOVERY_METADATA_ONLY",
        discoveryMode: "MIRROR_BUNDLE",
        trustState: "DISCOVERED",
      },
    });

    const listedPeers = await app.inject({
      method: "GET",
      url: `/v1/context-fabric/peers?spaceId=${spaceId}`,
      headers,
    });
    expect(listedPeers.statusCode).toBe(200);
    const listedPeerBody = listedPeers.json() as {
      peers: Array<{
        id: string;
        readPlan: {
          primaryRead: string;
          requiresLiveProvider: boolean;
          supportsOfflineRead: boolean;
        };
      }>;
    };
    expect(
      listedPeerBody.peers.find((candidate) => candidate.id === mirrorPeer.id)
        ?.readPlan,
    ).toMatchObject({
      primaryRead: "LOCAL_INDEX",
      requiresLiveProvider: false,
      supportsOfflineRead: true,
    });
    expect(
      listedPeerBody.peers.find((candidate) => candidate.id === livePeer.id)
        ?.readPlan,
    ).toMatchObject({
      primaryRead: "LIVE_REFERENCE",
      requiresLiveProvider: true,
      supportsOfflineRead: false,
    });

    const afterDocuments = await db.pool.query<{ count: number }>(
      "select count(*)::int count from knowledge_documents where vault_id=$1",
      [vaultId],
    );
    expect(afterDocuments.rows[0]?.count).toBe(beforeDocuments.rows[0]?.count);
    const remoteMaterialization = await db.pool.query<{ count: number }>(
      `select count(*)::int count
         from knowledge_documents
        where vault_id=$1
          and (title ilike '%unauthorized-object%'
               or path ilike '%unauthorized-object%')`,
      [vaultId],
    );
    expect(remoteMaterialization.rows[0]?.count).toBe(0);
  });
});
