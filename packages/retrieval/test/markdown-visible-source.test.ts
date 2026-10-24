import { describe, expect, it } from "vitest";
import { markdownVisibleSource } from "../src/markdown-visible-source.js";

describe("Markdown source visibility", () => {
  it("masks comments without moving UTF-16 positions or line endings", () => {
    const source =
      "Visible.\r\n<!-- 🧭 Hidden\r\ncontinuation -->\r\nRetained.";
    const result = markdownVisibleSource(source);
    expect(result.text.length).toBe(source.length);
    expect(result.text.indexOf("Retained.")).toBe(source.indexOf("Retained."));
    expect(result.text.match(/\r\n/g)).toHaveLength(3);
    expect(result.comments).toEqual([
      {
        startOffset: source.indexOf("<!--"),
        endOffset: source.indexOf("-->") + 3,
        startLine: 2,
        endLine: 3,
      },
    ]);
  });

  it("also hides an unterminated HTML comment block", () => {
    const result = markdownVisibleSource(
      "Visible.\n\n<!-- Unpublished claim.\nStill hidden.",
    );
    expect(result.text.trim()).toBe("Visible.");
    expect(result.comments).toHaveLength(1);
  });

  it.each([
    "Use `<!-- literal -->` in a template.",
    "```html\n<!-- literal -->\n```",
    "~~~html\n<!-- literal -->\n~~~",
    "    <!-- literal -->",
    "\\<!-- literal -->",
  ])("preserves code or escaped literal syntax: %s", (source) => {
    expect(markdownVisibleSource(source)).toEqual({
      text: source,
      comments: [],
    });
  });

  it("masks inline comments independently of surrounding prose", () => {
    const source = "The first fact. <!-- Unreviewed draft. --> The next fact.";
    const result = markdownVisibleSource(source);
    expect(result.text).toContain("The first fact.");
    expect(result.text).toContain("The next fact.");
    expect(result.text).not.toContain("Unreviewed");
  });
});
