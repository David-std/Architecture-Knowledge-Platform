import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Postgres,
  appendAssuranceFindings,
  cancelAssuranceRun,
  claimNextAssuranceRun,
  completeAssuranceRun,
  submitAssuranceRun,
} from "../src/index.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

describeDb("continuous assurance durable runs", () => {
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
        `assurance-${organizationId.slice(0, 8)}`,
        "Assurance test",
      ],
    );
    await db.pool.query(
      `insert into spaces(
         id,organization_id,slug,name,visibility,knowledge_repo_path
       ) values($1,$2,$3,$4,'PRIVATE',$5)`,
      [
        spaceId,
        organizationId,
        `assurance-${spaceId.slice(0, 8)}`,
        "Assurance test",
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
        `test/assurance/${vaultId}`,
        "Assurance vault",
        `assurance-${vaultId}`,
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

  it("deduplicates submission and fences an expired worker", async () => {
    const first = await submitAssuranceRun(db, {
      spaceId,
      vaultId,
      trigger: "MANUAL",
      detectors: ["FRESHNESS", "CONTRADICTION"],
      idempotencyKey: "same-request",
      maxAttempts: 3,
    });
    const duplicate = await submitAssuranceRun(db, {
      spaceId,
      vaultId,
      trigger: "MANUAL",
      detectors: ["FRESHNESS", "CONTRADICTION"],
      idempotencyKey: "same-request",
      maxAttempts: 3,
    });
    expect(duplicate.id).toBe(first.id);

    const workerA = await claimNextAssuranceRun(db, "worker-a", 60);
    expect(workerA?.id).toBe(first.id);
    expect(workerA?.leaseToken).toBe(1);

    await db.pool.query(
      "update assurance_runs set lease_expires_at=now()-interval '1 second' where id=$1",
      [first.id],
    );
    const workerB = await claimNextAssuranceRun(db, "worker-b", 60);
    expect(workerB?.id).toBe(first.id);
    expect(workerB?.leaseToken).toBe(2);

    await expect(
      appendAssuranceFindings(db, {
        runId: first.id,
        workerId: "worker-a",
        leaseToken: 1,
        spaceId,
        vaultId,
        findings: [
          {
            detector: "FRESHNESS",
            severity: "WARN",
            code: "STALE_KNOWLEDGE",
            subjectKind: "document",
            subjectId: "doc-a",
            summary: "Document is stale.",
            evidenceRefs: [],
            metadata: {},
          },
        ],
      }),
    ).rejects.toThrow("ASSURANCE_RUN_FENCED");

    expect(
      await appendAssuranceFindings(db, {
        runId: first.id,
        workerId: "worker-b",
        leaseToken: 2,
        spaceId,
        vaultId,
        findings: [
          {
            detector: "FRESHNESS",
            severity: "WARN",
            code: "STALE_KNOWLEDGE",
            subjectKind: "document",
            subjectId: "doc-a",
            summary: "Document is stale.",
            evidenceRefs: [],
            metadata: {},
          },
        ],
      }),
    ).toBe(1);

    expect(await cancelAssuranceRun(db, first.id)).toBe(true);
    expect(
      await completeAssuranceRun(db, {
        runId: first.id,
        workerId: "worker-b",
        leaseToken: 2,
        summary: {},
      }),
    ).toBe(false);
  });
});
