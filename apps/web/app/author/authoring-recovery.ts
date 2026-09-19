import type { AuthorDraftState } from "./authoring-types";

export const AUTHOR_RECOVERY_STORAGE_KEY = "akp.author.recovery.v1";

export function parseAuthorRecovery(
  value: string | null,
): AuthorDraftState | null {
  if (!value) return null;
  try {
    const candidate = JSON.parse(value) as Partial<AuthorDraftState>;
    if (
      typeof candidate.spaceId !== "string" ||
      typeof candidate.vaultId !== "string" ||
      typeof candidate.summary !== "string" ||
      typeof candidate.path !== "string" ||
      typeof candidate.reason !== "string" ||
      typeof candidate.content !== "string" ||
      typeof candidate.updatedAt !== "string"
    ) {
      return null;
    }
    return {
      spaceId: candidate.spaceId,
      vaultId: candidate.vaultId,
      summary: candidate.summary,
      path: candidate.path,
      reason: candidate.reason,
      content: candidate.content,
      updatedAt: candidate.updatedAt,
    };
  } catch {
    return null;
  }
}

export function serializeAuthorRecovery(
  value: Omit<AuthorDraftState, "updatedAt">,
  now = new Date(),
): string {
  return JSON.stringify({
    ...value,
    updatedAt: now.toISOString(),
  } satisfies AuthorDraftState);
}
