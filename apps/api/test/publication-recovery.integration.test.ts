import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { GitKnowledgeStore } from "@akp/git-store";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const execFileAsync = promisify(execFile);

const defaultSpace = "00000000-0000-0000-0000-000000000003";
const admin = "00000000-0000-0000-0000-000000000002";
const token = `publication-recovery-integration-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let fixtureRoot: string;
let vaultId: string;
const createdReviewIds = new Set<string>();
const previousManagedRepository = process.env.AKP_MANAGED_REPO;

function repositoryFor(testName: string): string {
  const repository = path.join(fixtureRoot, testName, "managed-repository");
  process.env.AKP_MANAGED_REPO = repository;
  return repository;
}

function documentContent(id = `TEST-PUBLICATION-${randomUUID()}`): string {
  return `---
id: ${id}
type: rule
title: Publication recovery integration fixture
status: ACTIVE
knowledge_layer: rules
---

# Publication recovery fixture

This disposable document exercises the managed Git publication boundary,
durable database intent, compensation, and operator reconciliation through the
real API routes.
`;
}

async function git(workingDirectory: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", workingDirectory, ...args], {
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
  return String(result.stdout).trim();
}

async function propose(repository: string, label: string) {
  const relativePath = `integration/publication/${label}-${randomUUID()}.md`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/proposals",
    headers,
    payload: {
      spaceId: defaultSpace,
      vaultId,
      summary: `publication recovery ${label}`,
      changes: [{ path: relativePath, content: documentContent() }],
    },
  });
  expect(response.statusCode).toBe(201);
  const body = response.json() as {
    reviewId: string;
    branchName: string;
    headCommit: string;
    status: string;
  };
  expect(body.status).toBe("PENDING");
  createdReviewIds.add(body.reviewId);
  return { ...body, relativePath, repository };
}

async function approve(reviewId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/reviews/${reviewId}/decision`,
    headers,
    payload: {
      decision: "APPROVE",
      reason: "exercise publication recovery invariant",
    },
  });
}

async function reconcile(reviewId: string) {
  return app.inject({
    method: "POST",
    url: "/v1/operator/publications/reconcile",
    headers,
    payload: { reviewId },
  });
}

async function eventCount(reviewId: string): Promise<number> {
  const result = await db.pool.query<{ count: number }>(
    "select count(*)::int count from event_outbox where resource_id=$1",
    [reviewId],
  );
  return result.rows[0]?.count ?? 0;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-publication-recovery-"));
  db = new Postgres(process.env.DATABASE_URL);
  vaultId = randomUUID();

  await db.pool.query(
    `insert into vaults(
       id,space_id,canonical_path,name,read_only,current_revision,
       vault_key,local_path,visibility,enabled
     ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
    [
      vaultId,
      defaultSpace,
      path.join(fixtureRoot, "canonical-vault"),
      "Publication recovery integration vault",
      "fixture:initial",
      `publication-recovery-${vaultId.slice(0, 8)}`,
    ],
  );
  await grantVaultMembership(db, {
    userId: admin,
    vaultId,
    role: "ADMIN",
    pathPrefix: null,
    permissions: [
      "knowledge:read",
      "source:read",
      "knowledge:propose",
      "knowledge:review",
      "admin",
    ],
  });
  await db.pool.query(
    `insert into api_tokens(user_id,token_hash,label,scopes)
     values($1,$2,$3,$4::jsonb)`,
    [
      admin,
      tokenHash,
      "publication recovery integration",
      JSON.stringify({
        spaces: [
          {
            spaceId: defaultSpace,
            pathPrefix: null,
            permissions: [
              "knowledge:read",
              "source:read",
              "knowledge:propose",
              "knowledge:review",
              "admin",
            ],
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
    const ids = [...createdReviewIds];
    if (ids.length) {
      await db.pool.query(
        "delete from audit_events where resource_type='review' and resource_id=any($1::text[])",
        [ids],
      );
      await db.pool.query(
        "delete from error_book where metadata->>'reviewId'=any($1::text[])",
        [ids],
      );
      await db.pool.query(
        "delete from review_comments where review_id=any($1::uuid[])",
        [ids],
      );
      await db.pool.query("delete from reviews where id=any($1::uuid[])", [
        ids,
      ]);
    }
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.pool.query(
      "delete from vault_memberships where user_id=$1 and vault_id=$2",
      [admin, vaultId],
    );
    await db.close();
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (previousManagedRepository === undefined) {
    delete process.env.AKP_MANAGED_REPO;
  } else {
    process.env.AKP_MANAGED_REPO = previousManagedRepository;
  }
});

describe("publication recovery integration", () => {
  it("compensates Git when database finalization fails after the publication commit", async () => {
    const repository = repositoryFor("db-finalization-failure");
    const proposal = await propose(repository, "db-finalization-failure");
    const store = new GitKnowledgeStore(repository);
    const mainBefore = await store.revision();
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `akp_test_fail_approval_${suffix}`;
    const triggerName = `akp_test_fail_approval_${suffix}`;

    await db.pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.id = '${proposal.reviewId}'::uuid and new.status = 'APPROVED' then
          raise exception 'TEST_PUBLICATION_FINALIZE_FAILURE';
        end if;
        return new;
      end
      $$;
      create trigger ${triggerName}
        before update on reviews
        for each row execute function ${functionName}();
    `);

    let response;
    try {
      response = await approve(proposal.reviewId);
    } finally {
      await db.pool.query(`
        drop trigger if exists ${triggerName} on reviews;
        drop function if exists ${functionName}();
      `);
    }

    expect(response?.statusCode).toBe(500);
    expect(response?.json()).toEqual({ code: "PUBLICATION_FAILED" });

    const compensatedRevision = await store.revision();
    expect(compensatedRevision).not.toBe(mainBefore);
    expect(
      await store.hasFileAtRevision(compensatedRevision, proposal.relativePath),
    ).toBe(false);
    expect(await eventCount(proposal.reviewId)).toBe(0);

    const persisted = await db.pool.query<{
      status: string;
      base_commit: string;
      merged_commit: string | null;
    }>("select status,base_commit,merged_commit from reviews where id=$1", [
      proposal.reviewId,
    ]);
    expect(persisted.rows[0]).toEqual({
      status: "CHANGES_REQUESTED",
      base_commit: compensatedRevision,
      merged_commit: null,
    });

    const failure = await db.pool.query<{
      compensation_succeeded: string | null;
    }>(
      `select metadata->>'compensationSucceeded' compensation_succeeded
         from error_book
        where metadata->>'reviewId'=$1
        order by created_at desc limit 1`,
      [proposal.reviewId],
    );
    expect(failure.rows[0]?.compensation_succeeded).toBe("true");
  });

  it("recovers a crash after the Git commit before database and outbox finalization exactly once", async () => {
    const repository = repositoryFor("crash-before-finalization");
    const proposal = await propose(repository, "crash-before-finalization");
    const stored = await db.pool.query<{
      base_commit: string;
      head_commit: string;
      branch_name: string;
    }>("select base_commit,head_commit,branch_name from reviews where id=$1", [
      proposal.reviewId,
    ]);
    const review = stored.rows[0];
    expect(review).toBeDefined();

    await db.pool.query(
      "update reviews set status='PUBLISHING',decision_reason=$2 where id=$1",
      [proposal.reviewId, "simulated durable publication intent"],
    );
    const store = new GitKnowledgeStore(repository);
    const revision = await store.mergeDraft(
      review!.branch_name,
      review!.base_commit,
      review!.head_commit,
      "Architecture Knowledge Platform",
      "akp@localhost",
    );

    expect(await eventCount(proposal.reviewId)).toBe(0);
    const beforeRecovery = await db.pool.query<{
      status: string;
      merged_commit: string | null;
    }>("select status,merged_commit from reviews where id=$1", [
      proposal.reviewId,
    ]);
    expect(beforeRecovery.rows[0]).toEqual({
      status: "PUBLISHING",
      merged_commit: null,
    });

    const recovered = await reconcile(proposal.reviewId);
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({
      status: "RECOVERED",
      reviewId: proposal.reviewId,
      revision,
    });

    const events = await db.pool.query<{ event_type: string }>(
      "select event_type from event_outbox where resource_id=$1 order by event_type",
      [proposal.reviewId],
    );
    expect(events.rows).toHaveLength(7);
    expect(
      events.rows.filter((row) => row.event_type === "KnowledgePublished"),
    ).toHaveLength(1);
    expect(
      events.rows.filter((row) => row.event_type === "CorpusRevisionPublished"),
    ).toHaveLength(1);

    const second = await reconcile(proposal.reviewId);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({
      status: "ALREADY_COMMITTED",
      reviewId: proposal.reviewId,
      revision,
    });
    expect(await eventCount(proposal.reviewId)).toBe(7);

    const duplicateApproval = await approve(proposal.reviewId);
    expect(duplicateApproval.statusCode).toBe(409);
    expect(duplicateApproval.json()).toMatchObject({
      code: "REVIEW_ALREADY_DECIDED",
      status: "APPROVED",
    });
    expect(await eventCount(proposal.reviewId)).toBe(7);
  });

  it("requires manual recovery when durable intent cannot be attributed to current main", async () => {
    const repository = repositoryFor("ambiguous-main");
    const proposal = await propose(repository, "ambiguous-main");
    await db.pool.query(
      "update reviews set status='PUBLISHING',decision_reason=$2 where id=$1",
      [proposal.reviewId, "simulated durable publication intent"],
    );

    const unrelatedPath = path.join(
      repository,
      `unrelated-${randomUUID()}.txt`,
    );
    await writeFile(unrelatedPath, "unrelated canonical change\n", "utf8");
    await git(repository, ["add", "--all"]);
    await git(repository, [
      "-c",
      "user.name=Architecture Knowledge Platform",
      "-c",
      "user.email=akp@localhost",
      "commit",
      "-m",
      "test: unrelated main revision",
    ]);
    const unrelatedRevision = await new GitKnowledgeStore(
      repository,
    ).revision();

    const response = await reconcile(proposal.reviewId);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "RECOVERY_REQUIRED",
      reviewId: proposal.reviewId,
      currentRevision: unrelatedRevision,
      reason: "MAIN_REVISION_MISMATCH",
    });
    expect(await new GitKnowledgeStore(repository).revision()).toBe(
      unrelatedRevision,
    );
    expect(await eventCount(proposal.reviewId)).toBe(0);

    const persisted = await db.pool.query<{ status: string }>(
      "select status from reviews where id=$1",
      [proposal.reviewId],
    );
    expect(persisted.rows[0]?.status).toBe("PUBLICATION_RECOVERY_REQUIRED");

    const failure = await db.pool.query<{ count: number }>(
      `select count(*)::int count from error_book
        where metadata->>'reviewId'=$1 and status='OPEN'`,
      [proposal.reviewId],
    );
    expect(failure.rows[0]?.count).toBeGreaterThan(0);
  });
});
