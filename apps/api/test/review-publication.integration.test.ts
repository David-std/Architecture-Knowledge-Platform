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
      await db.pool.query("delete from reviews where id=any($1::uuid[])", [
        ids,
      ]);
    }
    await db.pool.query("delete from api_tokens where token_hash=$1", [
      tokenHash,
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

describe("review publication integration", () => {
  it("rejects an invalid proposal before creating a repository, branch, or worktree", async () => {
    const repository = repositoryFor("invalid-proposal");
    const response = await app.inject({
      method: "POST",
      url: "/v1/proposals",
      headers,
      payload: {
        spaceId: defaultSpace,
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
