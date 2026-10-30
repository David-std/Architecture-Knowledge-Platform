import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  embeddingPassageInputHash,
  embeddingPassageText,
  TITLE_HEADING_INPUT_SUFFIX,
} from "../src/embedding-input.js";

const body =
  "| Condition | Choice |\n|---|---|\n| When power is absent | Manual inspection |";
const input = {
  title: "Sensor inspection",
  headingPath: ["Operation", "Power"],
  body,
};
const strategy = `e5-query-passage-prefix-v1${TITLE_HEADING_INPUT_SUFFIX}`;

describe("versioned embedding passage input", () => {
  it("preserves existing body-only strategies and hashes exact UTF-8 bytes", () => {
    expect(embeddingPassageText(input, "e5-query-passage-prefix-v1")).toBe(
      body,
    );
    expect(embeddingPassageInputHash(input, "e5-query-passage-prefix-v1")).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
    expect(embeddingPassageText(input, "legacy-unit-v1")).toBe(body);
  });

  it("adds bounded structural scope while preserving the complete original body", () => {
    expect(embeddingPassageText(input, strategy)).toBe(
      `Document: Sensor inspection\nSection: Operation > Power\n\n${body}`,
    );
    expect(embeddingPassageText(input, strategy).endsWith(body)).toBe(true);
    expect(embeddingPassageInputHash(input, strategy)).not.toBe(
      embeddingPassageInputHash(input, "e5-query-passage-prefix-v1"),
    );
    expect(
      embeddingPassageInputHash(
        { ...input, title: "Other inspection" },
        strategy,
      ),
    ).not.toBe(embeddingPassageInputHash(input, strategy));
    expect(
      embeddingPassageInputHash(
        { ...input, headingPath: ["Calibration"] },
        strategy,
      ),
    ).not.toBe(embeddingPassageInputHash(input, strategy));
    expect(
      embeddingPassageInputHash(
        { ...input, title: "Other inspection" },
        "e5-query-passage-prefix-v1",
      ),
    ).toBe(embeddingPassageInputHash(input, "e5-query-passage-prefix-v1"));
  });

  it("caps Unicode code points without splitting surrogates and retains nearest headings", () => {
    const value = embeddingPassageText(
      {
        ...input,
        title: "🚀".repeat(200),
        headingPath: ["root", "é".repeat(400)],
      },
      strategy,
    );
    expect(value).toBe(
      `Document: ${"🚀".repeat(160)}\nSection: ${"é".repeat(320)}\n\n${body}`,
    );
  });
});
