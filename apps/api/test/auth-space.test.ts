import { describe, expect, it } from "vitest";
import { hasPathAccess, hasPermission, type Actor } from "../src/auth.js";

const actor: Actor = {
  id: "actor",
  email: "actor@example.test",
  roles: ["ADMIN", "VIEWER"],
  spaceIds: ["space-a", "space-b"],
  memberships: [
    { spaceId: "space-a", role: "ADMIN", pathPrefix: null },
    { spaceId: "space-b", role: "VIEWER", pathPrefix: "shared" },
  ],
  authenticationKind: "API_TOKEN",
  idempotencyScopeFingerprint: "test-fingerprint",
};

describe("space-scoped authorization", () => {
  it("does not project an administrator role into another space", () => {
    expect(hasPermission(actor, "admin", "space-a")).toBe(true);
    expect(hasPermission(actor, "admin", "space-b")).toBe(false);
  });

  it("enforces path prefixes together with role permissions", () => {
    expect(
      hasPathAccess(actor, "space-b", "knowledge:read", "shared/note.md"),
    ).toBe(true);
    expect(
      hasPathAccess(actor, "space-b", "knowledge:read", "private/note.md"),
    ).toBe(false);
  });
});
