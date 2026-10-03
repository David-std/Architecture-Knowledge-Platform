import type {
  QueryConditionedEvidenceSpan,
  QueryConditionedEvidenceVerification,
  QueryConditionedEvidenceVerifier,
  QueryConditionedEvidenceVerifierInput,
} from "./answerability.js";
import { resolveLocalSemanticCacheDir } from "./local-semantic-embedding.js";

/**
 * Pinned source revision containing the ONNX export and tokenizer.
 *
 * The model card describes this MiniLMv2 model as multilingual NLI trained
 * with MNLI and XNLI. The adapter remains shadow-only until AKP's own
 * source-disjoint evaluation calibrates it.
 */
export interface LocalMultilingualNliModelDescriptor {
  readonly model: string;
  readonly revision: string;
  readonly modelFileName: string;
  readonly dtype: "fp32" | "q8";
}

export const LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR: LocalMultilingualNliModelDescriptor =
  Object.freeze({
    model: "MoritzLaurer/multilingual-MiniLMv2-L6-mnli-xnli",
    revision: "0a71e92a985b6e1ad1828cf67ce9c459639c1dca",
    modelFileName: "model",
    dtype: "fp32",
  });

export const LOCAL_MULTILINGUAL_NLI_MDEBERTA_DESCRIPTOR: LocalMultilingualNliModelDescriptor =
  Object.freeze({
    model: "onnx-community/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7-ONNX",
    revision: "cdc8277b4682665e2f2e87cd83da7da07b153d75",
    modelFileName: "model",
    dtype: "q8",
  });

export const LOCAL_MULTILINGUAL_NLI_MODEL =
  LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.model;
export const LOCAL_MULTILINGUAL_NLI_REVISION =
  LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR.revision;

export interface LocalMultilingualNliDistribution {
  readonly entailment: number;
  readonly neutral: number;
  readonly contradiction: number;
}

export interface LocalMultilingualNliRuntime {
  infer(
    premise: string,
    hypothesis: string,
  ): Promise<LocalMultilingualNliDistribution>;
  readonly dispose?: () => Promise<void> | void;
}

export interface LocalMultilingualNliRuntimeLoadOptions {
  readonly model: string;
  readonly revision: string;
  readonly modelFileName: string;
  readonly dtype: "fp32" | "q8";
  readonly cacheDir?: string;
  readonly localFilesOnly: boolean;
}

export type LocalMultilingualNliRuntimeFactory = (
  options: LocalMultilingualNliRuntimeLoadOptions,
) => Promise<LocalMultilingualNliRuntime>;

export interface LocalMultilingualNliEvidenceVerifierOptions {
  readonly minimumEntailmentScore: number;
  readonly minimumPolarityMargin: number;
  readonly modelDescriptor?: LocalMultilingualNliModelDescriptor;
  readonly cacheDir?: string;
  readonly localFilesOnly?: boolean;
  readonly runtimeFactory?: LocalMultilingualNliRuntimeFactory;
}

export interface LocalMultilingualNliEvidenceEvaluation {
  readonly score: number | null;
  readonly oppositeScore: number | null;
  readonly polarityMargin: number | null;
  readonly direction: "POSITIVE" | "NEGATIVE" | null;
  readonly evidenceSpan: QueryConditionedEvidenceSpan | null;
  readonly reason: string;
}

export interface EvidenceRelationHypotheses {
  readonly positive: string;
  readonly negative: string;
}

interface PassageWindow {
  text: string;
  premise: string;
  startOffset: number;
  endOffset: number;
}

function probability(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number between 0 and 1`);
  }
  return value;
}

function normalizeDistribution(
  values: readonly number[],
): LocalMultilingualNliDistribution {
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error("LOCAL_MULTILINGUAL_NLI_LOGITS_INVALID");
  }
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("LOCAL_MULTILINGUAL_NLI_SOFTMAX_INVALID");
  }
  return {
    entailment: exps[0]! / total,
    neutral: exps[1]! / total,
    contradiction: exps[2]! / total,
  };
}

function conjugateThirdPerson(verb: string): string {
  if (/(?:s|x|z|ch|sh)$/iu.test(verb)) return `${verb}es`;
  if (/[^aeiou]y$/iu.test(verb)) return `${verb.slice(0, -1)}ies`;
  return `${verb}s`;
}

function spanishYesNoHypotheses(
  query: string,
): EvidenceRelationHypotheses | null {
  const trimmed = query.trim();
  if (!trimmed.startsWith("¿") || !trimmed.endsWith("?")) return null;
  const proposition = trimmed.slice(1, -1).trim();
  if (
    !proposition ||
    /^(?:qué|que|cuál|cuales|cuáles|quién|quienes|quiénes|dónde|donde|cuándo|cuando|cómo|como|por\s+qué|por\s+que|cuánto|cuánta|cuántos|cuántas)(?=\s|$)/iu.test(
      proposition,
    )
  ) {
    return null;
  }
  const lowered =
    proposition.charAt(0).toLocaleLowerCase("es") + proposition.slice(1);
  return {
    positive: `${proposition}.`,
    negative: `No es cierto que ${lowered}.`,
  };
}
export function buildEvidenceRelationHypotheses(
  query: string,
  title?: string,
): EvidenceRelationHypotheses | null {
  const spanish = spanishYesNoHypotheses(query);
  if (spanish) return spanish;
  const normalized = query
    .trim()
    .replace(/^¿\s*/u, "")
    .replace(/[?？]+\s*$/u, "")
    .trim();
  const known =
    /^(do|does|did|can|could|should|must|will|would)\s+(.+?)\s+(define|determine|require|govern|control|establish|set|prevent|allow)\s+(.+)$/iu.exec(
      normalized,
    );

  let auxiliary: string;
  let subject: string;
  let verb: string;
  let object: string;

  if (known) {
    auxiliary = known[1]!.toLocaleLowerCase("en-US");
    subject = known[2]!.trim();
    verb = known[3]!.toLocaleLowerCase("en-US");
    object = known[4]!.trim();
  } else {
    const generic =
      /^(do|does|did|can|could|should|must|will|would)\s+(.+)$/iu.exec(
        normalized,
      );
    if (!generic || !title?.trim()) return null;

    auxiliary = generic[1]!.toLocaleLowerCase("en-US");
    const remainderTokens = generic[2]!.trim().split(/\s+/u).filter(Boolean);
    if (remainderTokens.length < 3) return null;

    const normalizeToken = (value: string) => {
      const token = value
        .toLocaleLowerCase("en-US")
        .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}-]+$/gu, "");
      return token.length > 4 && token.endsWith("s")
        ? token.slice(0, -1)
        : token;
    };
    const titleTokens = new Set(
      title
        .split(/\s+/u)
        .map(normalizeToken)
        .filter((token) => token.length >= 2),
    );
    let subjectEnd = -1;
    for (let index = 0; index < remainderTokens.length; index += 1) {
      if (titleTokens.has(normalizeToken(remainderTokens[index]!))) {
        subjectEnd = index;
      }
    }
    if (subjectEnd < 0 || subjectEnd >= remainderTokens.length - 2) {
      return null;
    }

    subject = remainderTokens.slice(0, subjectEnd + 1).join(" ");
    verb = normalizeToken(remainderTokens[subjectEnd + 1]!);
    object = remainderTokens.slice(subjectEnd + 2).join(" ");
    if (!verb || !object.trim()) return null;
  }

  if (auxiliary === "do") {
    return {
      positive: `${subject} ${verb} ${object}.`,
      negative: `${subject} do not ${verb} ${object}.`,
    };
  }
  if (auxiliary === "does") {
    return {
      positive: `${subject} ${conjugateThirdPerson(verb)} ${object}.`,
      negative: `${subject} does not ${verb} ${object}.`,
    };
  }
  if (auxiliary === "did") {
    return {
      positive: `${subject} did ${verb} ${object}.`,
      negative: `${subject} did not ${verb} ${object}.`,
    };
  }
  return {
    positive: `${subject} ${auxiliary} ${verb} ${object}.`,
    negative: `${subject} ${auxiliary} not ${verb} ${object}.`,
  };
}

/** Sentence spans use Unicode segmentation and retain exact source offsets. */
export function evidenceSentenceWindows(passage: string): PassageWindow[] {
  const windows: PassageWindow[] = [];
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  for (const { segment, index } of segmenter.segment(passage)) {
    const leading = segment.length - segment.trimStart().length;
    const trailing = segment.length - segment.trimEnd().length;
    const startOffset = index + leading;
    const endOffset = index + segment.length - trailing;
    if (endOffset <= startOffset) continue;
    const text = passage.slice(startOffset, endOffset);
    windows.push({ text, premise: text, startOffset, endOffset });
  }
  return windows;
}

function entailmentIsTop(
  distribution: LocalMultilingualNliDistribution,
): boolean {
  return (
    distribution.entailment > distribution.neutral &&
    distribution.entailment > distribution.contradiction
  );
}

export const defaultLocalMultilingualNliRuntimeFactory: LocalMultilingualNliRuntimeFactory =
  async (options) => {
    const { AutoModelForSequenceClassification, AutoTokenizer } =
      await import("@huggingface/transformers");
    const cacheOptions = {
      revision: options.revision,
      local_files_only: options.localFilesOnly,
      ...(options.cacheDir === undefined
        ? {}
        : { cache_dir: options.cacheDir }),
    };
    const tokenizer = await AutoTokenizer.from_pretrained(
      options.model,
      cacheOptions,
    );
    const model = await AutoModelForSequenceClassification.from_pretrained(
      options.model,
      {
        ...cacheOptions,
        subfolder: "onnx",
        model_file_name: options.modelFileName,
        device: "cpu",
        dtype: options.dtype,
      },
    );

    return {
      infer: async (premise, hypothesis) => {
        const inputs = await tokenizer(premise, {
          text_pair: hypothesis,
          truncation: true,
          max_length: 512,
        });
        const output = (await model(inputs)) as unknown as {
          logits?: { data?: ArrayLike<number> };
        };
        const data = output.logits?.data;
        if (!data || data.length < 3) {
          throw new Error("LOCAL_MULTILINGUAL_NLI_LOGITS_MISSING");
        }
        return normalizeDistribution([
          Number(data[0]),
          Number(data[1]),
          Number(data[2]),
        ]);
      },
      dispose: async () => {
        await model.dispose?.();
      },
    };
  };

export class LocalMultilingualNliEvidenceVerifier implements QueryConditionedEvidenceVerifier {
  readonly id: string;

  private readonly minimumEntailmentScore: number;
  private readonly minimumPolarityMargin: number;
  private readonly modelDescriptor: LocalMultilingualNliModelDescriptor;
  private readonly cacheDir: string | undefined;
  private readonly localFilesOnly: boolean;
  private readonly runtimeFactory: LocalMultilingualNliRuntimeFactory;
  private runtimePromise: Promise<LocalMultilingualNliRuntime> | undefined;

  constructor(options: LocalMultilingualNliEvidenceVerifierOptions) {
    this.minimumEntailmentScore = probability(
      options.minimumEntailmentScore,
      "local multilingual NLI minimumEntailmentScore",
    );
    this.minimumPolarityMargin = probability(
      options.minimumPolarityMargin,
      "local multilingual NLI minimumPolarityMargin",
    );
    this.modelDescriptor =
      options.modelDescriptor ?? LOCAL_MULTILINGUAL_NLI_MINILM_DESCRIPTOR;
    this.cacheDir = resolveLocalSemanticCacheDir(options.cacheDir);
    this.localFilesOnly = options.localFilesOnly ?? false;
    this.runtimeFactory =
      options.runtimeFactory ?? defaultLocalMultilingualNliRuntimeFactory;
    this.id = `local-multilingual-nli:${this.modelDescriptor.model}@${this.modelDescriptor.revision}:entail=${this.minimumEntailmentScore}:margin=${this.minimumPolarityMargin}`;
  }

  async evaluate(
    input: QueryConditionedEvidenceVerifierInput,
  ): Promise<LocalMultilingualNliEvidenceEvaluation> {
    return this.evaluatePassages(input, false);
  }

  private async evaluatePassages(
    input: QueryConditionedEvidenceVerifierInput,
    preferCalibrated: boolean,
  ): Promise<LocalMultilingualNliEvidenceEvaluation> {
    const hypotheses = buildEvidenceRelationHypotheses(
      input.query,
      input.title,
    );
    if (!hypotheses) {
      return {
        score: null,
        oppositeScore: null,
        polarityMargin: null,
        direction: null,
        evidenceSpan: null,
        reason: "LOCAL_MULTILINGUAL_NLI_QUERY_SHAPE_UNSUPPORTED",
      };
    }

    const windows = evidenceSentenceWindows(input.passage);
    if (windows.length === 0) {
      return {
        score: null,
        oppositeScore: null,
        polarityMargin: null,
        direction: null,
        evidenceSpan: null,
        reason: "LOCAL_MULTILINGUAL_NLI_EMPTY_PASSAGE",
      };
    }

    const runtime = await this.getRuntime();
    let best:
      | {
          score: number;
          oppositeScore: number;
          direction: "POSITIVE" | "NEGATIVE";
          span: QueryConditionedEvidenceSpan;
          distribution: LocalMultilingualNliDistribution;
        }
      | undefined;

    for (const window of windows) {
      const [positive, negative] = await Promise.all([
        runtime.infer(window.premise, hypotheses.positive),
        runtime.infer(window.premise, hypotheses.negative),
      ]);
      const choices = [
        {
          score: positive.entailment,
          oppositeScore: negative.entailment,
          direction: "POSITIVE" as const,
          distribution: positive,
        },
        {
          score: negative.entailment,
          oppositeScore: positive.entailment,
          direction: "NEGATIVE" as const,
          distribution: negative,
        },
      ];
      for (const choice of choices) {
        if (!entailmentIsTop(choice.distribution)) continue;
        const calibrated =
          choice.score >= this.minimumEntailmentScore &&
          choice.score - choice.oppositeScore >= this.minimumPolarityMargin;
        const bestCalibrated =
          best !== undefined &&
          best.score >= this.minimumEntailmentScore &&
          best.score - best.oppositeScore >= this.minimumPolarityMargin;
        if (
          !best ||
          (preferCalibrated && calibrated && !bestCalibrated) ||
          ((!preferCalibrated || calibrated === bestCalibrated) &&
            (choice.score > best.score ||
              (choice.score === best.score &&
                choice.oppositeScore < best.oppositeScore)))
        ) {
          best = {
            ...choice,
            span: {
              startOffset: window.startOffset,
              endOffset: window.endOffset,
            },
          };
        }
      }
    }

    if (!best) {
      return {
        score: null,
        oppositeScore: null,
        polarityMargin: null,
        direction: null,
        evidenceSpan: null,
        reason: "LOCAL_MULTILINGUAL_NLI_NO_ENTAILED_POLARITY",
      };
    }

    return {
      score: best.score,
      oppositeScore: best.oppositeScore,
      polarityMargin: best.score - best.oppositeScore,
      direction: best.direction,
      evidenceSpan: best.span,
      reason: "LOCAL_MULTILINGUAL_NLI_POLARITY_CANDIDATE",
    };
  }

  async verify(
    input: QueryConditionedEvidenceVerifierInput,
  ): Promise<QueryConditionedEvidenceVerification> {
    const evaluation = await this.evaluatePassages(input, true);
    if (
      evaluation.score === null ||
      evaluation.oppositeScore === null ||
      evaluation.polarityMargin === null ||
      evaluation.direction === null ||
      evaluation.evidenceSpan === null
    ) {
      return {
        decision: "INSUFFICIENT",
        reason: evaluation.reason,
      };
    }
    if (evaluation.score < this.minimumEntailmentScore) {
      return {
        decision: "INSUFFICIENT",
        score: evaluation.score,
        reason: "LOCAL_MULTILINGUAL_NLI_BELOW_CALIBRATED_THRESHOLD",
      };
    }
    if (evaluation.polarityMargin < this.minimumPolarityMargin) {
      return {
        decision: "INSUFFICIENT",
        score: evaluation.score,
        reason: "LOCAL_MULTILINGUAL_NLI_POLARITY_AMBIGUOUS",
      };
    }

    return {
      decision: "SUPPORTS",
      score: evaluation.score,
      evidenceSpan: evaluation.evidenceSpan,
      reason:
        evaluation.direction === "POSITIVE"
          ? "LOCAL_MULTILINGUAL_NLI_POSITIVE_ANSWER_SUPPORT"
          : "LOCAL_MULTILINGUAL_NLI_NEGATIVE_ANSWER_SUPPORT",
    };
  }

  async dispose(): Promise<void> {
    const runtime = await this.runtimePromise;
    await runtime?.dispose?.();
    this.runtimePromise = undefined;
  }

  private async getRuntime(): Promise<LocalMultilingualNliRuntime> {
    if (this.runtimePromise === undefined) {
      const pending = this.runtimeFactory({
        model: this.modelDescriptor.model,
        revision: this.modelDescriptor.revision,
        modelFileName: this.modelDescriptor.modelFileName,
        dtype: this.modelDescriptor.dtype,
        localFilesOnly: this.localFilesOnly,
        ...(this.cacheDir === undefined ? {} : { cacheDir: this.cacheDir }),
      });
      this.runtimePromise = pending.catch((error: unknown) => {
        this.runtimePromise = undefined;
        throw error;
      });
    }
    return this.runtimePromise;
  }
}
