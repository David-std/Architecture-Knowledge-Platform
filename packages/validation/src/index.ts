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

  if (parsed.content.trim().length < 100) {
    issues.push({
      code: "CONTENT_TOO_THIN",
      severity: "WARNING",
      message: "Document body is too small to be substantive.",
    });
  }

  return issues;
}
