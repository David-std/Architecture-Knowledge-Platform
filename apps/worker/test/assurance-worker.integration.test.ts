import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IMPLEMENTED_ASSURANCE_DETECTORS } from "@akp/domain";
import {
  Postgres,
  claimNextAssuranceRun,
  submitAssuranceRun,
} from "@akp/postgres";
import { runClaimedAssuranceRun } from "../src/assurance-worker.js";

const databaseUrl = process.env.DATABASE_URL;
const describeDb = databaseUrl ? describe : describe.skip;

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
    const claimed = await claimNextAssuranceRun(db, workerId, 60);
    expect(claimed?.id).toBe(run.id);
    if (!claimed) throw new Error("expected assurance run claim");

    await expect(
      runClaimedAssuranceRun(db, claimed, workerId),
    ).resolves.toBe("COMPLETED");

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
});
