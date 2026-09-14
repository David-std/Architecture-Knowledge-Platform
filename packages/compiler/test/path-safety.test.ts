import { describe, expect, it } from "vitest";
import {
  assertCompilerAuthoredKnowledgePath,
  assertSafeKnowledgePath,
} from "../src/index.js";

describe("knowledge path safety", () => {
  it("accepts a repository-relative Markdown path", () => {
    expect(() =>
      assertSafeKnowledgePath("20-knowledge/generated/source.md"),
    ).not.toThrow();
  });

  it.each(["../secret.md", "/absolute.md", "a/../../secret.md", "a\0b.md"])(
    "rejects traversal or absolute path %s",
    (candidate) => {
      expect(() => assertSafeKnowledgePath(candidate)).toThrow(
        /Unsafe knowledge path/,
      );
      expect(() => assertCompilerAuthoredKnowledgePath(candidate)).toThrow(
        /Unsafe knowledge path/,
      );
    },
  );

  it.each(["README.md", "docs/status.md", ".obsidian/config"])(
    "rejects vault infrastructure path %s at every boundary",
    (candidate) => {
      expect(() => assertSafeKnowledgePath(candidate)).toThrow(
        /Unsafe knowledge path/,
      );
      expect(() => assertCompilerAuthoredKnowledgePath(candidate)).toThrow(
        /Unsafe knowledge path/,
      );
    },
  );

  it.each(["10-sources/raw.md", "10-sources/evidence/curated.md"])(
    "reserves the source layer %s for runtime-derived writes only",
    (candidate) => {
      // A runtime-derived provenance draft is rendered from a fixed template, so the
      // generic write boundary accepts it.
      expect(() => assertSafeKnowledgePath(candidate)).not.toThrow();
      // A model-chosen path must never land where curated evidence lives.
      expect(() => assertCompilerAuthoredKnowledgePath(candidate)).toThrow(
        /Unsafe knowledge path/,
      );
    },
  );

  it("still rejects traversal that escapes through the source layer", () => {
    expect(() => assertSafeKnowledgePath("10-sources/../../escape.md")).toThrow(
      /Unsafe knowledge path/,
    );
  });
});
