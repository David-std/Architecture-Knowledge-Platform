import { createHash } from "node:crypto";

/** Versioned, bounded passage context; never an assertion or query expansion. */
export const TITLE_HEADING_INPUT_SUFFIX = "+title-heading-v1";
export type EmbeddingPassageContext = "body-v1" | "title-heading-v1";

export interface EmbeddingPassageInput {
  body: string;
  title: string;
  headingPath: readonly string[];
}

export function embeddingPassageContext(
  inputStrategy: string,
): EmbeddingPassageContext {
  return inputStrategy.endsWith(TITLE_HEADING_INPUT_SUFFIX)
    ? "title-heading-v1"
    : "body-v1";
}

export function baseEmbeddingInputStrategy(inputStrategy: string): string {
  return embeddingPassageContext(inputStrategy) === "title-heading-v1"
    ? inputStrategy.slice(0, -TITLE_HEADING_INPUT_SUFFIX.length)
    : inputStrategy;
}

/** Keep the original body and its offsets intact. Caps count Unicode code points. */
export function embeddingPassageText(
  input: EmbeddingPassageInput,
  inputStrategy: string,
): string {
  if (embeddingPassageContext(inputStrategy) === "body-v1") return input.body;
  const title = Array.from(input.title).slice(0, 160).join("");
  const heading = Array.from(input.headingPath.join(" > "))
    .slice(-320)
    .join("");
  return `Document: ${title}\nSection: ${heading}\n\n${input.body}`;
}

/** Hash the exact pre-provider text, independently of the canonical unit body hash. */
export function embeddingPassageInputHash(
  input: EmbeddingPassageInput,
  inputStrategy: string,
): string {
  return createHash("sha256")
    .update(embeddingPassageText(input, inputStrategy), "utf8")
    .digest("hex");
}
