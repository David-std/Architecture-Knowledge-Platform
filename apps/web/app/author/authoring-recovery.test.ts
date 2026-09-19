import { describe, expect, it } from "vitest";
import {
  AUTHOR_RECOVERY_STORAGE_KEY,
  parseAuthorRecovery,
  serializeAuthorRecovery,
} from "./authoring-recovery";

describe("authoring recovery boundary", () => {
  it("serializes only browser recovery state with an explicit timestamp", () => {
    const serialized = serializeAuthorRecovery(
      {
        spaceId: "11111111-1111-4111-8111-111111111111",
        vaultId: "22222222-2222-4222-8222-222222222222",
        summary: "Document cache invalidation rule",
        path: "20-knowledge/rules/cache.md",
        reason: "Capture reviewed operational knowledge",
        content: "# Cache rule",
      },
      new Date("2026-09-19T21:00:00.000Z"),
    );

    expect(AUTHOR_RECOVERY_STORAGE_KEY).toBe("akp.author.recovery.v1");
    expect(parseAuthorRecovery(serialized)).toEqual({
      spaceId: "11111111-1111-4111-8111-111111111111",
      vaultId: "22222222-2222-4222-8222-222222222222",
      summary: "Document cache invalidation rule",
      path: "20-knowledge/rules/cache.md",
      reason: "Capture reviewed operational knowledge",
      content: "# Cache rule",
      updatedAt: "2026-09-19T21:00:00.000Z",
    });
  });

  it("rejects malformed or incomplete recovery without inventing fields", () => {
    expect(parseAuthorRecovery(null)).toBeNull();
    expect(parseAuthorRecovery("{bad json")).toBeNull();
    expect(
      parseAuthorRecovery(
        JSON.stringify({
          vaultId: "22222222-2222-4222-8222-222222222222",
          content: "# partial",
        }),
      ),
    ).toBeNull();
  });
});
