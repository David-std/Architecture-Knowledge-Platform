import { describe, expect, it } from "vitest";
import { assertSafeKnowledgePath } from "../src/index.js";

describe("knowledge path safety", () => {
  it("accepts a repository-relative Markdown path", () => {
    expect(() =>
      assertSafeKnowledgePath("10-sources/ingested/source.md"),
    ).not.toThrow();
  });

  it.each(["../secret.md", "/absolute.md", "a/../../secret.md", "a\0b.md"])(
    "rejects traversal or absolute path %s",
    (candidate) => {
      expect(() => assertSafeKnowledgePath(candidate)).toThrow(
        /Unsafe knowledge path/,
      );
    },
  );
});
