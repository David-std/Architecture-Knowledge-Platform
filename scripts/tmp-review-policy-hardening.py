from pathlib import Path


def replace_once(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"expected one anchor in {path}, found {count}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


policy_path = Path("apps/api/src/review-policy.ts")
replace_once(
    policy_path,
    '    return { policy: defaultReviewPolicy(), pinned: false };',
    '    return { policy: defaultReviewPolicy(), pinned: true };',
)

reviews_path = Path("apps/api/src/routes/reviews.ts")
review_validation_anchor = '''      if (issues.some((issue) => issue.severity === "ERROR")) {
        return reply
          .code(422)
          .send({ code: "DRAFT_VALIDATION_FAILED", issues });
      }

      const previousManifest = (review.impact_manifest ?? {}) as Record<
'''
review_validation_replacement = '''      if (issues.some((issue) => issue.severity === "ERROR")) {
        return reply
          .code(422)
          .send({ code: "DRAFT_VALIDATION_FAILED", issues });
      }
      const revisedReviewKinds = changes.map(
        (change) => parseKnowledgeDocumentMetadata(change.content)?.type,
      );
      if (revisedReviewKinds.some((kind) => !kind)) {
        return reply.code(422).send({ code: "KNOWLEDGE_KIND_REQUIRED" });
      }
      let revisedReviewPolicy: Awaited<
        ReturnType<typeof resolveProposalReviewPolicy>
      >;
      try {
        revisedReviewPolicy = await resolveProposalReviewPolicy(
          db,
          String(review.space_id),
          String(review.vault_id),
          revisedReviewKinds as string[],
        );
      } catch (error) {
        const code = error instanceof Error ? error.message : String(error);
        if (code.startsWith("COMPILER_PROFILE_KIND_NOT_DECLARED:")) {
          return reply.code(422).send({
            code: "KNOWLEDGE_PROFILE_KIND_NOT_ALLOWED",
            kind: code.split(":")[1] ?? "",
          });
        }
        if (code === "COMPILER_REVIEW_POLICY_ROLE_CONFLICT") {
          return reply
            .code(422)
            .send({ code: "KNOWLEDGE_PROFILE_REVIEW_POLICY_CONFLICT" });
        }
        if (code === "ACTIVE_KNOWLEDGE_PROFILE_BINDING_INVALID") {
          return reply.code(409).send({ code });
        }
        throw error;
      }

      const previousManifest = (review.impact_manifest ?? {}) as Record<
'''
replace_once(reviews_path, review_validation_anchor, review_validation_replacement)

manifest_anchor = '''              draftRevision,
              proposedChanges,
            }),
'''
manifest_replacement = '''              draftRevision,
              proposedChanges,
              reviewKinds: [...new Set(revisedReviewKinds as string[])],
              reviewPolicy: revisedReviewPolicy.policy,
              reviewPolicyPinned: revisedReviewPolicy.pinned,
            }),
'''
replace_once(reviews_path, manifest_anchor, manifest_replacement)

test_path = Path("apps/api/test/review-policy.integration.test.ts")
test_text = test_path.read_text(encoding="utf-8")
helper_anchor = '''async function approve(reviewId: string, headers: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: `/v1/reviews/${reviewId}/decision`,
    headers,
    payload: { decision: "APPROVE", reason: "profile policy approval" },
  });
}
'''
helper_replacement = helper_anchor + '''
async function requestChanges(
  reviewId: string,
  headers: Record<string, string>,
) {
  return app.inject({
    method: "POST",
    url: `/v1/reviews/${reviewId}/decision`,
    headers,
    payload: {
      decision: "REQUEST_CHANGES",
      reason: "profile policy revision requested",
    },
  });
}

async function proposedPath(reviewId: string): Promise<string> {
  const result = await db.pool.query<{
    impact_manifest: { proposedChanges?: Array<{ path?: string }> };
  }>("select impact_manifest from reviews where id=$1", [reviewId]);
  const candidate = result.rows[0]?.impact_manifest.proposedChanges?.[0]?.path;
  if (!candidate) throw new Error("TEST_REVIEW_PATH_REQUIRED");
  return candidate;
}
'''
if test_text.count(helper_anchor) != 1:
    raise SystemExit("approve helper anchor mismatch")
test_text = test_text.replace(helper_anchor, helper_replacement, 1)

insert = r'''

  it("revalidates revised kinds instead of reusing the original review policy", async () => {
    const proposed = await propose("note");
    expect(proposed.statusCode).toBe(201);
    const reviewId = (proposed.json() as { reviewId: string }).reviewId;
    const path = await proposedPath(reviewId);
    const before = await db.pool.query<{
      head_commit: string;
      impact_manifest: Record<string, unknown>;
    }>("select head_commit,impact_manifest from reviews where id=$1", [reviewId]);

    const requested = await requestChanges(reviewId, reviewerOneHeaders);
    expect(requested.statusCode).toBe(200);
    expect(requested.json()).toMatchObject({ status: "CHANGES_REQUESTED" });

    const revised = await app.inject({
      method: "POST",
      url: `/v1/reviews/${reviewId}/revise`,
      headers: adminHeaders,
      payload: {
        summary: "attempt disallowed kind revision",
        changes: [{ path, content: documentContent("rule") }],
      },
    });
    expect(revised.statusCode).toBe(422);
    expect(revised.json()).toMatchObject({
      code: "KNOWLEDGE_PROFILE_KIND_NOT_ALLOWED",
      kind: "rule",
    });

    const after = await db.pool.query<{
      head_commit: string;
      impact_manifest: Record<string, unknown>;
    }>("select head_commit,impact_manifest from reviews where id=$1", [reviewId]);
    expect(after.rows[0]?.head_commit).toBe(before.rows[0]?.head_commit);
    expect(after.rows[0]?.impact_manifest).toMatchObject({
      reviewKinds: ["note"],
      reviewPolicy: { profileRevisionId: activeProfileRevisionId },
    });
  });

  it("pins new v0.3-default proposals so later profile activation makes them stale", async () => {
    await db.pool.query(
      "update vaults set active_knowledge_profile_revision_id=null where id=$1 and space_id=$2",
      [vaultId, spaceId],
    );
    await db.pool.query(
      `update knowledge_profile_revisions
          set status='SUPERSEDED',superseded_at=now(),updated_at=now()
        where vault_id=$1 and status='ACTIVE'`,
      [vaultId],
    );

    const proposed = await propose("rule");
    expect(proposed.statusCode).toBe(201);
    const reviewId = (proposed.json() as { reviewId: string }).reviewId;
    const persisted = await db.pool.query<{
      impact_manifest: Record<string, unknown>;
    }>("select impact_manifest from reviews where id=$1", [reviewId]);
    expect(persisted.rows[0]?.impact_manifest).toMatchObject({
      reviewKinds: ["rule"],
      reviewPolicyPinned: true,
      reviewPolicy: {
        profileSource: "V03_DEFAULT",
        profileRevisionId: null,
      },
    });

    await activateProfile("1.0.3-default-stale");
    const stale = await approve(reviewId, reviewerOneHeaders);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "REVIEW_PROFILE_STALE" });
  });

  it("rebinds an explicit revision to the current profile policy snapshot", async () => {
    const proposed = await propose("note");
    expect(proposed.statusCode).toBe(201);
    const reviewId = (proposed.json() as { reviewId: string }).reviewId;
    const path = await proposedPath(reviewId);
    const requested = await requestChanges(reviewId, reviewerOneHeaders);
    expect(requested.statusCode).toBe(200);

    const newRevisionId = await activateProfile("1.0.4-review-rebind");
    const revised = await app.inject({
      method: "POST",
      url: `/v1/reviews/${reviewId}/revise`,
      headers: adminHeaders,
      payload: {
        summary: "rebind review to current profile",
        changes: [{ path, content: documentContent("note") }],
      },
    });
    expect(revised.statusCode).toBe(200);

    const persisted = await db.pool.query<{
      impact_manifest: Record<string, unknown>;
    }>("select impact_manifest from reviews where id=$1", [reviewId]);
    expect(persisted.rows[0]?.impact_manifest).toMatchObject({
      reviewKinds: ["note"],
      reviewPolicyPinned: true,
      reviewPolicy: {
        minimumApprovals: 2,
        allowedRoles: ["REVIEWER"],
        profileRevisionId: newRevisionId,
      },
    });
  });
'''
end_index = test_text.rfind("\n});")
if end_index < 0:
    raise SystemExit("describe closing anchor missing")
test_text = test_text[:end_index] + insert + test_text[end_index:]
test_path.write_text(test_text, encoding="utf-8")
