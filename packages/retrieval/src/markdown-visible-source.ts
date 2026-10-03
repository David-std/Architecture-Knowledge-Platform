import { fromMarkdown } from "mdast-util-from-markdown";

export interface MarkdownCommentSpan {
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
}

/**
 * Mask HTML comments identified inside Markdown HTML nodes. Code examples
 * remain literal source. Spaces retain every UTF-16 position and line ending,
 * including astral characters, so a source quote cannot shift after masking.
 */
export function markdownVisibleSource(source: string): {
  text: string;
  comments: MarkdownCommentSpan[];
} {
  const comments: MarkdownCommentSpan[] = [];
  if (!source.includes("<!--")) return { text: source, comments };
  const tree = fromMarkdown(source);
  type Node = {
    type: string;
    value?: string | undefined;
    children?: readonly Node[] | undefined;
    position?:
      | {
          start: { offset?: number | undefined; line: number };
          end: { offset?: number | undefined; line: number };
        }
      | undefined;
  };
  const lineOffsets = [0];
  for (const ending of source.matchAll(/\r\n|\r|\n/g))
    lineOffsets.push(ending.index + ending[0].length);
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineOffsets.length;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (lineOffsets[middle]! <= offset) low = middle;
      else high = middle;
    }
    return low + 1;
  };
  const visit = (node: Node): void => {
    const base = node.position?.start.offset;
    if (node.type === "html" && node.value && base !== undefined) {
      for (const match of node.value.matchAll(/<!--[\s\S]*?(?:-->|$)/g)) {
        const startOffset = base + match.index;
        const endOffset = startOffset + match[0].length;
        comments.push({
          startOffset,
          endOffset,
          startLine: lineAt(startOffset),
          endLine: lineAt(endOffset - 1),
        });
      }
    }
    node.children?.forEach(visit);
  };
  visit(tree);
  let cursor = 0;
  let text = "";
  for (const comment of comments.sort(
    (a, b) => a.startOffset - b.startOffset,
  )) {
    text += source.slice(cursor, comment.startOffset);
    text += source
      .slice(comment.startOffset, comment.endOffset)
      .replace(/[^\r\n]/g, " ");
    cursor = comment.endOffset;
  }
  text += source.slice(cursor);
  return { text, comments };
}
