"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { akp } from "../../lib/api";
import type { AuthorActionState } from "./authoring-types";

function required(formData: FormData, name: string): string {
  const value = String(formData.get(name) ?? "").trim();
  if (!value) throw new Error(`AUTHOR_${name.toUpperCase()}_REQUIRED`);
  return value;
}

export async function saveAuthorDraft(
  _previous: AuthorActionState,
  formData: FormData,
): Promise<AuthorActionState> {
  try {
    const spaceId = required(formData, "spaceId");
    const vaultId = required(formData, "vaultId");
    const summary = required(formData, "summary");
    const path = required(formData, "path");
    const reason = required(formData, "reason");
    const content = required(formData, "content");
    const created = await akp<{
      reviewId: string;
      status: string;
      branchName: string;
      headCommit: string;
    }>("/v1/proposals", {
      method: "POST",
      headers: {
        "idempotency-key": `web-author-save-${randomUUID()}`,
      },
      body: JSON.stringify({
        spaceId,
        vaultId,
        summary,
        changes: [{ path, content, reason }],
      }),
    });
    revalidatePath("/reviews");
    return {
      phase: "SAVED",
      reviewId: created.reviewId,
      headCommit: created.headCommit,
      message:
        "Draft Git guardado y validado. Aún requiere Submit review y decisión autorizada para publicarse.",
    };
  } catch (error) {
    return {
      phase: "ERROR",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function submitAuthorReview(
  _previous: AuthorActionState,
  formData: FormData,
): Promise<AuthorActionState> {
  const reviewId = String(formData.get("reviewId") ?? "").trim();
  if (!reviewId) {
    return { phase: "ERROR", message: "AUTHOR_REVIEW_ID_REQUIRED" };
  }
  try {
    await akp(`/v1/reviews/${encodeURIComponent(reviewId)}/submit`, {
      method: "POST",
      headers: {
        "idempotency-key": `web-author-submit-${randomUUID()}`,
      },
      body: JSON.stringify({}),
    });
    revalidatePath("/reviews");
    revalidatePath(`/reviews/${reviewId}`);
    return {
      phase: "SUBMITTED",
      reviewId,
      message:
        "Review enviado. La publicación sigue sujeta a autorización y aprobación humana.",
    };
  } catch (error) {
    return {
      phase: "ERROR",
      reviewId,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
