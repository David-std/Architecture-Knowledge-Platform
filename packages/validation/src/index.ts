import matter from "gray-matter";
import { z } from "zod";

const Frontmatter = z
  .object({
    type: z.string().min(1),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    status: z.string().min(1),
    knowledge_layer: z.string().min(1),
    id: z.string().min(1).optional(),
    sources: z.array(z.unknown()).optional(),
  })
  .passthrough();

export interface ValidationIssue {
  code: string;
  severity: "ERROR" | "WARNING";
  message: string;
}

const ACTIVE_HTML_TAG =
  /<\s*\/?\s*(?:script|iframe|object|embed|form|svg|math|style|link|meta|base)\b/i;
const ACTIVE_HTML_ATTRIBUTE = /\b(?:on[a-z]+|srcdoc)\s*=/i;
const DANGEROUS_URI =
  /(?:\]\(\s*|(?:href|src|xlink:href)\s*=\s*["']?\s*)(?:(?:javascript|vbscript)\s*:|data\s*:\s*text\/html)/i;

/** Reject active markup instead of trying to repair untrusted generated text. */
export function unsafeGeneratedMarkup(markdownBody: string): string | null {
  if (ACTIVE_HTML_TAG.test(markdownBody)) return "ACTIVE_HTML_TAG";
  if (ACTIVE_HTML_ATTRIBUTE.test(markdownBody)) return "ACTIVE_HTML_ATTRIBUTE";
  if (DANGEROUS_URI.test(markdownBody)) return "DANGEROUS_URI";
  return null;
}

export function parseKnowledgeDocumentMetadata(markdown: string) {
  try {
    const parsed = matter(markdown);
    const result = Frontmatter.safeParse(parsed.data);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function validateMarkdownDocument(markdown: string): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(markdown);
  } catch (error) {
    return [
      { code: "FRONTMATTER_PARSE", severity: "ERROR", message: String(error) },
    ];
  }

  const result = Frontmatter.safeParse(parsed.data);
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push({
        code: "FRONTMATTER_SCHEMA",
        severity: "ERROR",
        message: `${issue.path.join(".")}: ${issue.message}`,
      });
    }
  }

  const unsafeMarkup = unsafeGeneratedMarkup(parsed.content);
  if (unsafeMarkup) {
    issues.push({
      code: "UNSAFE_ACTIVE_MARKUP",
      severity: "ERROR",
      message:
        "Generated Markdown contains unsafe active markup: " +
        unsafeMarkup +
        ".",
    });
  }

  if (parsed.content.trim().length < 100) {
    issues.push({
      code: "CONTENT_TOO_THIN",
      severity: "WARNING",
      message: "Document body is too small to be substantive.",
    });
  }

  return issues;
}
