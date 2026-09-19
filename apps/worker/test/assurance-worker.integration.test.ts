import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMPLEMENTED_ASSURANCE_DETECTORS } from "@akp/domain";
import {
  Postgres,
  appendSourceConnectorEvent,
  applyNextSourceConnectorEvent,
  claimNextAssuranceRun,
  registerSourceConnector,
  submitAssuranceRun,
} from "@akp/postgres";
import { runClaimedAssuranceRun } from "../src/assurance-worker.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describeDb("continuous assurance detector execution", () => {
  let db: Postgres;
  const organizationId = randomUUID();
  const spaceId = randomUUID();
  const vaultId = randomUUID();

  beforeAll(async () => {
    db = new Postgres(databaseUrl!);
    await db.pool.query(
      "insert into organizations(id,slug,name) values($1,$2,$3)",
      [
        organizationId,
        `assurance-worker-${organizationId.slice(0, 8)}`,
        "Assurance worker integration",
      ],
    );
    await db.pool.query(
      `insert into spaces(
         id,organization_id,slug,name,visibility,knowledge_repo_path
       ) values($1,$2,$3,$4,'PRIVATE',$5)`,
      [
        spaceId,
        organizationId,
        `assurance-worker-${spaceId.slice(0, 8)}`,
        "Assurance worker integration",
        `test/${spaceId}`,
      ],
    );
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path
       ) values($1,$2,$3,$4,true,'rev-1',$5,$3)`,
      [
        vaultId,
        spaceId,
        `test/assurance-worker/${vaultId}`,
        "Assurance worker vault",
        `assurance-worker-${vaultId}`,
      ],
    );
  });

  afterAll(async () => {
    if (!db) return;
    await db.pool.query("delete from vaults where id=$1", [vaultId]);
    await db.pool.query("delete from spaces where id=$1", [spaceId]);
    await db.pool.query("delete from organizations where id=$1", [
      organizationId,
    ]);
    await db.close();
  });

  it("executes every implemented detector against the live schema", async () => {
    const run = await submitAssuranceRun(db, {
      spaceId,
      vaultId,
      trigger: "MANUAL",
      detectors: [...IMPLEMENTED_ASSURANCE_DETECTORS],
      idempotencyKey: `all-detectors-${randomUUID()}`,
      maxAttempts: 1,
    });
    const workerId = `assurance-detector-smoke-${randomUUID()}`;
    const claimed = await claimNextAssuranceRun(db, workerId, 60, {
      runId: run.id,
    });
    expect(claimed?.id).toBe(run.id);
    if (!claimed) throw new Error("expected assurance run claim");

    await expect(runClaimedAssuranceRun(db, claimed, workerId)).resolves.toBe(
      "COMPLETED",
    );

    const stored = await db.pool.query<{
      status: string;
      cursor: { detectorIndex?: number };
      result_summary: {
        detectorCounts?: Record<string, number>;
        supportedDetectors?: string[];
      };
    }>(
      `select status,cursor,result_summary
         from assurance_runs
        where id=$1`,
      [run.id],
    );
    expect(stored.rows[0]?.status).toBe("COMPLETED");
    expect(stored.rows[0]?.cursor.detectorIndex).toBe(
      IMPLEMENTED_ASSURANCE_DETECTORS.length,
    );
    expect(stored.rows[0]?.result_summary.supportedDetectors).toEqual([
      ...IMPLEMENTED_ASSURANCE_DETECTORS,
    ]);
    for (const detector of IMPLEMENTED_ASSURANCE_DETECTORS) {
      expect(
        stored.rows[0]?.result_summary.detectorCounts?.[detector],
        detector,
      ).toBe(0);
    }
  });

  it("reports connector freshness and ACL drift, then catches a damaged deletion projection", async () => {
    const connector = await registerSourceConnector(db, {
      spaceId,
      vaultId,
      connectorKey: `assurance-connector-${randomUUID()}`,
      sourceSystem: "assurance-fixture",
      publicKeyPem:
        "-----BEGIN PUBLIC KEY-----\nCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC=\n-----END PUBLIC KEY-----",
      descriptor: {
        schemaVersion: 1,
        sourceSystem: "assurance-fixture",
        objectTypes: ["WORK_ITEM"],
        incremental: { cursor: false, webhook: true },
        permissionFidelity: "SOURCE_ACL_EXACT",
        replication: "FULL_MIRROR",
        dataResidency: "LOCAL",
        attachments: { supported: false },
        rateLimit: { kind: "NONE" },
        deletionPropagation: "TOMBSTONE",
        sourceVersioning: true,
        freshnessSlaSeconds: 60,
        contentTrust: "UNTRUSTED_EXTERNAL",
      },
    });
    const connectorId = String(connector.id);
    const oldOccurredAt = new Date(Date.now() - 3_600_000).toISOString();

    await appendSourceConnectorEvent(db, {
      connectorId,
      eventId: `acl-event-${randomUUID()}`,
      sequence: 1,
      occurredAt: oldOccurredAt,
      operation: "UPSERT",
      objectId: "ticket-assurance",
      objectType: "WORK_ITEM",
      sourceVersion: "v1",
      title: "Connector assurance fixture",
      content: "External untrusted work item.",
      contentType: "text/plain",
      permissionFidelity: "NONE",
      permissionUncertain: true,
      metadata: {},
      payloadHash: sha256("acl-event-v1"),
    });
    expect(await applyNextSourceConnectorEvent(db)).toMatchObject({
      connectorId,
      sequence: 1,
      operation: "UPSERT",
    });

    const firstRun = await db.pool.query<{ id: string }>(
      `select id
         from assurance_runs
        where space_id=$1 and vault_id=$2
          and idempotency_key=$3
          and trigger='CONNECTOR_EVENT'`,
      [spaceId, vaultId, `connector-event:${connectorId}:1`],
    );
    const firstRunId = firstRun.rows[0]?.id;
    expect(firstRunId).toBeTruthy();
    if (!firstRunId) throw new Error("expected automatic connector assurance");

    const firstWorker = `connector-assurance-${randomUUID()}`;
    const firstClaim = await claimNextAssuranceRun(db, firstWorker, 60, {
      runId: firstRunId,
    });
    expect(firstClaim?.id).toBe(firstRunId);
    if (!firstClaim) throw new Error("expected connector assurance run");

    await expect(
      runClaimedAssuranceRun(db, firstClaim, firstWorker),
    ).resolves.toBe("COMPLETED");

    const firstFindings = await db.pool.query<{
      detector: string;
      code: string;
      severity: string;
    }>(
      `select detector,code,severity
         from assurance_findings
        where run_id=$1
        order by detector,code`,
      [firstRunId],
    );
    expect(firstFindings.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detector: "CONNECTOR_FRESHNESS",
          code: "CONNECTOR_FRESHNESS_SLA_EXCEEDED",
          severity: "HIGH",
        }),
        expect.objectContaining({
          detector: "CONNECTOR_ACL_DRIFT",
          code: "CONNECTOR_ACL_UNCERTAIN",
          severity: "HIGH",
        }),
      ]),
    );
    expect(
      firstFindings.rows.some(
        (finding) => finding.detector === "CONNECTOR_DELETION",
      ),
    ).toBe(false);

    await appendSourceConnectorEvent(db, {
      connectorId,
      eventId: `delete-event-${randomUUID()}`,
      sequence: 2,
      occurredAt: new Date().toISOString(),
      operation: "DELETE",
      objectId: "ticket-assurance",
      objectType: "WORK_ITEM",
      sourceVersion: "v2",
      permissionFidelity: "SOURCE_ACL_EXACT",
      permissionUncertain: false,
      aclFingerprint: "acl-v2",
      metadata: { deleted: true },
      payloadHash: sha256("delete-event-v2"),
    });
    expect(await applyNextSourceConnectorEvent(db)).toMatchObject({
      connectorId,
      sequence: 2,
      operation: "DELETE",
    });

    await db.pool.query(
      `update source_connector_objects
          set lifecycle='ACTIVE',updated_at=now()
        where connector_id=$1 and object_id='ticket-assurance'`,
      [connectorId],
    );

    const deletionRun = await db.pool.query<{ id: string }>(
      `select id
         from assurance_runs
        where space_id=$1 and vault_id=$2
          and idempotency_key=$3
          and trigger='CONNECTOR_EVENT'`,
      [spaceId, vaultId, `connector-event:${connectorId}:2`],
    );
    const deletionRunId = deletionRun.rows[0]?.id;
    expect(deletionRunId).toBeTruthy();
    if (!deletionRunId) {
      throw new Error("expected automatic deletion assurance");
    }

    const deletionWorker = `connector-deletion-${randomUUID()}`;
    const deletionClaim = await claimNextAssuranceRun(db, deletionWorker, 60, {
      runId: deletionRunId,
    });
    expect(deletionClaim?.id).toBe(deletionRunId);
    if (!deletionClaim) throw new Error("expected connector deletion run");

    await expect(
      runClaimedAssuranceRun(db, deletionClaim, deletionWorker),
    ).resolves.toBe("COMPLETED");

    const deletionFinding = await db.pool.query<{
      detector: string;
      code: string;
      severity: string;
    }>(
      `select detector,code,severity
         from assurance_findings
        where run_id=$1 and detector='CONNECTOR_DELETION'`,
      [deletionRunId],
    );
    expect(deletionFinding.rows[0]).toMatchObject({
      detector: "CONNECTOR_DELETION",
      code: "CONNECTOR_DELETE_NOT_TOMBSTONED",
      severity: "CRITICAL",
    });
  });
});
