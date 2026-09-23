import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const outputPath = path.resolve(
  repositoryRoot,
  process.env.AKP_BASELINE_EVIDENCE_REPORT ??
    "reports/ci/baseline-evidence.json",
);

type CapabilityBaseline = {
  status: string;
  baseCommit: string;
  baselineVersion: string;
  inventory: { sha256: string };
};

type SemanticProvider = {
  provider: string;
  model: string;
  modelRevision: string;
  dimensions: number;
  normalization: string;
  inputStrategy: string;
  configurationVersion: string;
  runtime: {
    library: string;
    libraryVersion: string;
    backend: string;
    device: string;
    dtype: string;
    maxTokens: number;
  };
};

type RuntimeRetrievalReport = {
  evidence: { level: string; qualityClaim: string };
  semanticProvider: SemanticProvider;
  isolation: { status: string; violations: string[] };
  productionDefault: { status: string; reason: string };
  runs: Array<{
    configurationName: string;
    meanRecallAt10: number;
    meanReciprocalRank: number;
    meanNdcgAt10: number;
    meanLatencyMs: number;
  }>;
};

type FilteredVectorReport = {
  status: string;
  pgvectorVersion?: string;
  iterativeScanSupported?: boolean;
  measurements: Array<{
    scenario: string;
    mode: string;
    meanRecallAtK: number;
    p95LatencyMs: number;
    leakageCount: number;
  }>;
};

type PlacementReport = {
  status: string;
  fixture: { sha256: string; regressionId: string };
  packet: Record<string, unknown>;
  compactPacket: Record<string, unknown>;
  checks: Record<string, boolean>;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function workflowEnv(source: string, name: string): string {
  const expression = new RegExp(
    `^\\s+${name}:\\s*(?:"([^"]+)"|'([^']+)'|([^#\\r\\n]+))\\s*$`,
    "mu",
  );
  const match = expression.exec(source);
  const value = (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
  if (!value) {
    throw new Error(`Missing ${name} in agent comparison workflow.`);
  }
  return value;
}

function lockedLinuxDoclingVersion(source: string): string {
  for (const line of source.split(/\r?\n/u)) {
    if (
      !line.includes('{ name = "docling"') ||
      !line.includes(`marker = "sys_platform != 'darwin'"`)
    ) {
      continue;
    }
    const version = /\bversion = "([^"]+)"/u.exec(line)?.[1];
    if (version) return version;
  }
  throw new Error("Unable to resolve the locked Linux Docling version.");
}

const paths = {
  capability: path.join(
    repositoryRoot,
    "reports/ci/v0.3-capability-maturity-baseline.json",
  ),
  retrieval: path.join(
    repositoryRoot,
    "reports/ci/runtime-retrieval-benchmark.json",
  ),
  filteredVector: path.join(
    repositoryRoot,
    "reports/ci/filtered-ann-baseline.json",
  ),
  contextPlacement: path.join(
    repositoryRoot,
    "reports/ci/context-placement-baseline.json",
  ),
  fixture: path.join(
    repositoryRoot,
    "evals/registered/context-correctness-regressions.json",
  ),
  agentWorkflow: path.join(repositoryRoot, ".github/workflows/agent-ab.yml"),
  extractorLock: path.join(repositoryRoot, "apps/extractor/uv.lock"),
  packageJson: path.join(repositoryRoot, "package.json"),
};

const [
  capability,
  retrieval,
  filteredVector,
  contextPlacement,
  fixtureRaw,
  agentWorkflowRaw,
  extractorLockRaw,
  packageRaw,
] = await Promise.all([
  readJson<CapabilityBaseline>(paths.capability),
  readJson<RuntimeRetrievalReport>(paths.retrieval),
  readJson<FilteredVectorReport>(paths.filteredVector),
  readJson<PlacementReport>(paths.contextPlacement),
  readFile(paths.fixture, "utf8"),
  readFile(paths.agentWorkflow, "utf8"),
  readFile(paths.extractorLock, "utf8"),
  readFile(paths.packageJson, "utf8"),
]);

if (capability.status !== "PROVEN") {
  throw new Error("Frozen capability baseline is not proven.");
}
if (filteredVector.status !== "PROVEN") {
  throw new Error("Filtered vector baseline is not proven.");
}
if (contextPlacement.status !== "PROVEN") {
  throw new Error("Context placement baseline is not proven.");
}
if (retrieval.isolation.violations.length > 0) {
  throw new Error("Runtime retrieval evidence contains isolation violations.");
}
if (
  filteredVector.measurements.some(
    (measurement) => measurement.leakageCount !== 0,
  )
) {
  throw new Error("Filtered vector evidence contains authorization leakage.");
}

const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
});
const akpCommit = stdout.trim();
if (!/^[a-f0-9]{40}$/iu.test(akpCommit)) {
  throw new Error("Current AKP commit is not a full Git SHA.");
}

const agentModel = workflowEnv(agentWorkflowRaw, "AKP_LOCAL_AGENT_MODEL");
const agentModelRevision = workflowEnv(
  agentWorkflowRaw,
  "AKP_LOCAL_AGENT_MODEL_REVISION",
);
const agentDtype = workflowEnv(agentWorkflowRaw, "AKP_LOCAL_AGENT_DTYPE");
const tokenizerModel = workflowEnv(
  agentWorkflowRaw,
  "AKP_CONTEXT_TOKENIZER_MODEL",
);
const tokenizerRevision = workflowEnv(
  agentWorkflowRaw,
  "AKP_CONTEXT_TOKENIZER_REVISION",
);
const documentIntelligenceVersion = lockedLinuxDoclingVersion(extractorLockRaw);
const packageManager = (JSON.parse(packageRaw) as { packageManager?: string })
  .packageManager;
if (!packageManager) {
  throw new Error("Root package manager version is missing.");
}

const semanticProvider = {
  provider: retrieval.semanticProvider.provider,
  model: retrieval.semanticProvider.model,
  modelRevision: retrieval.semanticProvider.modelRevision,
  dimensions: retrieval.semanticProvider.dimensions,
  normalization: retrieval.semanticProvider.normalization,
  inputStrategy: retrieval.semanticProvider.inputStrategy,
  configurationVersion: retrieval.semanticProvider.configurationVersion,
  runtime: retrieval.semanticProvider.runtime,
};
const remoteSuites = [
  "ci",
  "recovery",
  "resilience-matrix",
  "team-node",
  "scale-benchmark",
  "concurrency-benchmark",
  "document-intelligence-benchmark",
  "agent-ab",
] as const;
const configurationDescriptor = {
  baselineSha: capability.baseCommit,
  baselineInventorySha256: capability.inventory.sha256,
  regressionFixtureSha256: sha256(fixtureRaw),
  retrievalConfigurations: retrieval.runs
    .map((run) => run.configurationName)
    .sort(),
  filteredVectorModes: [
    ...new Set(filteredVector.measurements.map((item) => item.mode)),
  ].sort(),
  semanticProvider,
  tokenizer: {
    model: tokenizerModel,
    revision: tokenizerRevision,
  },
  agent: {
    model: agentModel,
    revision: agentModelRevision,
    dtype: agentDtype,
  },
  documentIntelligence: {
    provider: "docling",
    version: documentIntelligenceVersion,
  },
  packageManager,
  remoteSuites,
};
const configurationHash = sha256(JSON.stringify(configurationDescriptor));
const providerVersions = {
  semanticEmbeddingRuntime: `${semanticProvider.runtime.library}@${semanticProvider.runtime.libraryVersion}`,
  contextTokenizerRuntime: "@huggingface/transformers@4.2.0",
  documentIntelligenceLinux: `docling@${documentIntelligenceVersion}`,
  packageManager,
};
const modelVersions = {
  semanticEmbedding: `${semanticProvider.model}@${semanticProvider.modelRevision}`,
  contextTokenizer: `${tokenizerModel}@${tokenizerRevision}`,
  agentEvaluation: `${agentModel}@${agentModelRevision}#${agentDtype}`,
};

const report = {
  schemaVersion: 1,
  evidenceLevel: "COMPOSITE_BASELINE_EVIDENCE",
  status: "EVIDENCE_ENVELOPE_GENERATED",
  akpCommit,
  baseline: capability.baselineVersion,
  baselineSha: capability.baseCommit,
  configurationHash,
  providerVersions,
  modelVersions,
  claimBoundary:
    "Frozen capability inventory is pinned to baselineSha. Runtime retrieval, filtered-vector and context-placement measurements execute on akpCommit without changing production defaults. Tokenizer, agent, recovery, concurrency, scale and document-intelligence evidence remain separate same-SHA workflows and are referenced rather than falsely relabelled as locally executed.",
  retrieval: {
    report: path.relative(repositoryRoot, paths.retrieval),
    evidenceLevel: retrieval.evidence.level,
    qualityClaim: retrieval.evidence.qualityClaim,
    productionDefault: retrieval.productionDefault,
    configurations: retrieval.runs.map((run) => ({
      name: run.configurationName,
      recallAt10: run.meanRecallAt10,
      mrr: run.meanReciprocalRank,
      ndcgAt10: run.meanNdcgAt10,
      meanLatencyMs: run.meanLatencyMs,
    })),
  },
  filteredVector: {
    report: path.relative(repositoryRoot, paths.filteredVector),
    status: filteredVector.status,
    pgvectorVersion: filteredVector.pgvectorVersion ?? null,
    iterativeScanSupported: filteredVector.iterativeScanSupported ?? null,
    zeroLeakage: true,
    measurements: filteredVector.measurements,
  },
  tokenization: {
    status: "REMOTE_SAME_SHA_EVIDENCE_REQUIRED",
    workflow: "agent-ab",
    artifactPath: "reports/ci/context-tokenizer-baseline.json",
    model: tokenizerModel,
    revision: tokenizerRevision,
    exactTokenizerRequired: true,
  },
  contextPlacement: {
    report: path.relative(repositoryRoot, paths.contextPlacement),
    fixture: contextPlacement.fixture,
    packet: contextPlacement.packet,
    compactPacket: contextPlacement.compactPacket,
    checks: contextPlacement.checks,
  },
  security: {
    runtimeIsolation: retrieval.isolation,
    filteredVectorZeroLeakage: true,
    regressionFixtureSha256: sha256(fixtureRaw),
  },
  agent: {
    status: "REMOTE_SAME_SHA_EVIDENCE_REQUIRED",
    workflow: "agent-ab",
    model: agentModel,
    revision: agentModelRevision,
    dtype: agentDtype,
    scoringMayNotBeUpgradedByThisEnvelope: true,
  },
  providers: {
    semanticEmbedding: semanticProvider,
    contextTokenizer: {
      provider: "@huggingface/transformers",
      version: "4.2.0",
      model: tokenizerModel,
      revision: tokenizerRevision,
    },
    documentIntelligence: {
      provider: "docling",
      version: documentIntelligenceVersion,
      lockSource: path.relative(repositoryRoot, paths.extractorLock),
    },
    agentEvaluation: {
      provider: "local-openai-compatible",
      model: agentModel,
      revision: agentModelRevision,
      dtype: agentDtype,
    },
  },
  remoteSuites: remoteSuites.map((workflow) => ({
    workflow,
    status: "VERIFIED_BY_FINAL_SAME_SHA_PROOF",
  })),
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      outputPath,
      status: report.status,
      akpCommit,
      baselineSha: report.baselineSha,
      configurationHash,
      providerVersions,
      modelVersions,
      remoteSuites,
    },
    null,
    2,
  ),
);
