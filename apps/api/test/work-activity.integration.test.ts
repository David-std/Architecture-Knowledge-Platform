import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const spaceId = "00000000-0000-0000-0000-000000000003";
const actorId = randomUUID();
const outsiderId = randomUUID();
const vaultId = randomUUID();
const otherVaultId = randomUUID();
const token = `work-activity-${randomUUID()}`;
const outsiderToken = `work-activity-outsider-${randomUUID()}`;
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const headers = { authorization: `Bearer ${token}` };
const outsiderHeaders = { authorization: `Bearer ${outsiderToken}` };

let app: FastifyInstance;
let db: Postgres;
let sessionId = "";
let otherSessionId = "";

async function insertToken(userId: string, value: string): Promise<void> {
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,'work activity',$3::jsonb)`,
    [
      userId,
      hash(value),
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
}

async function createVault(id: string, label: string): Promise<void> {
  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,vault_key,
       local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,'work-activity:r1',$5,$3,'PRIVATE',true)`,
    [id, spaceId, `/tmp/${label}-${id}`, label, `${label}-${id.slice(0, 8)}`],
  );
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  db = new Postgres(process.env.DATABASE_URL);
  await createVault(vaultId, "work-activity");
  await createVault(otherVaultId, "work-activity-other");
  await db.pool.query(
    `insert into users(id,email,display_name) values
       ($1,$2,'Work Activity Actor'),($3,$4,'Work Activity Outsider')`,
    [
      actorId,
      `${actorId}@example.test`,
      outsiderId,
      `${outsiderId}@example.test`,
    ],
  );
  await db.pool.query(
    `insert into memberships(user_id,space_id,role,path_prefix) values
       ($1,$3,'CONTRIBUTOR',null),($2,$3,'CONTRIBUTOR',null)`,
    [actorId, outsiderId, spaceId],
  );
  for (const [user, vault] of [
    [actorId, vaultId],
    [actorId, otherVaultId],
    [outsiderId, otherVaultId],
  ] as const) {
    await grantVaultMembership(db, {
      userId: user,
      vaultId: vault,
      role: "VIEWER",
      pathPrefix: null,
      permissions: ["knowledge:read", "source:read"],
    });
  }
  await insertToken(actorId, token);
  await insertToken(outsiderId, outsiderToken);
  const module = await import("../src/server.js");
  app = module.buildServer();
});

afterAll(async () => {
  if (app) await app.close();
  if (!db) return;
  for (const id of [sessionId, otherSessionId].filter(Boolean)) {
    await db.pool.query(
      "delete from audit_events where resource_type='agent_session' and resource_id=$1",
      [id],
    );
    await db.pool.query("delete from agent_sessions where id=$1", [id]);
  }
  await db.pool.query(
    "delete from audit_events where vault_id=any($1::uuid[])",
    [[vaultId, otherVaultId]],
  );
  await db.pool.query(
    "delete from api_tokens where token_hash=any($1::text[])",
    [[hash(token), hash(outsiderToken)]],
  );
  await db.pool.query(
    "delete from vault_memberships where user_id=any($1::uuid[])",
    [[actorId, outsiderId]],
  );
  await db.pool.query(
    "delete from memberships where user_id=any($1::uuid[]) and space_id=$2",
    [[actorId, outsiderId], spaceId],
  );
  await db.pool.query(
    "update vaults set enabled=false where id=any($1::uuid[])",
    [[vaultId, otherVaultId]],
  );
  await db.close();
});

async function newSession(
  vault: string,
  requestHeaders: Record<string, string>,
): Promise<string> {
  const created = await app.inject({
    method: "POST",
    url: "/v1/sessions",
    headers: requestHeaders,
    payload: {
      spaceId,
      vaultId: vault,
      purpose: "Work activity graph fixture",
      contextBudget: 2048,
    },
  });
  expect(created.statusCode).toBe(201);
  return (created.json() as { id: string }).id;
}

async function projectObject(
  session: string,
  objectType: string,
  externalId: string,
  workObjectClass: string | undefined,
): Promise<{ id: string; workObjectClass: string | null }> {
  const response = await app.inject({
    method: "POST",
    url: `/v1/sessions/${session}/external-refs`,
    headers,
    payload: {
      provider: "github",
      objectType,
      externalId,
      authority: "SYSTEM_OF_RECORD",
      ...(workObjectClass ? { workObjectClass } : {}),
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { id: string; workObjectClass: string | null };
}

describe("work and activity graph", () => {
  it("records what happened to authorized work objects and keeps the log append-only", async () => {
    sessionId = await newSession(vaultId, headers);
    const deployment = await projectObject(
      sessionId,
      "workflow_run",
      "deploy-1041",
      "DEPLOYMENT",
    );
    const incident = await projectObject(
      sessionId,
      "issue",
      "INC-77",
      "INCIDENT",
    );
    expect(deployment.workObjectClass).toBe("DEPLOYMENT");
    expect(incident.workObjectClass).toBe("INCIDENT");

    // A reference without a work class stays a plain projection. That is a
    // legitimate thing to store; it is simply not part of the work graph.
    const plain = await projectObject(
      sessionId,
      "gist",
      "scratch-1",
      undefined,
    );
    expect(plain.workObjectClass).toBeNull();

    const unknownClass = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/external-refs`,
      headers,
      payload: {
        provider: "github",
        objectType: "issue",
        externalId: "INC-78",
        workObjectClass: "TICKET_ISH",
      },
    });
    expect(unknownClass.statusCode).toBe(400);
    expect(unknownClass.json()).toMatchObject({
      code: "INVALID_WORK_OBJECT_CLASS",
    });

    const deployed = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/activity`,
      headers,
      payload: {
        objectRefId: deployment.id,
        action: "DEPLOYED",
        occurredAt: "2026-09-17T10:00:00.000Z",
        sourceSystem: "github-actions",
        derivation: "SOURCE_EXPLICIT",
        actorExternalId: "octocat",
        payload: { environment: "production" },
      },
    });
    expect(deployed.statusCode).toBe(201);
    const deployedEvent = deployed.json() as {
      id: string;
      action: string;
      derivation: string;
      actorPrincipalId: string | null;
      actorExternalId: string | null;
    };
    expect(deployedEvent).toMatchObject({
      action: "DEPLOYED",
      derivation: "SOURCE_EXPLICIT",
      actorExternalId: "octocat",
    });
    // The recording principal is always attributed, so an external actor name
    // adds provenance rather than replacing accountability.
    expect(deployedEvent.actorPrincipalId).toBeTruthy();

    // History is not editable. Correcting an observation means recording a
    // later one, which is why the database refuses the update outright.
    await expect(
      db.pool.query(
        "update work_activity_events set action='CLOSED' where id=$1",
        [deployedEvent.id],
      ),
    ).rejects.toThrow(/WORK_ACTIVITY_EVENT_IMMUTABLE/);

    const listed = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/activity?objectRefId=${deployment.id}`,
      headers,
    });
    expect(listed.statusCode).toBe(200);
    expect(
      (listed.json() as { events: Array<{ id: string }> }).events.map(
        (event) => event.id,
      ),
    ).toContain(deployedEvent.id);
  });

  it("refuses to record a causal claim that only correlation supports", async () => {
    const deployment = await projectObject(
      sessionId,
      "workflow_run",
      "deploy-2042",
      "DEPLOYMENT",
    );
    const incident = await projectObject(
      sessionId,
      "issue",
      "INC-99",
      "INCIDENT",
    );

    // Observing that the incident followed the deploy is a real and useful
    // record. It is an ordering, and it is stored as one.
    const observed = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/activity`,
      headers,
      payload: {
        objectRefId: deployment.id,
        targetRefId: incident.id,
        action: "REFERENCED",
        occurredAt: "2026-09-17T10:05:00.000Z",
        sourceSystem: "observability",
        derivation: "OBSERVED_CORRELATION",
        actorExternalId: "correlator",
      },
    });
    expect(observed.statusCode).toBe(201);
    expect(observed.json()).toMatchObject({
      derivation: "OBSERVED_CORRELATION",
    });

    // Asserting that the deploy *caused* the incident is a different claim.
    // Neither an observed ordering nor a model's guess can support it, however
    // often the two co-occur.
    for (const derivation of ["OBSERVED_CORRELATION", "MODEL_INFERRED"]) {
      const refused = await app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/activity`,
        headers,
        payload: {
          objectRefId: deployment.id,
          targetRefId: incident.id,
          action: "CAUSED",
          occurredAt: "2026-09-17T10:06:00.000Z",
          sourceSystem: "observability",
          derivation,
          actorExternalId: "correlator",
        },
      });
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({
        code: "WORK_ACTIVITY_CAUSALITY_UNSUPPORTED",
      });
    }

    // A human who investigated may assert it, and that is recorded as a human
    // assertion rather than as an observation.
    const asserted = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/activity`,
      headers,
      payload: {
        objectRefId: deployment.id,
        targetRefId: incident.id,
        action: "CAUSED",
        occurredAt: "2026-09-17T11:00:00.000Z",
        sourceSystem: "post-incident-review",
        derivation: "HUMAN_ASSERTED",
        actorExternalId: "responder",
        evidenceRefs: ["retro-77"],
      },
    });
    expect(asserted.statusCode).toBe(201);
    expect(asserted.json()).toMatchObject({
      action: "CAUSED",
      derivation: "HUMAN_ASSERTED",
      evidenceRefs: ["retro-77"],
    });

    // The database refuses it too, so the guard does not depend on the route
    // being the only writer.
    await expect(
      db.pool.query(
        `insert into work_activity_events(
           space_id,vault_id,object_ref_id,target_ref_id,action,occurred_at,
           source_system,derivation,actor_external_id
         ) values($1,$2,$3,$4,'CAUSED',now(),'direct','MODEL_INFERRED','bypass')`,
        [spaceId, vaultId, deployment.id, incident.id],
      ),
    ).rejects.toThrow(/causality_requires_support/i);

    // A relational action with nothing to relate to is meaningless.
    const danglingRelation = await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/activity`,
      headers,
      payload: {
        objectRefId: deployment.id,
        action: "LINKED",
        occurredAt: "2026-09-17T11:10:00.000Z",
        sourceSystem: "manual",
        derivation: "HUMAN_ASSERTED",
        actorExternalId: "responder",
      },
    });
    expect(danglingRelation.statusCode).toBe(400);
    expect(danglingRelation.json()).toMatchObject({
      code: "WORK_ACTIVITY_TARGET_REQUIRED",
    });
  });

  it("keeps one vault's work history out of another's", async () => {
    otherSessionId = await newSession(otherVaultId, outsiderHeaders);
    const ours = await projectObject(
      sessionId,
      "issue",
      "PRIVATE-1",
      "WORK_ITEM",
    );
    await app.inject({
      method: "POST",
      url: `/v1/sessions/${sessionId}/activity`,
      headers,
      payload: {
        objectRefId: ours.id,
        action: "COMMENTED",
        occurredAt: "2026-09-17T12:00:00.000Z",
        sourceSystem: "github",
        derivation: "SOURCE_EXPLICIT",
        actorExternalId: "octocat",
      },
    });

    // A session in another vault sees none of it, and cannot reach the object
    // by guessing its id either.
    const otherView = await app.inject({
      method: "GET",
      url: `/v1/sessions/${otherSessionId}/activity`,
      headers: outsiderHeaders,
    });
    expect(otherView.statusCode).toBe(200);
    expect((otherView.json() as { events: unknown[] }).events).toHaveLength(0);

    const crossVaultWrite = await app.inject({
      method: "POST",
      url: `/v1/sessions/${otherSessionId}/activity`,
      headers: outsiderHeaders,
      payload: {
        objectRefId: ours.id,
        action: "COMMENTED",
        occurredAt: "2026-09-17T12:05:00.000Z",
        sourceSystem: "github",
        derivation: "SOURCE_EXPLICIT",
        actorExternalId: "intruder",
      },
    });
    expect(crossVaultWrite.statusCode).toBe(404);
    expect(crossVaultWrite.json()).toMatchObject({
      code: "EXTERNAL_OBJECT_REF_NOT_FOUND",
    });

    // A non-participant cannot read the session's activity at all.
    const nonParticipant = await app.inject({
      method: "GET",
      url: `/v1/sessions/${sessionId}/activity`,
      headers: outsiderHeaders,
    });
    expect(nonParticipant.statusCode).toBe(404);
  });

  it("rejects malformed activity at the boundary", async () => {
    const object = await projectObject(
      sessionId,
      "issue",
      "MALFORMED-1",
      "WORK_ITEM",
    );
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ action: "TELEPORTED" }, "INVALID_WORK_ACTIVITY_ACTION"],
      [{ derivation: "VIBES" }, "INVALID_WORK_ACTIVITY_DERIVATION"],
      [{ occurredAt: "not-a-date" }, "INVALID_WORK_ACTIVITY_TIMESTAMP"],
      [{ sourceSystem: "" }, "INVALID_WORK_ACTIVITY_SOURCE_SYSTEM"],
      [{ objectRefId: "not-a-uuid" }, "INVALID_OBJECT_REF_ID"],
    ];
    for (const [override, code] of cases) {
      const response = await app.inject({
        method: "POST",
        url: `/v1/sessions/${sessionId}/activity`,
        headers,
        payload: {
          objectRefId: object.id,
          action: "COMMENTED",
          occurredAt: "2026-09-17T13:00:00.000Z",
          sourceSystem: "github",
          derivation: "SOURCE_EXPLICIT",
          actorExternalId: "octocat",
          ...override,
        },
      });
      expect(response.statusCode, code).toBe(400);
      expect(response.json()).toMatchObject({ code });
    }
  });
});
