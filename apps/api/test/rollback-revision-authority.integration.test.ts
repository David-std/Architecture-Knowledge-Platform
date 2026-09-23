import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { GitKnowledgeStore } from "@akp/git-store";
import { Postgres, grantVaultMembership } from "@akp/postgres";

const defaultSpace = "00000000-0000-0000-0000-000000000003";
const admin = "00000000-0000-0000-0000-000000000002";
const token = `rollback-revision-authority-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let fixtureRoot: string;
let vaultId: string;
const previousManagedRepository = process.env.AKP_MANAGED_REPO;

function repositoryFor(testName: string): string {
  const repository = path.join(fixtureRoot, testName, "managed-repository");
  process.env.AKP_MANAGED_REPO = repository;
  return repository;
}

function documentContent(id = `ROLLBACK-AUTH-${randomUUID()}`): string {
  return `---
id: ${id}
type: rule
title: Rollback revision authority fixture
status: ACTIVE
knowledge_layer: rules
---

# Rollback revision authority

This document exists only to prove that the durable vault revision follows the
actual canonical managed Git HEAD across publication, rollback, and recovery.
`;
}

async function propose(repository: string, label: string) {
  const relativePath = `integration/rollback-authority/${label}-${randomUUID()}.md`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/proposals",
    headers,
    payload: {
      spaceId: defaultSpace,
      vaultId,
      summary: `rollback revision authority ${label}`,
      changes: [{ path: relativePath, content: documentContent() }],
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  const body = response.json() as {
    reviewId: string;
    status: string;
  };
  expect(body.status).toBe("PENDING");
  return { ...body, relativePath, repository };
}

async function approve(reviewId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/reviews/${reviewId}/decision`,
    headers,
    payload: {
      decision: "APPROVE",
      reason: "prove canonical revision authority",
    },
  });
}

async function rollback(reviewId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/reviews/${reviewId}/rollback`,
    headers,
    payload: { reason: "prove rollback canonical revision authority" },
  });
}

async function vaultRevision(): Promise<string> {
  const result = await db.pool.query<{ current_revision: string }>(
    "select current_revision from vaults where id=$1",
    [vaultId],
  );
  const revision = result.rows[0]?.current_revision;
  expect(revision).toBeTruthy();
  return revision!;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-rollback-authority-"));
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
      "Rollback revision authority integration vault",
      "rollback-authority:initial",
      `rollback-authority-${vaultId.slice(0, 8)}`,
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
      "rollback revision authority integration",
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
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    await db.pool.query(
      "delete from vault_memberships where user_id=$1 and vault_id=$2",
      [admin, vaultId],
    );
    await db.pool.query("update vaults set enabled=false where id=$1", [
      vaultId,
    ]);
    await db.close();
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (previousManagedRepository === undefined) {
    delete process.env.AKP_MANAGED_REPO;
  } else {
    process.env.AKP_MANAGED_REPO = previousManagedRepository;
  }
});

describe("rollback canonical revision authority", () => {
  it("advances the vault revision atomically with a successful rollback", async () => {
    const repository = repositoryFor("successful-rollback");
    const proposal = await propose(repository, "successful-rollback");
    const approved = await approve(proposal.reviewId);
    expect(approved.statusCode, approved.body).toBe(200);
    const approvedBody = approved.json() as {
      status: string;
      mergedCommit: string;
    };
    expect(approvedBody.status).toBe("APPROVED");
    expect(await vaultRevision()).toBe(approvedBody.mergedCommit);

    const response = await rollback(proposal.reviewId);
    expect(response.statusCode, response.body).toBe(200);
    const rolledBack = response.json() as {
      status: string;
      revision: string;
    };
    expect(rolledBack.status).toBe("ROLLED_BACK");
    expect(await new GitKnowledgeStore(repository).revision()).toBe(
      rolledBack.revision,
    );
    expect(await vaultRevision()).toBe(rolledBack.revision);

    const rollbackEvent = await db.pool.query<{ revision: string | null }>(
      `select payload->>'revision' revision
         from event_outbox
        where resource_id=$1
          and event_type='CorpusRevisionPublished'
          and payload->>'operation'='ROLLBACK'
        order by created_at desc
        limit 1`,
      [proposal.reviewId],
    );
    expect(rollbackEvent.rows[0]?.revision).toBe(rolledBack.revision);

    const persisted = await db.pool.query<{
      status: string;
      merged_commit: string;
    }>("select status,merged_commit from reviews where id=$1", [
      proposal.reviewId,
    ]);
    expect(persisted.rows[0]).toEqual({
      status: "ROLLED_BACK",
      merged_commit: approvedBody.mergedCommit,
    });
  });

  it("moves revision authority to the compensating Git commit when publication finalization fails", async () => {
    const repository = repositoryFor("publication-compensation");
    const proposal = await propose(repository, "publication-compensation");
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `akp_test_fail_publish_authority_${suffix}`;
    const triggerName = `akp_test_fail_publish_authority_${suffix}`;

    await db.pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.id = '${proposal.reviewId}'::uuid and new.status = 'APPROVED' then
          raise exception 'TEST_PUBLICATION_REVISION_AUTHORITY_FAILURE';
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

    const compensatedRevision = await new GitKnowledgeStore(
      repository,
    ).revision();
    expect(await vaultRevision()).toBe(compensatedRevision);
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
    expect(
      await new GitKnowledgeStore(repository).hasFileAtRevision(
        compensatedRevision,
        proposal.relativePath,
      ),
    ).toBe(false);
  });

  it("keeps the historical merge commit while authority follows rollback compensation HEAD", async () => {
    const repository = repositoryFor("rollback-compensation");
    const proposal = await propose(repository, "rollback-compensation");
    const approved = await approve(proposal.reviewId);
    expect(approved.statusCode, approved.body).toBe(200);
    const approvedBody = approved.json() as {
      status: string;
      mergedCommit: string;
    };
    expect(approvedBody.status).toBe("APPROVED");

    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `akp_test_fail_rollback_authority_${suffix}`;
    const triggerName = `akp_test_fail_rollback_authority_${suffix}`;
    await db.pool.query(`
      create function ${functionName}() returns trigger language plpgsql as $$
      begin
        if new.id = '${proposal.reviewId}'::uuid and new.status = 'ROLLED_BACK' then
          raise exception 'TEST_ROLLBACK_REVISION_AUTHORITY_FAILURE';
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
      response = await rollback(proposal.reviewId);
    } finally {
      await db.pool.query(`
        drop trigger if exists ${triggerName} on reviews;
        drop function if exists ${functionName}();
      `);
    }
    expect(response?.statusCode).toBe(500);
    expect(response?.json()).toEqual({ code: "ROLLBACK_FAILED" });

    const recoveryRevision = await new GitKnowledgeStore(repository).revision();
    expect(recoveryRevision).not.toBe(approvedBody.mergedCommit);
    expect(await vaultRevision()).toBe(recoveryRevision);
    expect(
      await new GitKnowledgeStore(repository).hasFileAtRevision(
        recoveryRevision,
        proposal.relativePath,
      ),
    ).toBe(true);

    const persisted = await db.pool.query<{
      status: string;
      merged_commit: string;
    }>("select status,merged_commit from reviews where id=$1", [
      proposal.reviewId,
    ]);
    expect(persisted.rows[0]).toEqual({
      status: "APPROVED",
      merged_commit: approvedBody.mergedCommit,
    });
  });
});
