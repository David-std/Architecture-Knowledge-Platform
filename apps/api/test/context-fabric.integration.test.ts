import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
    await db.pool.query(
      `delete from audit_events
        where actor_id=any($1::uuid[])
           or ($2::text<>'' and (resource_id=$2 or metadata->>'sessionId'=$2))`,
      [[actorId, adminId], sessionId],
    );
    if (sessionId) {
      await db.pool.query("delete from agent_sessions where id=$1", [
        sessionId,
      ]);
    }
    await db.pool.query(
      "delete from idempotency_records where actor_id=any($1::uuid[])",
      [[actorId, adminId]],
    );
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
        credentialRef: "AKP_TEST_FEDERATION_PEER_TOKEN",
      },
    });
    expect(remoteRegistration.statusCode).toBe(201);
    expect(remoteRegistration.json()).toMatchObject({
      boundary: "DISCOVERY_METADATA_ONLY",
      networkContactPerformed: false,
      peer: {
        discoveryMode: "REMOTE_QUERY",
        contextApiVersion: 1,
        trustState: "APPROVED",
      },
    });
    const remoteRegistrationBody = remoteRegistration.json() as {
      peer: { id: string };
    };
    expect(remoteRegistrationBody.peer).not.toHaveProperty("credentialRef");
    const remotePeerId = String(remoteRegistrationBody.peer.id);

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
        contextApiVersion: 1,
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

    const revokedPeer = await app.inject({
      method: "POST",
      url: `/v1/context-fabric/peers/${remotePeerId}/revoke`,
      headers: {
        ...adminHeaders,
        "idempotency-key": "p11-revoke-remote-peer",
      },
    });
    expect(revokedPeer.statusCode).toBe(200);
    expect(revokedPeer.json()).toMatchObject({
      revoked: true,
      peer: {
        id: remotePeerId,
        trustState: "DISABLED",
      },
    });
    expect(
      (revokedPeer.json() as { peer: Record<string, unknown> }).peer,
    ).not.toHaveProperty("credentialRef");
    const revokedState = await db.pool.query<{
      trust_state: string;
      credential_ref: string | null;
    }>(
      "select trust_state,credential_ref from context_fabric_peers where id=$1",
      [remotePeerId],
    );
    expect(revokedState.rows[0]).toEqual({
      trust_state: "DISABLED",
      credential_ref: null,
    });
    const revokedOutbox = await db.pool.query<{ count: number }>(
      `select count(*)::int count from event_outbox
        where event_type='ContextFabricPeerRevoked' and resource_id=$1`,
      [remotePeerId],
    );
    expect(revokedOutbox.rows[0]?.count).toBe(1);

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

  it("fails closed when a peer over-returns a hit outside the requested vault scope", async () => {
    const organization = await db.pool.query<{ organization_id: string }>(
      "select organization_id from spaces where id=$1",
      [spaceId],
    );
    const organizationId = organization.rows[0]?.organization_id;
    if (!organizationId) {
      throw new Error("FEDERATION_TEST_ORGANIZATION_MISSING");
    }

    const previousClaim = await db.pool.query<{
      node_id: string;
      deployment_mode: string;
      claimed_at: Date;
      last_seen_at: Date;
      adopted_from: string | null;
    }>(
      `select node_id,deployment_mode,claimed_at,last_seen_at,adopted_from
         from context_fabric_node_claim where singleton=true`,
    );
    await db.pool.query(
      `insert into context_fabric_node_claim(
         singleton,node_id,deployment_mode,claimed_at,last_seen_at,adopted_from
       ) values(true,'integration-federation-node','FEDERATED_ORG',now(),now(),null)
       on conflict(singleton) do update
         set node_id=excluded.node_id,
             deployment_mode=excluded.deployment_mode,
             last_seen_at=now(),
             adopted_from=null`,
    );

    const capabilities = ConnectorCapabilities.parse({
      schemaVersion: 1,
      accessMode: "REFERENCE_LIVE",
      permissionFidelity: "SOURCE_ACL_EXACT",
      syncFidelity: "APPEND",
      incrementalSync: false,
      deletionPropagation: "NONE",
      cursorOrWebhook: false,
      sourceAuthority: "REFERENCE",
      writeBack: "NONE",
      identityMapping: "EXACT",
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
    const credentialRef = "AKP_TEST_FEDERATION_OVERRETURN_TOKEN";
    const peer = await upsertContextFabricPeer(db, {
      organizationId,
      spaceId,
      peerKey: `overreturn-peer-${randomUUID()}`,
      displayName: "Federation over-return fixture",
      endpoint: "https://peer-overreturn.example.test",
      discoveryMode: "REMOTE_QUERY",
      trustState: "APPROVED",
      capabilities,
      revision: "peer:overreturn:r1",
      credentialRef,
      lastSeenAt: new Date(),
    });
    peerIds.push(peer.id);
    const previousToken = process.env[credentialRef];
    process.env[credentialRef] = "integration-overreturn-token";
    const rogueVaultId = randomUUID();
    const rogueDocumentId = randomUUID();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_input, init) => {
        const remoteRequest = JSON.parse(String(init?.body)) as {
          caller: { requestId: string };
          scope: { spaceId: string; vaultIds: string[] };
        };
        return new Response(
          JSON.stringify({
            schemaVersion: 1,
            requestId: remoteRequest.caller.requestId,
            remote: {
              nodeId: peer.peerKey,
              deploymentMode: "FEDERATED_ORG",
              revision: "peer:overreturn:r1",
            },
            scope: remoteRequest.scope,
            partial: false,
            stale: false,
            warnings: [],
            indexRevisions: {},
            hits: [
              {
                documentId: rogueDocumentId,
                vaultId: rogueVaultId,
                document: {
                  externalId: "unauthorized-object",
                  path: "private/unauthorized-object.md",
                  title: "Unauthorized over-return",
                },
                revision: "rogue:r1",
                title: "Unauthorized over-return",
                type: "note",
                trust: "HUMAN_REVIEWED",
                lifecycle: "ACTIVE",
                refreshStatus: "CURRENT",
                score: 1,
                reasons: ["remote-over-return"],
                excerpt:
                  "This hit is structurally valid but outside the requested vault.",
                citations: [],
                remoteProvenance: {
                  nodeId: peer.peerKey,
                  nodeRevision: "peer:overreturn:r1",
                  documentRevision: "rogue:r1",
                  trust: "HUMAN_REVIEWED",
                  lifecycle: "ACTIVE",
                },
              },
            ],
            noAnswer: null,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      });

    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/context-fabric/peers/${peer.id}/query`,
        headers,
        payload: {
          schemaVersion: 1,
          scope: { spaceId, vaultIds: [vaultId] },
          request: { query: "federation over-return probe" },
          budget: {
            maxResults: 5,
            maxWallMs: 5_000,
            maxResponseBytes: 32_768,
          },
          revisionPreferences: [],
        },
      });
      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({
        code: "FEDERATION_PEER_SCOPE_OVERRETURN",
      });
      expect(fetchMock).toHaveBeenCalledOnce();

      const health = await db.pool.query<{
        failure_count: number;
        last_failure_code: string | null;
      }>(
        `select failure_count,last_failure_code
           from context_fabric_peers where id=$1`,
        [peer.id],
      );
      expect(health.rows[0]).toMatchObject({
        failure_count: 1,
        last_failure_code: "FEDERATION_PEER_SCOPE_OVERRETURN",
      });
    } finally {
      fetchMock.mockRestore();
      if (previousToken === undefined) delete process.env[credentialRef];
      else process.env[credentialRef] = previousToken;
      const prior = previousClaim.rows[0];
      if (prior) {
        await db.pool.query(
          `update context_fabric_node_claim
              set node_id=$1,deployment_mode=$2,claimed_at=$3,last_seen_at=$4,
                  adopted_from=$5
            where singleton=true`,
          [
            prior.node_id,
            prior.deployment_mode,
            prior.claimed_at,
            prior.last_seen_at,
            prior.adopted_from,
          ],
        );
      } else {
        await db.pool.query(
          "delete from context_fabric_node_claim where singleton=true",
        );
      }
    }
  });

  it("returns explicit partial fanout and opens the dead-peer circuit without another network call", async () => {
    const organization = await db.pool.query<{ organization_id: string }>(
      "select organization_id from spaces where id=$1",
      [spaceId],
    );
    const organizationId = organization.rows[0]?.organization_id;
    if (!organizationId)
      throw new Error("FEDERATION_TEST_ORGANIZATION_MISSING");

    const previousClaim = await db.pool.query<{
      node_id: string;
      deployment_mode: string;
      claimed_at: Date;
      last_seen_at: Date;
      adopted_from: string | null;
    }>(
      `select node_id,deployment_mode,claimed_at,last_seen_at,adopted_from
         from context_fabric_node_claim where singleton=true`,
    );
    await db.pool.query(
      `insert into context_fabric_node_claim(
         singleton,node_id,deployment_mode,claimed_at,last_seen_at,adopted_from
       ) values(true,'integration-federation-node','FEDERATED_ORG',now(),now(),null)
       on conflict(singleton) do update
         set node_id=excluded.node_id,
             deployment_mode=excluded.deployment_mode,
             last_seen_at=now(),
             adopted_from=null`,
    );

    const capability = ConnectorCapabilities.parse({
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

    const successCredentialRef = "AKP_TEST_FEDERATION_SUCCESS_TOKEN";
    const timeoutCredentialRef = "AKP_TEST_FEDERATION_TIMEOUT_TOKEN";
    const deniedCredentialRef = "AKP_TEST_FEDERATION_DENIED_TOKEN";
    const successPeer = await upsertContextFabricPeer(db, {
      organizationId,
      spaceId,
      peerKey: `success-peer-${randomUUID()}`,
      displayName: "Federation success fixture",
      endpoint: "https://peer-success.example.test",
      discoveryMode: "REMOTE_QUERY",
      trustState: "APPROVED",
      capabilities: capability,
      revision: "peer:success:r1",
      credentialRef: successCredentialRef,
      lastSeenAt: new Date(),
    });
    const timeoutPeer = await upsertContextFabricPeer(db, {
      organizationId,
      spaceId,
      peerKey: `timeout-peer-${randomUUID()}`,
      displayName: "Federation timeout fixture",
      endpoint: "https://peer-timeout.example.test",
      discoveryMode: "REMOTE_QUERY",
      trustState: "APPROVED",
      capabilities: capability,
      revision: "peer:timeout:r1",
      credentialRef: timeoutCredentialRef,
      lastSeenAt: new Date(),
    });
    const deniedPeer = await upsertContextFabricPeer(db, {
      organizationId,
      spaceId,
      peerKey: `denied-peer-${randomUUID()}`,
      displayName: "Federation unauthorized fixture",
      endpoint: "https://peer-denied.example.test",
      discoveryMode: "REMOTE_QUERY",
      trustState: "APPROVED",
      capabilities: capability,
      revision: "peer:denied:r1",
      credentialRef: deniedCredentialRef,
      lastSeenAt: new Date(),
    });
    peerIds.push(successPeer.id, timeoutPeer.id, deniedPeer.id);

    const previousTokens = new Map(
      [successCredentialRef, timeoutCredentialRef, deniedCredentialRef].map(
        (name) => [name, process.env[name]] as const,
      ),
    );
    process.env[successCredentialRef] = "integration-success-token";
    process.env[timeoutCredentialRef] = "integration-timeout-token";
    process.env[deniedCredentialRef] = "integration-denied-token";

    const hostCalls = new Map<string, number>();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const hostname = new URL(String(input)).hostname;
        hostCalls.set(hostname, (hostCalls.get(hostname) ?? 0) + 1);

        if (hostname === "peer-success.example.test") {
          const remoteRequest = JSON.parse(String(init?.body)) as {
            caller: { requestId: string };
            scope: { spaceId: string; vaultIds: string[] };
          };
          return new Response(
            JSON.stringify({
              schemaVersion: 1,
              requestId: remoteRequest.caller.requestId,
              remote: {
                nodeId: successPeer.peerKey,
                deploymentMode: "FEDERATED_ORG",
                revision: "peer:success:r1",
              },
              scope: remoteRequest.scope,
              partial: false,
              stale: false,
              warnings: [],
              indexRevisions: {},
              hits: [],
              noAnswer: null,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }

        if (hostname === "peer-denied.example.test") {
          return new Response("forbidden", { status: 403 });
        }

        if (hostname === "peer-timeout.example.test") {
          const signal = init?.signal;
          await new Promise<never>((_resolve, reject) => {
            const abort = () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            };
            if (signal?.aborted) {
              abort();
              return;
            }
            signal?.addEventListener("abort", abort, { once: true });
          });
        }

        throw new Error(`UNEXPECTED_FEDERATION_TEST_HOST:${hostname}`);
      });

    const peerQuery = (query: string) => ({
      schemaVersion: 1,
      scope: { spaceId, vaultIds: [vaultId] },
      request: { query },
      budget: {
        maxResults: 5,
        maxWallMs: 100,
        maxResponseBytes: 4096,
      },
      revisionPreferences: [],
    });

    try {
      const fanout = await app.inject({
        method: "POST",
        url: "/v1/context-fabric/federation/fanout",
        headers,
        payload: {
          schemaVersion: 1,
          local: {
            query: "federation partial fanout probe",
            spaceId,
            vaultIds: [vaultId],
            mode: "SOURCE_BACKED",
            limit: 5,
          },
          peers: [
            { peerId: successPeer.id, query: peerQuery("success peer") },
            { peerId: timeoutPeer.id, query: peerQuery("timeout peer") },
            { peerId: deniedPeer.id, query: peerQuery("denied peer") },
          ],
          requireAllPeers: false,
        },
      });
      expect(fanout.statusCode, fanout.body).toBe(200);
      expect(fanout.json()).toMatchObject({
        schemaVersion: 1,
        partial: true,
        remotes: [
          {
            peerId: successPeer.id,
            response: {
              remote: { nodeId: successPeer.peerKey },
              partial: false,
              stale: false,
            },
          },
        ],
        failures: [
          { peerId: timeoutPeer.id, code: "FEDERATION_PEER_TIMEOUT" },
          { peerId: deniedPeer.id, code: "FEDERATION_PEER_HTTP_403" },
        ],
      });
      expect(hostCalls.get("peer-success.example.test")).toBe(1);
      expect(hostCalls.get("peer-timeout.example.test")).toBe(1);
      expect(hostCalls.get("peer-denied.example.test")).toBe(1);

      const wrongSpace = await app.inject({
        method: "POST",
        url: `/v1/context-fabric/peers/${successPeer.id}/query`,
        headers,
        payload: {
          ...peerQuery("must not disclose another space"),
          scope: { spaceId: randomUUID(), vaultIds: [vaultId] },
        },
      });
      expect(wrongSpace.statusCode).toBe(403);
      expect(wrongSpace.json()).toEqual({
        code: "FEDERATION_PEER_SCOPE_DENIED",
      });
      expect(hostCalls.get("peer-success.example.test")).toBe(1);

      await db.pool.query(
        "update context_fabric_peers set context_api_version=2 where id=$1",
        [successPeer.id],
      );
      const incompatibleVersion = await app.inject({
        method: "POST",
        url: `/v1/context-fabric/peers/${successPeer.id}/query`,
        headers,
        payload: peerQuery("must not call an incompatible peer version"),
      });
      expect(incompatibleVersion.statusCode).toBe(409);
      expect(incompatibleVersion.json()).toEqual({
        code: "FEDERATION_PEER_SCHEMA_UNSUPPORTED",
        peerContextApiVersion: 2,
        supportedSchemaVersions: [1],
      });
      expect(hostCalls.get("peer-success.example.test")).toBe(1);
      await db.pool.query(
        "update context_fabric_peers set context_api_version=1 where id=$1",
        [successPeer.id],
      );

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const timeout = await app.inject({
          method: "POST",
          url: `/v1/context-fabric/peers/${timeoutPeer.id}/query`,
          headers,
          payload: peerQuery(`circuit timeout ${attempt + 1}`),
        });
        expect(timeout.statusCode).toBe(504);
        expect(timeout.json()).toEqual({ code: "FEDERATION_PEER_TIMEOUT" });
      }
      expect(hostCalls.get("peer-timeout.example.test")).toBe(3);

      const circuitOpen = await app.inject({
        method: "POST",
        url: `/v1/context-fabric/peers/${timeoutPeer.id}/query`,
        headers,
        payload: peerQuery("must be blocked by open circuit"),
      });
      expect(circuitOpen.statusCode).toBe(503);
      expect(circuitOpen.json()).toMatchObject({
        code: "FEDERATION_PEER_CIRCUIT_OPEN",
      });
      expect(hostCalls.get("peer-timeout.example.test")).toBe(3);

      const health = await db.pool.query<{
        failure_count: number;
        last_failure_code: string | null;
        circuit_open_until: Date | null;
      }>(
        `select failure_count,last_failure_code,circuit_open_until
           from context_fabric_peers where id=$1`,
        [timeoutPeer.id],
      );
      expect(health.rows[0]).toMatchObject({
        failure_count: 3,
        last_failure_code: "FEDERATION_PEER_TIMEOUT",
      });
      expect(health.rows[0]?.circuit_open_until).toBeInstanceOf(Date);
    } finally {
      fetchMock.mockRestore();
      for (const [name, value] of previousTokens) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      const prior = previousClaim.rows[0];
      if (prior) {
        await db.pool.query(
          `update context_fabric_node_claim
              set node_id=$1,deployment_mode=$2,claimed_at=$3,last_seen_at=$4,
                  adopted_from=$5
            where singleton=true`,
          [
            prior.node_id,
            prior.deployment_mode,
            prior.claimed_at,
            prior.last_seen_at,
            prior.adopted_from,
          ],
        );
      } else {
        await db.pool.query(
          "delete from context_fabric_node_claim where singleton=true",
        );
      }
    }
  });
});
