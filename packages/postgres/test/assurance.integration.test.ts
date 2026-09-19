import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  Postgres,
  appendAssuranceFindings,
  cancelAssuranceRun,
  claimNextAssuranceRun,
  completeAssuranceRun,
  renewAssuranceRunLease,
  submitAssuranceRun,
  transitionAssuranceFindingStatus,
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

    const workerA = await claimNextAssuranceRun(db, "worker-a", 60, {
      runId: first.id,
    });
    expect(workerA?.id).toBe(first.id);
    expect(workerA?.leaseToken).toBe(1);

    await db.pool.query(
      "update assurance_runs set lease_expires_at=now()-interval '1 second' where id=$1",
      [first.id],
    );
    const workerB = await claimNextAssuranceRun(db, "worker-b", 60, {
      runId: first.id,
    });
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
            detectorVersion: "1.0.0",
            severity: "MEDIUM",
            category: "FRESHNESS",
            scopeId: vaultId,
            targetIds: ["doc-a"],
            evidenceIds: [],
            code: "STALE_KNOWLEDGE",
            summary: "Document is stale.",
            proposedAction: "RECOMPILE",
            metadata: { subjectKind: "document" },
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
            detectorVersion: "1.0.0",
            severity: "MEDIUM",
            category: "FRESHNESS",
            scopeId: vaultId,
            targetIds: ["doc-a"],
            evidenceIds: [],
            code: "STALE_KNOWLEDGE",
            summary: "Document is stale.",
            proposedAction: "RECOMPILE",
            metadata: { subjectKind: "document" },
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

  it("deduplicates identical findings across runs and preserves false-positive lifecycle", async () => {
    const firstRun = await submitAssuranceRun(db, {
      spaceId,
      vaultId,
      trigger: "MANUAL",
      detectors: ["FRESHNESS"],
      idempotencyKey: `finding-dedupe-a-${randomUUID()}`,
      maxAttempts: 1,
    });
    const firstWorker = `finding-dedupe-a-${randomUUID()}`;
    const firstClaim = await claimNextAssuranceRun(db, firstWorker, 60, {
      runId: firstRun.id,
    });
    if (!firstClaim) throw new Error("expected first finding run");
    const draft = {
      detector: "FRESHNESS" as const,
      detectorVersion: "1.0.0",
      severity: "MEDIUM" as const,
      category: "FRESHNESS",
      scopeId: vaultId,
      targetIds: ["persistent-doc"],
      evidenceIds: [],
      code: "STALE_KNOWLEDGE",
      summary: "Persistent stale knowledge.",
      proposedAction: "RECOMPILE",
      metadata: { subjectKind: "knowledge_document" },
    };
    expect(
      await appendAssuranceFindings(db, {
        runId: firstRun.id,
        workerId: firstWorker,
        leaseToken: firstClaim.leaseToken,
        spaceId,
        vaultId,
        findings: [draft],
      }),
    ).toBe(1);
    expect(
      await completeAssuranceRun(db, {
        runId: firstRun.id,
        workerId: firstWorker,
        leaseToken: firstClaim.leaseToken,
        summary: {},
      }),
    ).toBe(true);

    const persisted = await db.pool.query<{
      id: string;
      first_seen_at: Date | string;
      last_seen_at: Date | string;
      status: string;
    }>(
      `select id,first_seen_at,last_seen_at,status
         from assurance_findings
        where space_id=$1 and vault_id=$2 and code='STALE_KNOWLEDGE'
          and target_ids @> '["persistent-doc"]'::jsonb`,
      [spaceId, vaultId],
    );
    const finding = persisted.rows[0];
    expect(finding?.status).toBe("OPEN");
    if (!finding) throw new Error("expected persistent finding");

    await transitionAssuranceFindingStatus(db, {
      findingId: finding.id,
      spaceId,
      vaultId,
      status: "FALSE_POSITIVE",
      reason: "Reviewed fixture false positive.",
    });

    const secondRun = await submitAssuranceRun(db, {
      spaceId,
      vaultId,
      trigger: "SCHEDULED",
      detectors: ["FRESHNESS"],
      idempotencyKey: `finding-dedupe-b-${randomUUID()}`,
      maxAttempts: 1,
    });
    const secondWorker = `finding-dedupe-b-${randomUUID()}`;
    const secondClaim = await claimNextAssuranceRun(db, secondWorker, 60, {
      runId: secondRun.id,
    });
    if (!secondClaim) throw new Error("expected second finding run");
    expect(
      await appendAssuranceFindings(db, {
        runId: secondRun.id,
        workerId: secondWorker,
        leaseToken: secondClaim.leaseToken,
        spaceId,
        vaultId,
        findings: [{ ...draft, severity: "HIGH" }],
      }),
    ).toBe(1);

    const after = await db.pool.query<{
      count: number;
      status: string;
      run_id: string;
      first_seen_at: Date | string;
      last_seen_at: Date | string;
    }>(
      `select count(*) over()::int count,status,run_id,first_seen_at,last_seen_at
         from assurance_findings
        where id=$1`,
      [finding.id],
    );
    expect(after.rows[0]).toMatchObject({
      count: 1,
      status: "FALSE_POSITIVE",
      run_id: secondRun.id,
    });
    expect(
      new Date(String(after.rows[0]?.last_seen_at)).getTime(),
    ).toBeGreaterThanOrEqual(
      new Date(String(finding.last_seen_at)).getTime(),
    );

    const history = await db.pool.query<{ action: string }>(
      `select action
         from assurance_finding_events
        where finding_id=$1
        order by id`,
      [finding.id],
    );
    expect(history.rows.map((row) => row.action)).toEqual([
      "DETECTED",
      "FALSE_POSITIVE",
    ]);

    expect(await cancelAssuranceRun(db, secondRun.id)).toBe(true);
  });

  it("preserves the persisted detector cursor across lease expiry and reclaim", async () => {
    const run = await submitAssuranceRun(db, {
      spaceId,
      vaultId,
      trigger: "MANUAL",
      detectors: ["FRESHNESS", "CONTRADICTION"],
      idempotencyKey: `resume-${randomUUID()}`,
      maxAttempts: 3,
    });

    const workerA = `resume-a-${randomUUID()}`;
    const first = await claimNextAssuranceRun(db, workerA, 60, {
      runId: run.id,
    });
    expect(first?.id).toBe(run.id);
    if (!first) throw new Error("expected resumable assurance run");

    expect(
      await renewAssuranceRunLease(db, {
        runId: run.id,
        workerId: workerA,
        leaseToken: first.leaseToken,
        cursor: {
          detectorIndex: 1,
          detectorCursor: "page-2",
        },
      }),
    ).toBe(true);

    await db.pool.query(
      "update assurance_runs set lease_expires_at=now()-interval '1 second' where id=$1",
      [run.id],
    );

    const workerB = `resume-b-${randomUUID()}`;
    const resumed = await claimNextAssuranceRun(db, workerB, 60, {
      runId: run.id,
    });
    expect(resumed?.id).toBe(run.id);
    expect(resumed?.leaseToken).toBe(first.leaseToken + 1);
    expect(resumed?.cursor).toEqual({
      detectorIndex: 1,
      detectorCursor: "page-2",
    });

    expect(await cancelAssuranceRun(db, run.id)).toBe(true);
  });
});
