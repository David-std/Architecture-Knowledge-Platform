import { describe, expect, it } from "vitest";
import { sanitizeEvidenceLocator } from "../src/routes/search.js";
import { reviewAccessPaths } from "../src/routes/reviews.js";

describe("retrieval security boundaries", () => {
  it("redacts local paths and drops private locator keys recursively", () => {
    expect(
      sanitizeEvidenceLocator({
        kind: "paragraph",
        page: 4,
        localPath: "/home/runner/private/source.pdf",
        object_key: "raw/private-object",
        nested: {
          note: "captured from /tmp/private/source.pdf",
          uri: "file:///etc/passwd",
        },
      }),
    ).toEqual({
      kind: "paragraph",
      page: 4,
      nested: { note: "captured from [REDACTED_PATH]" },
    });
  });

  it("treats compiler retrieval candidates as part of review path authorization", () => {
    expect(
      reviewAccessPaths({
        impact_manifest: {
          proposedChanges: [{ path: "public/proposal.md" }],
          reviewContext: {
            existingCandidates: [
              { path: "public/context.md" },
              { path: "private/secret.md" },
            ],
          },
        },
      }),
    ).toEqual(["public/proposal.md", "public/context.md", "private/secret.md"]);
  });
});
