import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Postgres } from "@akp/postgres";
import { GitKnowledgeStore } from "@akp/git-store";

const execFileAsync = promisify(execFile);

const defaultSpace = "00000000-0000-0000-0000-000000000003";
const admin = "00000000-0000-0000-0000-000000000002";
const token = `review-publication-integration-${randomUUID()}`;
const tokenHash = createHash("sha256").update(token).digest("hex");
const headers = { authorization: `Bearer ${token}` };

let app: FastifyInstance;
let db: Postgres;
let fixtureRoot: string;
let defaultVault: string;
let createdVaultMembershipId: string | null = null;
const createdReviewIds = new Set<string>();
const previousManagedRepository = process.env.AKP_MANAGED_REPO;

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function repositoryFor(testName: string): string {
  const repository = path.join(fixtureRoot, testName, "managed-repository");
  process.env.AKP_MANAGED_REPO = repository;
  return repository;
}

function documentContent(id = `TEST-REVIEW-${randomUUID()}`): string {
  return `---
id: ${id}
type: rule
title: Review publication integration fixture
status: ACTIVE
knowledge_layer: rules
---

# Review publication fixture

This deliberately substantive document exercises the isolated draft and
publication workflow through the real Fastify route, PostgreSQL transaction,
and managed Git repository. It is disposable test content.
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
  const relativePath = `integration/reviews/${label}-${randomUUID()}.md`;
  const response = await app.inject({
    method: "POST",
    url: "/v1/proposals",
    headers,
    payload: {
      spaceId: defaultSpace,
      vaultId: defaultVault,
      summary: `integration review ${label}`,
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

async function decide(
  reviewId: string,
  decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES",
  reason: string,
) {
  return app.inject({
    method: "POST",
    url: `/v1/reviews/${reviewId}/decision`,
    headers,
    payload: { decision, reason },
  });
}

async function mutateDraftTip(worktree: string): Promise<void> {
  const mutationPath = path.join(worktree, "integration", "tip-mutated.md");
  await writeFile(mutationPath, documentContent("TEST-MUTATED-TIP"), "utf8");
  await git(worktree, ["add", "--all"]);
  await git(worktree, [
    "-c",
    "user.name=Architecture Knowledge Platform",
    "-c",
    "user.email=akp@localhost",
    "commit",
    "-m",
    "test: mutate draft branch tip",
  ]);
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for integration tests.");
  }
  process.env.NODE_ENV = "test";
  fixtureRoot = await mkdtemp(path.join(tmpdir(), "akp-review-publication-"));
  db = new Postgres(process.env.DATABASE_URL);
  const vault = await db.pool.query<{ id: string }>(
    "select id from vaults where space_id=$1 and enabled=true order by created_at limit 1",
    [defaultSpace],
  );
  defaultVault = vault.rows[0]?.id ?? randomUUID();
  if (!vault.rows[0]) {
    await db.pool.query(
      `insert into vaults(
         id,space_id,canonical_path,name,read_only,current_revision,
         vault_key,local_path,visibility,enabled
       ) values($1,$2,$3,$4,true,$5,$6,$3,'PRIVATE',true)`,
      [
        defaultVault,
        defaultSpace,
        path.join(fixtureRoot, "canonical-vault"),
        "Review publication integration vault",
        "fixture:initial",
        `review-fixture-${defaultVault.slice(0, 8)}`,
      ],
    );
  }
  const vaultMembershipId = randomUUID();
  const vaultMembership = await db.pool.query<{ id: string }>(
    `
    insert into vault_memberships(
      id,user_id,vault_id,role,path_prefix,permissions,enabled
    ) values($1,$2,$3,'ADMIN',null,$4::jsonb,true)
    on conflict do nothing
    returning id
    `,
    [
      vaultMembershipId,
      admin,
      defaultVault,
      JSON.stringify([
        "knowledge:read",
        "source:read",
        "source:write",
        "knowledge:propose",
        "knowledge:review",
        "eval:run",
        "admin",
      ]),
    ],
  );
  createdVaultMembershipId = vaultMembership.rows[0]?.id ?? null;
  await db.pool.query(
    `
    insert into api_tokens(user_id,token_hash,label,scopes)
    values($1,$2,$3,$4::jsonb)
    `,
    [
      admin,
      tokenHash,
      "review publication integration",
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
      // Publication events are append-only evidence.  Tests must never
      // delete them: the database trigger deliberately rejects mutations of
      // event_outbox and its delivery history.  The test resources are
      // uniquely identified, so those durable records remain traceable
      // without affecting later fixtures.
      await db.pool.query("delete from reviews where id=any($1::uuid[])", [
        ids,
      ]);
    }
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
    ]);
    if (createdVaultMembershipId) {
      await db.pool.query("delete from vault_memberships where id=$1", [
        createdVaultMembershipId,
      ]);
    }
    await db.close();
  }
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  if (previousManagedRepository === undefined) {
    delete process.env.AKP_MANAGED_REPO;
  } else {
    process.env.AKP_MANAGED_REPO = previousManagedRepository;
  }
});

describe("review publication integration", () => {
  it("rejects an invalid proposal before creating a repository, branch, or worktree", async () => {
    const repository = repositoryFor("invalid-proposal");
    const response = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers,
      payload: {
        spaceId: defaultSpace,
        vaultId: defaultVault,
        summary: "invalid review fixture",
        changes: [
          {
            path: "integration/invalid.md",
            content: "---\ntype: rule\n---\ninvalid frontmatter",
          },
        ],
      },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: "DRAFT_VALIDATION_FAILED" });
    expect(await pathExists(repository)).toBe(false);
    expect(await pathExists(`${repository}-drafts`)).toBe(false);
  });

  it("rejects duplicate proposal paths before creating any Git draft", async () => {
    const repository = repositoryFor("duplicate-paths");
    const relativePath = "integration/duplicate.md";
    const response = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers,
      payload: {
        spaceId: defaultSpace,
        summary: "duplicate review fixture",
        changes: [
          { path: relativePath, content: documentContent("TEST-DUPLICATE-A") },
          { path: relativePath, content: documentContent("TEST-DUPLICATE-B") },
        ],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: "DUPLICATE_PROPOSAL_PATH",
      paths: [relativePath],
    });
    expect(await pathExists(repository)).toBe(false);
    expect(await pathExists(`${repository}-drafts`)).toBe(false);
  });

  it("commits approval and outbox events without synchronously indexing the vault", async () => {
    const repository = repositoryFor("approval-outbox");
    const proposal = await propose(repository, "approval-outbox");
    const response = await decide(
      proposal.reviewId,
      "APPROVE",
      "publish and queue durable indexing",
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: proposal.reviewId,
      status: "APPROVED",
      indexing: "PENDING",
    });

    const persisted = await db.pool.query<{
      status: string;
      merged_commit: string | null;
    }>("select status,merged_commit from reviews where id=$1", [
      proposal.reviewId,
    ]);
    expect(persisted.rows[0]).toMatchObject({
      status: "APPROVED",
      merged_commit: expect.any(String),
    });

    const events = await db.pool.query<{
      event_id: string;
      event_type: string;
      vault_id: string;
      causation_id: string | null;
    }>(
      "select event_id,event_type,vault_id,causation_id from event_outbox where resource_id=$1",
      [proposal.reviewId],
    );
    const eventTypes = events.rows.map((row) => row.event_type).sort();
    expect(eventTypes).toEqual(
      [
        "KnowledgePublished",
        "CorpusRevisionPublished",
        "LexicalIndexUpdateRequested",
        "VectorIndexUpdateRequested",
        "GraphIndexUpdateRequested",
        "ContextPackInvalidationRequested",
        "ImpactedEvalRunRequested",
      ].sort(),
    );
    expect(events.rows.every((row) => row.vault_id === defaultVault)).toBe(
      true,
    );
    const published = events.rows.find(
      (row) => row.event_type === "KnowledgePublished",
    );
    const corpus = events.rows.find(
      (row) => row.event_type === "CorpusRevisionPublished",
    );
    expect(published?.causation_id).toBeNull();
    expect(corpus?.causation_id).toBe(published?.event_id);
    expect(
      events.rows
        .filter((row) => row.event_type.endsWith("Requested"))
        .every((row) => row.causation_id === corpus?.event_id),
    ).toBe(true);

    const indexed = await db.pool.query<{ count: number }>(
      "select count(*)::int count from knowledge_documents where vault_id=$1 and path=$2",
      [defaultVault, `managed/${proposal.relativePath}`],
    );
    expect(indexed.rows[0]?.count).toBe(0);
  });

  it("publishes rollback as an atomic corpus revision event with inverse tombstones", async () => {
    const repository = repositoryFor("rollback-outbox");
    const proposal = await propose(repository, "rollback-outbox");
    const approved = await decide(
      proposal.reviewId,
      "APPROVE",
      "publish before rollback parity check",
    );
    expect(approved.statusCode).toBe(200);

    const rollback = await app.inject({
      method: "POST",
      url: `/v1/reviews/${proposal.reviewId}/rollback`,
      headers,
      payload: {
        reason: "undo the published CREATE through the durable outbox",
      },
    });
    expect(rollback.statusCode, rollback.body).toBe(200);
    const rollbackBody = rollback.json() as {
      status: string;
      revision: string;
      indexing: string;
      queuedEvents: string[];
    };
    expect(rollbackBody).toMatchObject({
      status: "ROLLED_BACK",
      indexing: "PENDING",
    });
    expect(rollbackBody.queuedEvents).toContain("CorpusRevisionPublished");

    const stored = await db.pool.query<{
      status: string;
      decision_reason: string;
    }>("select status,decision_reason from reviews where id=$1", [
      proposal.reviewId,
    ]);
    expect(stored.rows[0]).toMatchObject({
      status: "ROLLED_BACK",
      decision_reason: "undo the published CREATE through the durable outbox",
    });

    const events = await db.pool.query<{
      event_id: string;
      event_type: string;
      causation_id: string | null;
      payload: {
        operation?: string;
        revision?: string;
        changedPaths?: string[];
        tombstones?: string[];
      };
    }>(
      `select event_id,event_type,causation_id,payload
         from event_outbox
        where resource_id=$1 and payload->>'operation'='ROLLBACK'
        order by created_at,event_id`,
      [proposal.reviewId],
    );
    expect(events.rows.map((row) => row.event_type).sort()).toEqual(
      [
        "CorpusRevisionPublished",
        "LexicalIndexUpdateRequested",
        "VectorIndexUpdateRequested",
        "GraphIndexUpdateRequested",
        "ContextPackInvalidationRequested",
        "ImpactedEvalRunRequested",
      ].sort(),
    );
    const corpus = events.rows.find(
      (row) => row.event_type === "CorpusRevisionPublished",
    );
    expect(corpus?.causation_id).toBeNull();
    expect(corpus?.payload).toMatchObject({
      operation: "ROLLBACK",
      revision: rollbackBody.revision,
      changedPaths: [proposal.relativePath],
      tombstones: [proposal.relativePath],
    });
    expect(
      events.rows
        .filter((row) => row.event_type !== "CorpusRevisionPublished")
        .every((row) => row.causation_id === corpus?.event_id),
    ).toBe(true);

    const store = new GitKnowledgeStore(repository);
    expect(
      await store.hasFileAtRevision(
        await store.revision(),
        proposal.relativePath,
      ),
    ).toBe(false);

    const auditRows = await db.pool.query<{ count: number }>(
      `select count(*)::int count from audit_events
        where action='review.rollback' and resource_id=$1`,
      [proposal.reviewId],
    );
    expect(auditRows.rows[0]?.count).toBe(1);
  });

  it("compensates a Git merge when the publication DB transaction fails and replays once", async () => {
    const repository = repositoryFor("publication-db-failure");
    const proposal = await propose(repository, "publication-db-failure");
    const triggerName = "p8_fail_review_approval";
    const functionName = "p8_fail_review_approval_fn";
    await db.pool.query(
      `create or replace function ${functionName}() returns trigger language plpgsql as $$
        begin
          if new.id='${proposal.reviewId}'::uuid and new.status='APPROVED' then
            raise exception 'P8_DB_PUBLICATION_FAILURE';
          end if;
          return new;
        end $$`,
    );
    await db.pool.query(
      `create trigger ${triggerName} before update on reviews
        for each row execute function ${functionName}()`,
    );
    let failed;
    try {
      failed = await decide(
        proposal.reviewId,
        "APPROVE",
        "inject DB failure after managed Git merge",
      );
    } finally {
      await db.pool.query(`drop trigger if exists ${triggerName} on reviews`);
      await db.pool.query(`drop function if exists ${functionName}()`);
    }
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: "PUBLICATION_FAILED" });

    const compensated = await db.pool.query<{
      status: string;
      base_commit: string;
    }>("select status,base_commit from reviews where id=$1", [
      proposal.reviewId,
    ]);
    expect(compensated.rows[0]?.status).toBe("CHANGES_REQUESTED");
    const store = new GitKnowledgeStore(repository);
    expect(await store.revision()).toBe(compensated.rows[0]?.base_commit);
    expect(
      await store.hasFileAtRevision(
        await store.revision(),
        proposal.relativePath,
      ),
    ).toBe(false);
    const failedEvents = await db.pool.query<{ count: number }>(
      "select count(*)::int count from event_outbox where resource_id=$1",
      [proposal.reviewId],
    );
    expect(failedEvents.rows[0]?.count).toBe(0);

    const retry = await decide(
      proposal.reviewId,
      "APPROVE",
      "retry compensated publication",
    );
    expect(retry.statusCode, retry.body).toBe(200);
    const publishedEvents = await db.pool.query<{ count: number }>(
      "select count(*)::int count from event_outbox where resource_id=$1",
      [proposal.reviewId],
    );
    expect(publishedEvents.rows[0]?.count).toBe(7);
    const duplicate = await decide(
      proposal.reviewId,
      "APPROVE",
      "must not publish twice",
    );
    expect(duplicate.statusCode).toBe(409);
    const afterDuplicate = await db.pool.query<{ count: number }>(
      "select count(*)::int count from event_outbox where resource_id=$1",
      [proposal.reviewId],
    );
    expect(afterDuplicate.rows[0]?.count).toBe(7);
  });

  it("fails closed when durable publication intent exists but Git main moved", async () => {
    const repository = repositoryFor("publication-git-conflict");
    const proposal = await propose(repository, "publication-git-conflict");
    await writeFile(
      path.join(repository, "unrelated.txt"),
      "unrelated main advance\n",
      "utf8",
    );
    await git(repository, ["add", "unrelated.txt"]);
    await git(repository, [
      "-c",
      "user.name=Architecture Knowledge Platform",
      "-c",
      "user.email=akp@localhost",
      "commit",
      "-m",
      "test: unrelated main advance",
    ]);
    const response = await decide(
      proposal.reviewId,
      "APPROVE",
      "exercise durable intent before Git conflict",
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "PUBLICATION_CONFLICT" });
    const review = await db.pool.query<{
      status: string;
      decision_by: string | null;
    }>("select status,decision_by from reviews where id=$1", [
      proposal.reviewId,
    ]);
    expect(review.rows[0]).toMatchObject({
      status: "PUBLICATION_RECOVERY_REQUIRED",
      decision_by: admin,
    });
    const events = await db.pool.query<{ count: number }>(
      "select count(*)::int count from event_outbox where resource_id=$1",
      [proposal.reviewId],
    );
    expect(events.rows[0]?.count).toBe(0);
  });

  it("reconciles a crash after Git commit before outbox exactly once", async () => {
    const repository = repositoryFor("publication-crash-recovery");
    const proposal = await propose(repository, "publication-crash-recovery");
    const reviewResult = await db.pool.query(
      "select * from reviews where id=$1",
      [proposal.reviewId],
    );
    const review = reviewResult.rows[0];
    await db.pool.query(
      `update reviews set status='PUBLISHING',decision_by=$2,decision_at=now(),
             decision_reason=$3,updated_at=now() where id=$1`,
      [proposal.reviewId, admin, "durable intent before simulated crash"],
    );
    const store = new GitKnowledgeStore(repository);
    const merged = await store.mergeDraft(
      String(review.branch_name),
      String(review.base_commit),
      String(review.head_commit),
      "Architecture Knowledge Platform",
      "akp@localhost",
    );
    const before = await db.pool.query<{ count: number }>(
      "select count(*)::int count from event_outbox where resource_id=$1",
      [proposal.reviewId],
    );
    expect(before.rows[0]?.count).toBe(0);

    const recovered = await app.inject({
      method: "POST",
      url: "/v1/operator/publications/reconcile",
      headers,
      payload: { reviewId: proposal.reviewId },
    });
    expect(recovered.statusCode, recovered.body).toBe(200);
    expect(recovered.json()).toMatchObject({
      status: "RECOVERED",
      reviewId: proposal.reviewId,
      revision: merged,
    });
    const committed = await db.pool.query<{
      status: string;
      merged_commit: string;
    }>("select status,merged_commit from reviews where id=$1", [
      proposal.reviewId,
    ]);
    expect(committed.rows[0]).toMatchObject({
      status: "APPROVED",
      merged_commit: merged,
    });
    const eventCount = await db.pool.query<{ count: number }>(
      "select count(*)::int count from event_outbox where resource_id=$1",
      [proposal.reviewId],
    );
    expect(eventCount.rows[0]?.count).toBe(7);

    const replay = await app.inject({
      method: "POST",
      url: "/v1/operator/publications/reconcile",
      headers,
      payload: { reviewId: proposal.reviewId },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({
      status: "ALREADY_COMMITTED",
      revision: merged,
    });
    const afterReplay = await db.pool.query<{ count: number }>(
      "select count(*)::int count from event_outbox where resource_id=$1",
      [proposal.reviewId],
    );
    expect(afterReplay.rows[0]?.count).toBe(7);
  });

  it("marks an ambiguous crashed publication for manual recovery without guessing", async () => {
    const repository = repositoryFor("publication-reconcile-mismatch");
    const proposal = await propose(
      repository,
      "publication-reconcile-mismatch",
    );
    await db.pool.query(
      `update reviews set status='PUBLISHING',decision_by=$2,decision_at=now(),
             decision_reason=$3,updated_at=now() where id=$1`,
      [proposal.reviewId, admin, "simulated crash with ambiguous main"],
    );
    await writeFile(
      path.join(repository, "ambiguous.txt"),
      "ambiguous main\n",
      "utf8",
    );
    await git(repository, ["add", "ambiguous.txt"]);
    await git(repository, [
      "-c",
      "user.name=Architecture Knowledge Platform",
      "-c",
      "user.email=akp@localhost",
      "commit",
      "-m",
      "test: ambiguous main after crash",
    ]);
    const response = await app.inject({
      method: "POST",
      url: "/v1/operator/publications/reconcile",
      headers,
      payload: { reviewId: proposal.reviewId },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      status: "RECOVERY_REQUIRED",
      reason: "MAIN_REVISION_MISMATCH",
    });
    const review = await db.pool.query<{ status: string }>(
      "select status from reviews where id=$1",
      [proposal.reviewId],
    );
    expect(review.rows[0]?.status).toBe("PUBLICATION_RECOVERY_REQUIRED");
    const events = await db.pool.query<{ count: number }>(
      "select count(*)::int count from event_outbox where resource_id=$1",
      [proposal.reviewId],
    );
    expect(events.rows[0]?.count).toBe(0);
  });

  it("preserves review feedback, creates a new validated draft revision, resubmits, and approves it", async () => {
    const repository = repositoryFor("requested-changes");
    const proposal = await propose(repository, "requested-changes");
    const originalWorktree = path.resolve(
      `${repository}-drafts`,
      proposal.reviewId,
    );

    const comment = await app.inject({
      method: "POST",
      url: `/v1/reviews/${proposal.reviewId}/comments`,
      headers,
      payload: {
        body: "Clarify the operational invariant before publication.",
        path: proposal.relativePath,
        line: 12,
      },
    });
    expect(comment.statusCode).toBe(201);

    const requested = await decide(
      proposal.reviewId,
      "REQUEST_CHANGES",
      "Apply the reviewer feedback",
    );
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({
      id: proposal.reviewId,
      status: "CHANGES_REQUESTED",
    });
    expect(await pathExists(originalWorktree)).toBe(true);

    const expandedPath = `integration/reviews/unreviewed-${randomUUID()}.md`;
    const expanded = await app.inject({
      method: "POST",
      url: `/v1/reviews/${proposal.reviewId}/revise`,
      headers,
      payload: {
        changes: [
          { path: proposal.relativePath, content: documentContent() },
          { path: expandedPath, content: documentContent() },
        ],
      },
    });
    expect(expanded.statusCode).toBe(400);
    expect(expanded.json()).toMatchObject({
      code: "REVISION_PATH_SET_CHANGED",
    });
    expect(await pathExists(originalWorktree)).toBe(true);

    const corrected = `${documentContent("TEST-REVISED-DRAFT")}
## Corrected invariant

The corrected draft explicitly preserves review feedback and cannot bypass
validation, resubmission, or human approval.
`;
    const revised = await app.inject({
      method: "POST",
      url: `/v1/reviews/${proposal.reviewId}/revise`,
      headers,
      payload: {
        summary: "Apply requested review correction",
        changes: [
          {
            path: proposal.relativePath,
            content: corrected,
            reason: "Reviewer requested an explicit invariant",
          },
        ],
      },
    });
    expect(revised.statusCode).toBe(200);
    const revisedBody = revised.json() as {
      status: string;
      branch_name: string;
      head_commit: string;
      draftRevision: number;
    };
    expect(revisedBody).toMatchObject({
      status: "CHANGES_REQUESTED",
      draftRevision: 2,
    });
    expect(revisedBody.branch_name).not.toBe(proposal.branchName);
    expect(revisedBody.head_commit).not.toBe(proposal.headCommit);
    expect(await pathExists(originalWorktree)).toBe(false);

    const resubmitted = await app.inject({
      method: "POST",
      url: `/v1/reviews/${proposal.reviewId}/submit`,
      headers,
      payload: {},
    });
    expect(resubmitted.statusCode).toBe(200);
    expect(resubmitted.json()).toMatchObject({ status: "PENDING" });

    const approved = await decide(
      proposal.reviewId,
      "APPROVE",
      "Correction verified against the feedback",
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ status: "APPROVED" });
    expect(
      await new GitKnowledgeStore(repository).showFile(
        await new GitKnowledgeStore(repository).revision(),
        proposal.relativePath,
      ),
    ).toContain("Corrected invariant");

    const stored = await db.pool.query<{
      status: string;
      impact_manifest: { draftRevision?: number };
      comment_count: number;
    }>(
      `select r.status,r.impact_manifest,
              (select count(*)::int from review_comments c where c.review_id=r.id) comment_count
         from reviews r where r.id=$1`,
      [proposal.reviewId],
    );
    expect(stored.rows[0]).toMatchObject({
      status: "APPROVED",
      impact_manifest: { draftRevision: 2 },
      comment_count: 1,
    });
  });

  it("does not let a second reject or approve overwrite the first decision", async () => {
    const repository = repositoryFor("atomic-decision");
    const proposal = await propose(repository, "atomic");

    const first = await decide(proposal.reviewId, "REJECT", "first decision");
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({
      id: proposal.reviewId,
      status: "REJECTED",
    });

    const secondReject = await decide(
      proposal.reviewId,
      "REJECT",
      "attempted overwrite",
    );
    expect(secondReject.statusCode).toBe(409);
    expect(secondReject.json()).toMatchObject({
      code: "REVIEW_ALREADY_DECIDED",
      status: "REJECTED",
    });

    const secondApprove = await decide(
      proposal.reviewId,
      "APPROVE",
      "attempted approve after reject",
    );
    expect(secondApprove.statusCode).toBe(409);
    expect(secondApprove.json()).toMatchObject({
      code: "REVIEW_ALREADY_DECIDED",
      status: "REJECTED",
    });

    const stored = await db.pool.query<{
      status: string;
      decision_reason: string;
    }>("select status,decision_reason from reviews where id=$1", [
      proposal.reviewId,
    ]);
    expect(stored.rows[0]).toMatchObject({
      status: "REJECTED",
      decision_reason: "first decision",
    });
  });

  it("returns a publication conflict when the draft branch tip changes after proposal", async () => {
    const repository = repositoryFor("mutated-tip");
    const proposal = await propose(repository, "mutated-tip");
    const worktree = path.resolve(`${repository}-drafts`, proposal.reviewId);
    expect(await pathExists(worktree)).toBe(true);

    const mainBefore = await new GitKnowledgeStore(repository).revision();
    await mutateDraftTip(worktree);

    try {
      const response = await decide(
        proposal.reviewId,
        "APPROVE",
        "approval must reject a stale branch tip",
      );
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({ code: "PUBLICATION_CONFLICT" });
      expect(await new GitKnowledgeStore(repository).revision()).toBe(
        mainBefore,
      );

      const stored = await db.pool.query<{
        status: string;
        merged_commit: string | null;
      }>("select status,merged_commit from reviews where id=$1", [
        proposal.reviewId,
      ]);
      expect(stored.rows[0]).toMatchObject({
        status: "CHANGES_REQUESTED",
        merged_commit: null,
      });
    } finally {
      await new GitKnowledgeStore(repository)
        .cleanupDraft(proposal.branchName)
        .catch(() => undefined);
    }
  });

  it("cleans the isolated draft worktree and branch after rejection", async () => {
    const repository = repositoryFor("reject-cleanup");
    const proposal = await propose(repository, "reject-cleanup");
    const worktree = path.resolve(`${repository}-drafts`, proposal.reviewId);
    expect(await pathExists(worktree)).toBe(true);
    expect(
      (await git(repository, ["branch", "--list", proposal.branchName])).trim(),
    ).not.toBe("");

    const response = await decide(
      proposal.reviewId,
      "REJECT",
      "discard disposable draft",
    );
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: proposal.reviewId,
      status: "REJECTED",
    });
    expect(await pathExists(worktree)).toBe(false);
    expect(
      (await git(repository, ["branch", "--list", proposal.branchName])).trim(),
    ).toBe("");

    const persisted = await db.pool.query<{ status: string }>(
      "select status from reviews where id=$1",
      [proposal.reviewId],
    );
    expect(persisted.rows[0]?.status).toBe("REJECTED");
  });
});
