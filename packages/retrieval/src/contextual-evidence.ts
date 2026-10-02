import type {
  QueryConditionedEvidenceVerification,
  QueryConditionedEvidenceVerifier,
  QueryConditionedEvidenceVerifierInput,
} from "./answerability.js";
import { resolveLocalSemanticCacheDir } from "./local-semantic-embedding.js";
import { markdownTableEvidence } from "./markdown-table-evidence.js";
import { markdownVisibleSource } from "./markdown-visible-source.js";

/**
 * Multilingual cross-encoder trained on query/passage relevance, including
 * hard negatives that mention the topic but not the answer. Pinned to an ONNX
 * export so the runtime is reproducible offline.
 */
export const CONTEXTUAL_CROSS_ENCODER_MODEL =
  "onnx-community/bge-reranker-v2-m3-ONNX";
export const CONTEXTUAL_CROSS_ENCODER_REVISION =
  "6f5ff65298512715a1e669753bc754d2bc8f367b";
/**
 * Support threshold calibrated on the development split of
 * evals/generic/evidence-admission; held-out domains are reported, not tuned.
 */
export const CONTEXTUAL_CROSS_ENCODER_DEFAULT_SUPPORT_SCORE = 0.2;

export interface ContextualEvidenceInput {
  readonly title: string;
  readonly headingPath?: readonly string[] | null;
  readonly passage: string;
}

export interface ContextualEvidenceSegment {
  /** One passage line, or one table row restated with its column headers. */
  readonly text: string;
  /** Source positions per UTF-16 character of the normalized body key. */
  readonly characterSpans?: readonly {
    startOffset: number;
    endOffset: number;
  }[];
  /** UTF-16 offsets of the line or row in the original passage. */
  readonly sourceSpan: {
    readonly startOffset: number;
    readonly endOffset: number;
  };
}

export interface ContextualEvidenceText {
  /** Unit title and heading path; they identify what the body is about. */
  readonly scope: string;
  /** Body without link targets, with each table row stated with its headers. */
  readonly body: string;
  readonly text: string;
  /** Body lines in order, each traceable to the original passage. */
  readonly segments: readonly ContextualEvidenceSegment[];
  /** Non-evidence source ranges cannot appear inside an admitted quote. */
  readonly hiddenSourceSpans?: readonly {
    startOffset: number;
    endOffset: number;
  }[];
}

function collapsed(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** A link names where to read more; it does not assert the target's content. */
function withoutLinkTargets(value: string): string {
  return value
    .replace(/\[\[[^\]]*\]\]/gu, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1");
}

/** Source mapping for prose normalization; link targets cannot supply quotes. */
function visibleProse(
  raw: string,
  base: number,
): {
  text: string;
  positions: Array<{ startOffset: number; endOffset: number }>;
} {
  let visible = "";
  const positions: Array<{ startOffset: number; endOffset: number }> = [];
  const append = (text: string, start: number, end?: number): void => {
    visible += text;
    for (let index = 0; index < text.length; index++)
      positions.push({
        startOffset: base + start + (end === undefined ? index : 0),
        endOffset: base + (end === undefined ? start + index + 1 : end),
      });
  };
  let cursor = 0;
  for (const match of raw.matchAll(/\[\[[^\]]*\]\]|\[([^\]]*)\]\([^)]*\)/gu)) {
    append(raw.slice(cursor, match.index), cursor);
    if (match[1] === undefined)
      append(" ", match.index, match.index + match[0].length);
    else append(match[1], match.index + 1);
    cursor = match.index + match[0].length;
  }
  append(raw.slice(cursor), cursor);

  return { text: visible, positions };
}

function normalizedCharacterSpans(
  visible: string,
  positions: Array<{ startOffset: number; endOffset: number }>,
): Array<{ startOffset: number; endOffset: number }> {
  let normalized = "";
  const normalizedPositions: typeof positions = [];
  for (const part of new Intl.Segmenter("und", {
    granularity: "grapheme",
  }).segment(visible)) {
    const value = part.segment.normalize("NFC");
    normalized += value;
    const span = {
      startOffset: positions[part.index]!.startOffset,
      endOffset: positions[part.index + part.segment.length - 1]!.endOffset,
    };
    for (let index = 0; index < value.toLocaleLowerCase("und").length; index++)
      normalizedPositions.push(span);
  }
  const lower = normalized.toLocaleLowerCase("und");
  const retained: typeof positions = [];
  const chars: string[] = [];
  for (let index = 0; index < lower.length; index++) {
    const character = lower[index]!;
    if (/\s/u.test(character)) {
      if (chars.at(-1) === " ") {
        retained[retained.length - 1]!.endOffset =
          normalizedPositions[index]!.endOffset;
        continue;
      }
      chars.push(" ");
    } else chars.push(character);
    retained.push({ ...normalizedPositions[index]! });
  }
  const key = chars.join("");
  const prefix = key.match(/^["'“”‘’«»\s]+/u)?.[0].length ?? 0;
  const suffix = key.match(/["'“”‘’«»\s]+$/u)?.[0].length ?? 0;
  return retained.slice(prefix, suffix ? -suffix : undefined);
}

function proseCharacterSpans(raw: string, base: number) {
  const visible = visibleProse(raw, base);
  return normalizedCharacterSpans(visible.text, visible.positions);
}

function textSegments(
  passage: string,
  startOffset: number,
  endOffset: number,
): ContextualEvidenceSegment[] {
  const segments: ContextualEvidenceSegment[] = [];
  let lineStart = startOffset;
  while (lineStart < endOffset) {
    const newline = passage.indexOf("\n", lineStart);
    const lineEnd = newline < 0 || newline >= endOffset ? endOffset : newline;
    const text = collapsed(
      withoutLinkTargets(passage.slice(lineStart, lineEnd)),
    );
    if (text) {
      segments.push({
        text,
        characterSpans: proseCharacterSpans(
          passage.slice(lineStart, lineEnd),
          lineStart,
        ),
        sourceSpan: { startOffset: lineStart, endOffset: lineEnd },
      });
    }
    lineStart = lineEnd + 1;
  }
  return segments;
}

/**
 * Restate each table row with its column headers. A reader sees a row as one
 * statement ("Condition: X; Action: Y") instead of a run of pipes in which a
 * cell is detached from the header that gives it meaning.
 */
function tableSegments(
  table: ReturnType<typeof markdownTableEvidence>[number],
): ContextualEvidenceSegment[] {
  const headers = table.header.cells.map((cell) =>
    collapsed(withoutLinkTargets(cell.source)),
  );
  const rows = table.rows.flatMap((row) => {
    let raw = "";
    const positions: Array<{ startOffset: number; endOffset: number }> = [];
    const appendContext = (text: string, offset: number): void => {
      raw += text;
      for (let index = 0; index < text.length; index++)
        positions.push({ startOffset: offset, endOffset: offset });
    };
    for (const cell of row.cells) {
      const visible = visibleProse(cell.source, cell.span.startOffset);
      if (!collapsed(visible.text)) continue;
      if (raw) appendContext("; ", positions.at(-1)!.endOffset);
      const header = headers[cell.columnIndex];
      // Restated headers identify the column, but contain no answer bytes.
      if (header) appendContext(`${header}: `, cell.span.startOffset);
      raw += visible.text;
      positions.push(...visible.positions);
    }
    return raw ? [{ raw, positions, sourceSpan: row.span }] : [];
  });
  return rows.map((row, index) => {
    const continued = index < rows.length - 1;
    const raw = continued ? `${row.raw}.` : row.raw;
    const positions = continued
      ? [
          ...row.positions,
          {
            startOffset: row.positions.at(-1)!.endOffset,
            endOffset: row.positions.at(-1)!.endOffset,
          },
        ]
      : row.positions;
    return {
      text: collapsed(raw),
      sourceSpan: row.sourceSpan,
      characterSpans: normalizedCharacterSpans(raw, positions),
    };
  });
}

export function contextualEvidenceText(
  input: ContextualEvidenceInput,
): ContextualEvidenceText {
  const scopeParts: string[] = [];
  for (const part of [input.title, ...(input.headingPath ?? [])]) {
    const value = collapsed(part ?? "");
    if (value && !scopeParts.includes(value)) scopeParts.push(value);
  }
  const scope = scopeParts.join(" > ");
  const visible = markdownVisibleSource(input.passage);
  const passage = visible.text;
  const segments: ContextualEvidenceSegment[] = [];
  let cursor = 0;
  for (const table of markdownTableEvidence(passage)) {
    segments.push(...textSegments(passage, cursor, table.span.startOffset));
    segments.push(...tableSegments(table));
    cursor = table.span.endOffset;
  }
  segments.push(...textSegments(passage, cursor, passage.length));
  const body = segments.map((segment) => segment.text).join("\n");
  return {
    scope,
    body,
    text: scope ? `${scope}\n${body}` : body,
    segments,
    hiddenSourceSpans: visible.comments,
  };
}

function quoteKey(value: string): string {
  return collapsed(value.normalize("NFC"))
    .replace(/^["'“”‘’«»\s]+|["'“”‘’«»\s]+$/gu, "")
    .toLocaleLowerCase("und");
}

/**
 * Locate a quoted answer inside the contextual body and return the original
 * exact prose or table-cell span it covers. Other cells cannot donate facts. Returns null when the
 * quote is not verbatim body text, so a paraphrase or a heading cannot pass
 * as evidence.
 */
export function locateEvidenceQuote(
  contextual: ContextualEvidenceText,
  quote: string,
): { startOffset: number; endOffset: number } | null {
  const needle = quoteKey(quote).replace(/[.;:,]+$/u, "");
  if (needle.length < 2) return null;
  const keys = contextual.segments.map((segment) => quoteKey(segment.text));
  // Lines are joined by a space so a quote may span consecutive lines.
  const joined = keys.join(" ");
  const position = joined.indexOf(needle);
  // Repeated text does not identify which line or row the reader selected.
  // Keep it exploratory until the quote includes enough context to be unique.
  if (position < 0 || joined.indexOf(needle, position + 1) >= 0) return null;
  let offset = 0;
  let first = -1;
  let last = -1;
  let mappedStart: number | undefined;
  let mappedEnd: number | undefined;
  let mappingInvalid = false;
  keys.forEach((key, index) => {
    const start = offset;
    const end = offset + key.length;
    if (end > position && start < position + needle.length) {
      const segment = contextual.segments[index]!;
      if (
        segment.characterSpans &&
        segment.characterSpans.length !== key.length
      ) {
        mappingInvalid = true;
        return;
      }
      const selected = segment.characterSpans
        ?.slice(
          Math.max(0, position - start),
          Math.min(key.length, position + needle.length - start),
        )
        .filter((value) => value.endOffset > value.startOffset);
      if (selected && selected.length === 0) return;
      if (first < 0) {
        first = index;
        mappedStart = selected?.[0]?.startOffset;
      }
      last = index;
      mappedEnd = selected?.at(-1)?.endOffset;
    }
    offset = end + 1;
  });
  if (mappingInvalid || first < 0) return null;
  const span = {
    startOffset:
      mappedStart ?? contextual.segments[first]!.sourceSpan.startOffset,
    endOffset: mappedEnd ?? contextual.segments[last]!.sourceSpan.endOffset,
  };
  // A header/separator without selected value bytes is context, not evidence.
  if (span.endOffset <= span.startOffset) return null;
  if (
    contextual.hiddenSourceSpans?.some(
      (hidden) =>
        hidden.startOffset < span.endOffset &&
        hidden.endOffset > span.startOffset,
    )
  )
    return null;
  return span;
}

/**
 * Headers scope selected table values without enlarging their source range.
 * Only valueText can satisfy numeric/date presence; header digits cannot.
 */
export function contextualEvidenceSpanText(
  passage: string,
  span: { startOffset: number; endOffset: number },
): {
  scopedText: string;
  valueText: string;
  selectedCells: ReadonlyArray<{
    header: string;
    value: string;
    rowScope: string;
  }>;
} {
  const visible = markdownVisibleSource(passage).text;
  const scoped: string[] = [];
  const values: string[] = [];
  const selectedCells: Array<{
    header: string;
    value: string;
    rowScope: string;
  }> = [];
  const addProse = (start: number, end: number): void => {
    if (end <= start) return;
    const text = collapsed(withoutLinkTargets(visible.slice(start, end)));
    if (text) {
      scoped.push(text);
      values.push(text);
    }
  };
  let cursor = span.startOffset;
  for (const table of markdownTableEvidence(visible)) {
    if (
      table.span.endOffset <= span.startOffset ||
      table.span.startOffset >= span.endOffset
    )
      continue;
    addProse(cursor, Math.min(span.endOffset, table.span.startOffset));
    for (const row of table.rows)
      for (const cell of row.cells) {
        const start = Math.max(span.startOffset, cell.span.startOffset);
        const end = Math.min(span.endOffset, cell.span.endOffset);
        if (end <= start) continue;
        const value = collapsed(withoutLinkTargets(visible.slice(start, end)));
        if (!value) continue;
        const header = collapsed(
          withoutLinkTargets(
            table.header.cells[cell.columnIndex]?.source ?? "",
          ),
        );
        const rowKey = cell.columnIndex > 0 ? row.cells[0] : undefined;
        const rowHeader = rowKey
          ? collapsed(withoutLinkTargets(table.header.cells[0]?.source ?? ""))
          : "";
        const rowValue = rowKey
          ? collapsed(
              withoutLinkTargets(
                visible.slice(rowKey.span.startOffset, rowKey.span.endOffset),
              ),
            )
          : "";
        const rowScope = rowValue
          ? rowHeader
            ? `${rowHeader}: ${rowValue}`
            : rowValue
          : "";
        const selectedValue = header ? `${header}: ${value}` : value;
        scoped.push(rowScope ? `${rowScope}; ${selectedValue}` : selectedValue);
        values.push(value);
        selectedCells.push({ header, value, rowScope });
      }
    cursor = Math.max(cursor, table.span.endOffset);
  }
  addProse(cursor, span.endOffset);
  return {
    scopedText: scoped.join("; "),
    valueText: values.join("; "),
    selectedCells,
  };
}

export interface CrossEncoderPair {
  readonly query: string;
  readonly passage: string;
}

export interface CrossEncoderRuntime {
  /** Relevance scores in input order; these are not calibrated answerability probabilities. */
  score(pairs: readonly CrossEncoderPair[]): Promise<number[]>;
  readonly dispose?: () => Promise<void> | void;
}

export interface CrossEncoderRuntimeLoadOptions {
  readonly model: string;
  readonly revision: string;
  readonly cacheDir?: string;
  readonly localFilesOnly: boolean;
  readonly maxTokens: number;
  readonly batchSize: number;
}

export type CrossEncoderRuntimeFactory = (
  options: CrossEncoderRuntimeLoadOptions,
) => Promise<CrossEncoderRuntime>;

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

export const defaultCrossEncoderRuntimeFactory: CrossEncoderRuntimeFactory =
  async (options) => {
    const { AutoModelForSequenceClassification, AutoTokenizer } =
      await import("@huggingface/transformers");
    const shared = {
      revision: options.revision,
      local_files_only: options.localFilesOnly,
      ...(options.cacheDir === undefined
        ? {}
        : { cache_dir: options.cacheDir }),
    };
    const tokenizer = await AutoTokenizer.from_pretrained(
      options.model,
      shared,
    );
    const model = await AutoModelForSequenceClassification.from_pretrained(
      options.model,
      {
        ...shared,
        subfolder: "onnx",
        model_file_name: "model",
        dtype: "int8",
        device: "cpu",
      },
    );
    return {
      async score(pairs) {
        // Group similar lengths so padding does not dominate the batch cost.
        const order = pairs
          .map((pair, index) => ({
            index,
            length: pair.query.length + pair.passage.length,
          }))
          .sort((left, right) => left.length - right.length);
        const scores = new Array<number>(pairs.length);
        for (
          let offset = 0;
          offset < order.length;
          offset += options.batchSize
        ) {
          const batch = order.slice(offset, offset + options.batchSize);
          const inputs = await tokenizer(
            batch.map(({ index }) => pairs[index]!.query),
            {
              text_pair: batch.map(({ index }) => pairs[index]!.passage),
              padding: true,
              truncation: true,
              max_length: options.maxTokens,
            },
          );
          const output = (await model(inputs)) as unknown as {
            logits?: { data?: ArrayLike<number>; dims?: readonly number[] };
          };
          const data = output.logits?.data;
          if (!data || data.length < batch.length) {
            throw new Error("CROSS_ENCODER_LOGITS_MISSING");
          }
          const width = data.length / batch.length;
          batch.forEach(({ index }, row) => {
            const logit = Number(data[row * width]);
            if (!Number.isFinite(logit)) {
              throw new Error("CROSS_ENCODER_LOGIT_INVALID");
            }
            scores[index] = sigmoid(logit);
          });
        }
        return scores;
      },
      dispose: async () => {
        await model.dispose?.();
      },
    };
  };

export interface ContextualCrossEncoderEvidenceVerifierOptions {
  /** Calibrated probability at or above which a unit answers the query. */
  readonly minimumSupportScore: number;
  readonly model?: string;
  readonly revision?: string;
  readonly cacheDir?: string;
  readonly localFilesOnly?: boolean;
  readonly maxTokens?: number;
  readonly batchSize?: number;
  readonly runtimeFactory?: CrossEncoderRuntimeFactory;
}

function validatedProbability(value: number, field: string): number {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new Error(`${field} must be in (0,1)`);
  }
  return value;
}

function validatedInteger(
  value: number,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer in [${minimum},${maximum}]`);
  }
  return value;
}

/**
 * Query-conditioned evidence verifier that reads each unit the way a person
 * does: under its title and headings, with table cells bound to their
 * headers. The cross-encoder score is compared with a threshold calibrated on
 * development data; support is stated for the exact supplied passage.
 */
export class ContextualCrossEncoderEvidenceVerifier implements QueryConditionedEvidenceVerifier {
  readonly id: string;
  private readonly minimumSupportScore: number;
  private readonly loadOptions: CrossEncoderRuntimeLoadOptions;
  private readonly runtimeFactory: CrossEncoderRuntimeFactory;
  private runtime: Promise<CrossEncoderRuntime> | null = null;

  constructor(options: ContextualCrossEncoderEvidenceVerifierOptions) {
    this.minimumSupportScore = validatedProbability(
      options.minimumSupportScore,
      "contextual cross-encoder minimumSupportScore",
    );
    const model = options.model ?? CONTEXTUAL_CROSS_ENCODER_MODEL;
    const revision = options.revision ?? CONTEXTUAL_CROSS_ENCODER_REVISION;
    const cacheDir = resolveLocalSemanticCacheDir(options.cacheDir);
    this.loadOptions = {
      model,
      revision,
      ...(cacheDir === undefined ? {} : { cacheDir }),
      localFilesOnly: options.localFilesOnly ?? false,
      maxTokens: validatedInteger(
        options.maxTokens ?? 512,
        "contextual cross-encoder maxTokens",
        64,
        8192,
      ),
      batchSize: validatedInteger(
        options.batchSize ?? 8,
        "contextual cross-encoder batchSize",
        1,
        256,
      ),
    };
    this.runtimeFactory =
      options.runtimeFactory ?? defaultCrossEncoderRuntimeFactory;
    this.id = `contextual-cross-encoder:${model}@${revision}`;
  }

  private getRuntime(): Promise<CrossEncoderRuntime> {
    this.runtime ??= this.runtimeFactory(this.loadOptions).catch((error) => {
      this.runtime = null;
      throw error;
    });
    return this.runtime;
  }

  async scoreBatch(
    inputs: readonly QueryConditionedEvidenceVerifierInput[],
  ): Promise<number[]> {
    if (inputs.length === 0) return [];
    const runtime = await this.getRuntime();
    const scores = await runtime.score(
      inputs.map((input) => ({
        query: input.query,
        passage: contextualEvidenceText({
          title: input.title,
          headingPath: input.headingPath ?? null,
          passage: input.passage,
        }).text,
      })),
    );
    if (
      scores.length !== inputs.length ||
      scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
    ) {
      throw new Error("CROSS_ENCODER_SCORES_INVALID");
    }
    return scores;
  }

  decide(
    input: QueryConditionedEvidenceVerifierInput,
    score: number,
  ): QueryConditionedEvidenceVerification {
    if (!input.passage.trim()) {
      return { decision: "INSUFFICIENT", score, reason: "EMPTY_PASSAGE" };
    }
    if (score < this.minimumSupportScore) {
      return {
        decision: "INSUFFICIENT",
        score,
        reason: "CROSS_ENCODER_BELOW_SUPPORT_THRESHOLD",
      };
    }
    return {
      decision: "SUPPORTS",
      score,
      evidenceSpan: { startOffset: 0, endOffset: input.passage.length },
      reason: "CROSS_ENCODER_CONTEXTUAL_SUPPORT",
    };
  }

  async verify(
    input: QueryConditionedEvidenceVerifierInput,
  ): Promise<QueryConditionedEvidenceVerification> {
    const [score] = await this.scoreBatch([input]);
    return this.decide(input, score!);
  }

  async verifyBatch(
    inputs: readonly QueryConditionedEvidenceVerifierInput[],
  ): Promise<QueryConditionedEvidenceVerification[]> {
    const scores = await this.scoreBatch(inputs);
    return inputs.map((input, index) => this.decide(input, scores[index]!));
  }

  async dispose(): Promise<void> {
    const runtime = this.runtime;
    this.runtime = null;
    if (runtime) await (await runtime).dispose?.();
  }
}
