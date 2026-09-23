import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { AutoConfig, AutoTokenizer } from "@huggingface/transformers";
import {
  buildContextPacket,
  type PacketCandidate,
  type Tokenizer,
} from "../src/index.js";

type Placement = "EARLY" | "MIDDLE" | "LATE";

type ChatMessage = {
  role: "system" | "user";
  content: string;
};

type ChatTokenizer = {
  encode(text: string): { length: number };
  apply_chat_template(
    messages: ChatMessage[],
    options: {
      tokenize: true;
      add_generation_prompt: true;
      return_tensor: false;
      return_dict: false;
    },
  ): number[];
};

type ProviderResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  provider_evidence?: {
    implementation?: string;
    model?: string;
    revision?: string;
    dtype?: string;
    latency_ms?: number;
  };
};

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const outputPath = path.resolve(
  repositoryRoot,
  process.env.AKP_LONG_CONTEXT_PLACEMENT_REPORT ??
    "reports/ci/long-context-placement.json",
);
const model =
  process.env.AKP_CONTEXT_TOKENIZER_MODEL ??
  "onnx-community/SmolLM2-135M-Instruct-ONNX";
const revision =
  process.env.AKP_CONTEXT_TOKENIZER_REVISION ??
  "b8a5c0f183b78c55955a5364f610c36668b5e681";
const providerBaseUrl = (
  process.env.AKP_LONG_CONTEXT_PROVIDER_BASE_URL ?? ""
).replace(/\/$/u, "");
const providerModel = process.env.AKP_LONG_CONTEXT_PROVIDER_MODEL ?? model;
const modelContextWindowTokens = Number(
  process.env.AKP_LONG_CONTEXT_MODEL_MAX_TOKENS ?? "8192",
);
const targetMinRatio = Number(
  process.env.AKP_LONG_CONTEXT_TARGET_MIN_RATIO ?? "0.70",
);
const targetMaxRatio = Number(
  process.env.AKP_LONG_CONTEXT_TARGET_MAX_RATIO ?? "0.78",
);
const requiredCode = "NEBULA-73";
const maxOutputTokens = 64;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateConfiguration(): void {
  if (!providerBaseUrl) {
    throw new Error("AKP_LONG_CONTEXT_PROVIDER_BASE_URL is required.");
  }
  if (
    !Number.isInteger(modelContextWindowTokens) ||
    modelContextWindowTokens < 1024
  ) {
    throw new Error(
      "AKP_LONG_CONTEXT_MODEL_MAX_TOKENS must be a positive integer.",
    );
  }
  if (
    !Number.isFinite(targetMinRatio) ||
    !Number.isFinite(targetMaxRatio) ||
    targetMinRatio < 0.5 ||
    targetMaxRatio >= 0.95 ||
    targetMinRatio >= targetMaxRatio
  ) {
    throw new Error("Long-context target ratios are invalid.");
  }
}

function fillerContent(index: number, repetitions: number): string {
  return Array.from({ length: repetitions }, (_, item) => {
    const sequence = String(item + 1).padStart(2, "0");
    return [
      `Operational evidence block ${index}-${sequence} records routine service health,`,
      "deployment observations, ownership metadata, and normal recovery notes.",
      "It is descriptive context only and does not define an authorization code.",
    ].join(" ");
  }).join(" ");
}

function packetCandidate(
  index: number,
  content: string,
  kind: "rule" | "concept",
  mandatory = false,
): PacketCandidate {
  const suffix = String(index + 1).padStart(12, "0");
  const title =
    kind === "rule"
      ? "mandatory-deployment-constraint"
      : `neutral-context-${String(index).padStart(3, "0")}`;
  return {
    hit: {
      documentId: `90000000-0000-4000-8000-${suffix}`,
      vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      revision: "long-context-placement",
      title,
      type: "benchmark",
      document: {
        externalId: `long-context:${title}`,
        path: `benchmarks/long-context/${title}.md`,
        title,
      },
      trust: "HUMAN_REVIEWED",
      lifecycle: "ACTIVE",
      score: kind === "rule" ? 0.2 : 0.9 - index / 1000,
      reasons: ["long-context-placement-benchmark"],
      excerpt: content.slice(0, 320),
      citations: [`evidence:${title}`],
    },
    content,
    kind,
    ...(mandatory ? { mandatory: true } : {}),
  };
}

function renderSection(section: {
  title: string;
  content: string;
  sourceOrEvidenceIds: string[];
}): string {
  return [
    `[SECTION ${section.title}]`,
    `Evidence: ${section.sourceOrEvidenceIds.join(", ")}`,
    section.content,
    "[/SECTION]",
  ].join("\n");
}

function orderedSections(
  mandatory: {
    title: string;
    content: string;
    sourceOrEvidenceIds: string[];
  },
  fillers: Array<{
    title: string;
    content: string;
    sourceOrEvidenceIds: string[];
  }>,
  placement: Placement,
) {
  if (placement === "EARLY") return [mandatory, ...fillers];
  if (placement === "LATE") return [...fillers, mandatory];
  const middle = Math.floor(fillers.length / 2);
  return [...fillers.slice(0, middle), mandatory, ...fillers.slice(middle)];
}

function messagesFor(
  mandatory: {
    title: string;
    content: string;
    sourceOrEvidenceIds: string[];
  },
  fillers: Array<{
    title: string;
    content: string;
    sourceOrEvidenceIds: string[];
  }>,
  placement: Placement,
): ChatMessage[] {
  const context = orderedSections(mandatory, fillers, placement)
    .map(renderSection)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "Use only the supplied evidence. Return only the exact deployment authorization code required by the mandatory constraint. If the code is absent, return NOT_FOUND.",
    },
    {
      role: "user",
      content: [
        "CONTEXT",
        context,
        "END CONTEXT",
        "Question: What exact deployment authorization code is required?",
      ].join("\n\n"),
    },
  ];
}

function exactChatTokens(
  tokenizer: ChatTokenizer,
  messages: ChatMessage[],
): number {
  const encoded = tokenizer.apply_chat_template(messages, {
    tokenize: true,
    add_generation_prompt: true,
    return_tensor: false,
    return_dict: false,
  });
  if (!encoded || typeof encoded.length !== "number") {
    throw new Error("Target tokenizer did not return tokenized chat input.");
  }
  return encoded.length;
}

async function callProvider(messages: ChatMessage[]): Promise<{
  content: string;
  latencyMs: number;
  providerEvidence: ProviderResponse["provider_evidence"];
}> {
  const started = performance.now();
  const response = await fetch(`${providerBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: providerModel,
      messages,
      temperature: 0,
      max_tokens: maxOutputTokens,
    }),
    signal: AbortSignal.timeout(360_000),
  });
  const body = (await response.json()) as ProviderResponse & {
    error?: string;
    message?: string;
  };
  if (!response.ok) {
    throw new Error(
      `Long-context provider failed ${response.status}: ${body.error ?? body.message ?? "unknown error"}`,
    );
  }
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("Long-context provider returned no assistant content.");
  }
  return {
    content,
    latencyMs: performance.now() - started,
    providerEvidence: body.provider_evidence,
  };
}

validateConfiguration();

const [loadedTokenizer, loadedModelConfig] = await Promise.all([
  AutoTokenizer.from_pretrained(model, { revision }),
  AutoConfig.from_pretrained(model, { revision }),
]);
const tokenizer = loadedTokenizer as unknown as ChatTokenizer;
const declaredContextWindowTokens = Number(
  loadedModelConfig.max_position_embeddings,
);
if (
  !Number.isSafeInteger(declaredContextWindowTokens) ||
  declaredContextWindowTokens !== modelContextWindowTokens
) {
  throw new Error(
    `Pinned model context window mismatch: config=${String(
      declaredContextWindowTokens,
    )}, expected=${String(modelContextWindowTokens)}`,
  );
}
const tokenizerPort: Tokenizer = {
  id: `huggingface:${model}@${revision}`,
  label: `${model} tokenizer at ${revision}`,
  quality: "EXACT",
  approximate: false,
  count: (text: string) => tokenizer.encode(text).length,
};

const mandatoryContent = [
  "MANDATORY DEPLOYMENT CONSTRAINT.",
  `The exact deployment authorization code is ${requiredCode}.`,
  `When asked for the deployment authorization code, the supported answer is ${requiredCode}.`,
].join(" ");
const targetMinTokens = Math.floor(modelContextWindowTokens * targetMinRatio);
const targetMaxTokens = Math.floor(modelContextWindowTokens * targetMaxRatio);
const mandatoryCandidate = packetCandidate(0, mandatoryContent, "rule", true);
const previewSection = (candidate: PacketCandidate) => ({
  title: candidate.hit.title,
  content: candidate.content,
  sourceOrEvidenceIds: candidate.hit.citations,
});

let tunedCandidates: PacketCandidate[] | null = null;
let tuning: {
  fillerCount: number;
  fillerRepetitions: number;
  previewTokenCounts: Record<Placement, number>;
} | null = null;

for (
  let fillerCount = 3;
  fillerCount <= 12 && !tunedCandidates;
  fillerCount += 1
) {
  let low = 1;
  let high = 128;
  let repetitions: number | null = null;

  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const previewFillers = Array.from({ length: fillerCount }, (_, index) =>
      previewSection(
        packetCandidate(
          index + 1,
          fillerContent(index + 1, midpoint),
          "concept",
        ),
      ),
    );
    const earlyTokens = exactChatTokens(
      tokenizer,
      messagesFor(previewSection(mandatoryCandidate), previewFillers, "EARLY"),
    );
    if (earlyTokens < targetMinTokens) {
      low = midpoint + 1;
      continue;
    }
    if (earlyTokens > targetMaxTokens) {
      high = midpoint - 1;
      continue;
    }
    repetitions = midpoint;
    break;
  }

  if (repetitions === null) continue;
  const fillers = Array.from({ length: fillerCount }, (_, index) =>
    packetCandidate(
      index + 1,
      fillerContent(index + 1, repetitions),
      "concept",
    ),
  );
  const fillerSections = fillers.map(previewSection);
  const mandatoryPreview = previewSection(mandatoryCandidate);
  const previewTokenCounts: Record<Placement, number> = {
    EARLY: exactChatTokens(
      tokenizer,
      messagesFor(mandatoryPreview, fillerSections, "EARLY"),
    ),
    MIDDLE: exactChatTokens(
      tokenizer,
      messagesFor(mandatoryPreview, fillerSections, "MIDDLE"),
    ),
    LATE: exactChatTokens(
      tokenizer,
      messagesFor(mandatoryPreview, fillerSections, "LATE"),
    ),
  };
  const previewValues = Object.values(previewTokenCounts);
  if (
    Math.min(...previewValues) < targetMinTokens ||
    Math.max(...previewValues) > targetMaxTokens
  ) {
    continue;
  }

  tunedCandidates = [mandatoryCandidate, ...fillers];
  tuning = { fillerCount, fillerRepetitions: repetitions, previewTokenCounts };
}

if (!tunedCandidates || !tuning) {
  throw new Error(
    `Unable to auto-tune long-context evidence into target range ${targetMinTokens}-${targetMaxTokens} tokens.`,
  );
}

const sourcePacket = buildContextPacket({
  request: {
    query: "prepare the deployment authorization decision",
    spaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    vaultIds: [],
    federated: false,
    types: [],
    minimumTrust: "MACHINE_SUPPORTED",
    mode: "SOURCE_BACKED",
    limit: 100,
  },
  intent: "WORKFLOW_EXECUTION",
  corpusRevision: "long-context-placement",
  maxTokens: 31_000,
  candidates: tunedCandidates,
  tokenizer: tokenizerPort,
});

if (
  sourcePacket.sections.length !== tunedCandidates.length ||
  sourcePacket.continuations.length !== 0
) {
  throw new Error(
    `Auto-tuned source packet did not retain the complete evidence set: selected=${sourcePacket.sections.length}, expected=${tunedCandidates.length}, continuations=${sourcePacket.continuations.length}.`,
  );
}
const mandatorySection = sourcePacket.sections.find(
  (section) => section.title === "mandatory-deployment-constraint",
);
if (!mandatorySection) {
  throw new Error("Mandatory long-context evidence was not selected.");
}
const selectedFillers = sourcePacket.sections.filter(
  (section) => section.title !== mandatorySection.title,
);
if (selectedFillers.length !== tuning.fillerCount) {
  throw new Error(
    `Auto-tuned filler count changed during canonical packet assembly: selected=${selectedFillers.length}, expected=${tuning.fillerCount}.`,
  );
}

const tokenCounts: Record<Placement, number> = {
  EARLY: exactChatTokens(
    tokenizer,
    messagesFor(mandatorySection, selectedFillers, "EARLY"),
  ),
  MIDDLE: exactChatTokens(
    tokenizer,
    messagesFor(mandatorySection, selectedFillers, "MIDDLE"),
  ),
  LATE: exactChatTokens(
    tokenizer,
    messagesFor(mandatorySection, selectedFillers, "LATE"),
  ),
};
const tokenValues = Object.values(tokenCounts);
if (
  Math.min(...tokenValues) < targetMinTokens ||
  Math.max(...tokenValues) > targetMaxTokens
) {
  throw new Error(
    `Canonical long-context packet moved outside target threshold: ${JSON.stringify(tokenCounts)}.`,
  );
}

const evidenceSet = [mandatorySection, ...selectedFillers]
  .map((section) => ({
    documentId: section.documentId,
    contentHash: sha256(section.content),
    evidence: [...section.sourceOrEvidenceIds].sort(),
  }))
  .sort((left, right) => left.documentId.localeCompare(right.documentId));
const evidenceSetHash = sha256(JSON.stringify(evidenceSet));

const observations = [];
for (const placement of ["EARLY", "MIDDLE", "LATE"] as const) {
  const messages = messagesFor(mandatorySection, selectedFillers, placement);
  const ordered = orderedSections(mandatorySection, selectedFillers, placement);
  const result = await callProvider(messages);
  const promptTokens = exactChatTokens(tokenizer, messages);
  const position = ordered.findIndex(
    (section) => section.title === mandatorySection.title,
  );
  observations.push({
    placement,
    promptTokens,
    contextWindowUtilization: promptTokens / modelContextWindowTokens,
    mandatorySectionOrdinal: position + 1,
    mandatorySectionFraction:
      ordered.length === 1 ? 0 : position / (ordered.length - 1),
    evidenceSetHash,
    orderedSectionHash: sha256(
      JSON.stringify(ordered.map((section) => section.documentId)),
    ),
    constraintRecalled: result.content.includes(requiredCode),
    response: result.content.slice(0, 500),
    latencyMs: result.latencyMs,
    providerEvidence: result.providerEvidence ?? null,
  });
}

const report = {
  schemaVersion: 1,
  evidenceLevel: "REAL_MODEL_LONG_CONTEXT_PLACEMENT_BENCHMARK",
  status: "PROVEN",
  productionDefaultsChanged: false,
  recommendedAssemblyOrdering: null,
  claimBoundary:
    "The three arms are evaluation-only projections of the same authorized ContextPacket evidence set. The pinned SmolLM2 model is selected only for runner-feasible placement measurement and does not replace the Agent A/B model. Results are model-specific and do not mutate the source packet or production assembly ordering.",
  model: {
    id: model,
    revision,
    providerModel,
    contextWindowTokens: modelContextWindowTokens,
    contextWindowSource:
      "AutoConfig.max_position_embeddings at pinned revision",
    evaluationRole: "PLACEMENT_EVALUATION_ONLY",
    generalizationAllowed: false,
    temperature: 0,
    maxOutputTokens,
  },
  tokenizer: {
    id: tokenizerPort.id,
    quality: tokenizerPort.quality,
    approximate: tokenizerPort.approximate,
    chatTemplateApplied: true,
  },
  target: {
    minRatio: targetMinRatio,
    maxRatio: targetMaxRatio,
    minTokens: targetMinTokens,
    maxTokens: targetMaxTokens,
    autoTunedWithExactTokenizer: true,
    fillerCount: tuning.fillerCount,
    fillerRepetitions: tuning.fillerRepetitions,
    previewTokenCounts: tuning.previewTokenCounts,
  },
  sourcePacket: {
    packetId: sourcePacket.packetId,
    packetHash: sourcePacket.packetHash,
    status: sourcePacket.status,
    serializedTokens: sourcePacket.budget.serializedTokens,
    maxTokens: sourcePacket.budget.maxTokens,
    selectedSections: sourcePacket.sections.length,
    evaluatedSections: selectedFillers.length + 1,
    evidenceSetHash,
  },
  requiredConstraint: {
    evidenceId: mandatorySection.sourceOrEvidenceIds[0] ?? null,
    sectionTitle: mandatorySection.title,
    expectedCodeSha256: sha256(requiredCode),
  },
  observations,
  aggregate: {
    arms: observations.length,
    constraintRecall:
      observations.filter((item) => item.constraintRecalled).length /
      observations.length,
  },
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      outputPath,
      status: report.status,
      sourcePacket: report.sourcePacket,
      observations: observations.map((item) => ({
        placement: item.placement,
        promptTokens: item.promptTokens,
        contextWindowUtilization: item.contextWindowUtilization,
        mandatorySectionFraction: item.mandatorySectionFraction,
        constraintRecalled: item.constraintRecalled,
        latencyMs: item.latencyMs,
      })),
      aggregate: report.aggregate,
      productionDefaultsChanged: report.productionDefaultsChanged,
    },
    null,
    2,
  ),
);
