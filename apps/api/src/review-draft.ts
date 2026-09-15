import { randomUUID } from "node:crypto";
import { GitKnowledgeStore } from "@akp/git-store";
import type { Postgres } from "@akp/postgres";

export interface ReviewDraftChange {
  path: string;
  content: string;
  reason?: string;
}

export async function createReviewDraft(
  db: Postgres,
  input: {
    repositoryPath: string;
    spaceId: string;
    vaultId: string;
    authorId: string | null;
    summary: string;
    changes: readonly ReviewDraftChange[];
    impactManifest: Record<string, unknown>;
    validationReport: Record<string, unknown>;
    defaultReason: string;
  },
): Promise<{
  reviewId: string;
  branchName: string;
  baseRevision: string;
  headCommit: string;
  proposedChanges: Array<{
    path: string;
    operation: "CREATE" | "UPDATE";
    reasons: string[];
  }>;
}> {
  const reviewId = randomUUID();
  const store = new GitKnowledgeStore(input.repositoryPath);
  const baseRevision = await store.ensureRepository(
    process.env.AKP_GIT_AUTHOR_NAME ?? "Architecture Knowledge Platform",
    process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",
  );
  const branchName = await store.createDraftBranch(reviewId, baseRevision);
  try {
    const proposedChanges = await Promise.all(
      input.changes.map(async (change) => ({
        path: change.path,
        operation: (await store.hasFileAtRevision(baseRevision, change.path))
          ? ("UPDATE" as const)
          : ("CREATE" as const),
        reasons: [change.reason ?? input.defaultReason],
      })),
    );
    for (const change of input.changes) {
      await store.writeDraftFile(change.path, change.content);
    }
    const headCommit = await store.commitAll(
      input.summary,
      process.env.AKP_GIT_AUTHOR_NAME ?? "Architecture Knowledge Platform",
      process.env.AKP_GIT_AUTHOR_EMAIL ?? "akp@localhost",
    );
    await db.pool.query(
      `
      insert into reviews(id,space_id,vault_id,branch_name,base_commit,head_commit,status,author_id,
                          impact_manifest,validation_report)
      values($1,$2,$3,$4,$5,$6,'PENDING',$7,$8::jsonb,$9::jsonb)
      `,
      [
        reviewId,
        input.spaceId,
        input.vaultId,
        branchName,
        baseRevision,
        headCommit,
        input.authorId,
        JSON.stringify({ ...input.impactManifest, proposedChanges }),
        JSON.stringify(input.validationReport),
      ],
    );
    return {
      reviewId,
      branchName,
      baseRevision,
      headCommit,
      proposedChanges,
    };
  } catch (error) {
    await store.cleanupDraft(branchName).catch(() => undefined);
    throw error;
  }
}
