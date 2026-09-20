import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCompetitiveArenaReport,
  measured,
  percentile,
  unmeasured,
  type CompetitiveCodeMetrics,
  type CompetitiveGraphMetrics,
  type CompetitiveRetrievalMetrics,
  type CompetitiveSystemResult,
  type CompetitiveTeamMetrics,
  type CompetitiveTemporalMetrics,
} from "../packages/evaluation/src/index.js";

type ManifestSystem = {
  id: string;
  label: string;
  evidenceMode:
    "CURRENT_REGISTERED_RETRIEVAL" | "REFERENCE_ONLY" | "OPTIONAL_EXTERNAL";
  source: string;
  limitations: string[];
};

type Manifest = {
  schemaVersion: number;
  scope: string;
  systems: ManifestSystem[];
};

type RetrievalResult = {
  metrics?: {
    latencyMs?: number;
  };
};

type RetrievalRun = {
  configurationName: string;
  meanRecallAt5: number;
  meanRecallAt10: number;
  meanReciprocalRank: number;
  meanNdcgAt10: number;
  meanContextPrecision: number;
  contextPrecisionCoverage: number;
  meanClaimSupportRecall: number;
  claimSupportRecallCoverage: number;
  meanCitationPrecision: number;
  citationPrecisionCoverage: number;
  unsupportedClaimRate: number;
  noAnswerAccuracy: number;
  noAnswerCases: number;
  meanEstimatedTokens: number;
  results: RetrievalResult[];
};

type RetrievalReport = {
  schemaVersion: number;
  evidence?: { level?: string; limitations?: string[] };
  runs: RetrievalRun[];
};

const manifestPath = path.resolve(
  process.env.AKP_COMPETITIVE_ARENA_MANIFEST ??
    "evals/registered/competitive-arena-v0.4.json",
);
const retrievalPath = path.resolve(
  process.env.AKP_COMPETITIVE_RETRIEVAL_REPORT ??
    "reports/ci/registered-corpus-retrieval-benchmark.json",
);
const outputPath = path.resolve(
  process.env.AKP_COMPETITIVE_ARENA_REPORT ??
    "reports/ci/competitive-arena.json",
);
const markdownPath = path.resolve(
  process.env.AKP_COMPETITIVE_ARENA_MARKDOWN ??
    "reports/ci/competitive-arena.md",
);

function emptyGraph(reason: string): CompetitiveGraphMetrics {
  return {
    typedPathPrecision: unmeasured(reason),
    multiHopRecall: unmeasured(reason),
    pprAssociativeRecall: unmeasured(reason),
    globalCommunityCoverage: unmeasured(reason),
    bridgeAccuracy: unmeasured(reason),
    staleEdgeSuppression: unmeasured(reason),
    unauthorizedPathRate: unmeasured(reason),
    pathExplainability: unmeasured(reason),
  };
}

function emptyCode(reason: string): CompetitiveCodeMetrics {
  return {
    symbolResolution: unmeasured(reason),
    callersCalleesCorrectness: unmeasured(reason),
    dependencyPathPrecision: unmeasured(reason),
    blastRadiusRecall: unmeasured(reason),
    changeImpactRecall: unmeasured(reason),
    testLinkageAccuracy: unmeasured(reason),
    ruleDecisionBridgePrecision: unmeasured(reason),
    buildTimeMs: unmeasured(reason),
    incrementalUpdateMs: unmeasured(reason),
    staleDetection: unmeasured(reason),
  };
}

function emptyTemporal(reason: string): CompetitiveTemporalMetrics {
  return {
    currentTruthAccuracy: unmeasured(reason),
    asOfAccuracy: unmeasured(reason),
    changedSinceAccuracy: unmeasured(reason),
    withdrawalBehavior: unmeasured(reason),
    alternativeSupportAccuracy: unmeasured(reason),
    staleDerivedSuppression: unmeasured(reason),
    mixedRevisionDetection: unmeasured(reason),
  };
}

function emptyTeam(reason: string): CompetitiveTeamMetrics {
  return {
    crossSpaceLeakRate: unmeasured(reason),
    privateToTeamLeakRate: unmeasured(reason),
    revokedPrincipalAccessRate: unmeasured(reason),
    pinnedContextReproducibility: unmeasured(reason),
    handoffCompleteness: unmeasured(reason),
    overlappingClaimFencing: unmeasured(reason),
    promotionCorrectness: unmeasured(reason),
    offlineStaleDisclosure: unmeasured(reason),
    federationPartialFailure: unmeasured(reason),
  };
}

function unexecutedSystem(
  system: ManifestSystem,
  status: "REFERENCE_ONLY" | "NOT_EXECUTED",
): CompetitiveSystemResult {
  const reason =
    status === "REFERENCE_ONLY"
      ? "Reference exists, but this arena did not execute a comparable task set for the system."
      : "No comparable execution report was supplied to this arena.";
  return {
    id: system.id,
    label: system.label,
    executionStatus: status,
    executionKind: "REGISTERED_REFERENCE",
    source: system.source,
    limitations: [...system.limitations, reason],
    retrievalRuns: [],
    graph: emptyGraph(reason),
    code: emptyCode(reason),
    temporal: emptyTemporal(reason),
    team: emptyTeam(reason),
  };
}

function retrievalMetrics(run: RetrievalRun): CompetitiveRetrievalMetrics {
  const latencies = (run.results ?? [])
    .map((result) => result.metrics?.latencyMs)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);
  return {
    recallAt5: measured(run.meanRecallAt5),
    recallAt10: measured(run.meanRecallAt10),
    mrr: measured(run.meanReciprocalRank),
    ndcgAt10: measured(run.meanNdcgAt10),
    contextPrecision:
      run.contextPrecisionCoverage > 0
        ? measured(run.meanContextPrecision)
        : unmeasured(
            "Registered dataset has no context-precision labels for this run.",
          ),
    claimSupportRecall:
      run.claimSupportRecallCoverage > 0
        ? measured(run.meanClaimSupportRecall)
        : unmeasured(
            "Registered dataset has no claim-support labels for this run.",
          ),
    citationPrecision:
      run.citationPrecisionCoverage > 0
        ? measured(run.meanCitationPrecision)
        : unmeasured("Registered dataset has no citation labels for this run."),
    unsupportedClaimRate: measured(run.unsupportedClaimRate),
    noAnswerAccuracy:
      run.noAnswerCases > 0
        ? measured(run.noAnswerAccuracy)
        : unmeasured("This retrieval run contains no labelled no-answer case."),
    contradictionRecall: unmeasured(
      "The registered retrieval corpus does not label contradiction recall.",
    ),
    latencyP50Ms:
      p50 === null ? unmeasured("No latency samples.") : measured(p50),
    latencyP95Ms:
      p95 === null ? unmeasured("No latency samples.") : measured(p95),
    contextTokens: measured(run.meanEstimatedTokens),
    providerCost: measured(0),
  };
}

function markdown(
  report: ReturnType<typeof buildCompetitiveArenaReport>,
): string {
  const lines = [
    "# Competitive arena",
    "",
    `Status: **${report.status}**`,
    "",
    "No global winner is computed. Unmeasured values remain null with an explicit reason.",
    "",
    "| System | Execution | Evidence source |",
    "| --- | --- | --- |",
  ];
  for (const system of report.systems) {
    lines.push(
      `| ${system.label} | ${system.executionStatus} | ${system.source.replaceAll("|", "\\|")} |`,
    );
  }
  const current = report.systems.find(
    (system) => system.id === "akp-v0.4-baseline-channels",
  );
  if (current?.retrievalRuns.length) {
    lines.push(
      "",
      "## AKP v0.4 registered retrieval runs",
      "",
      "| Configuration | Recall@5 | Recall@10 | MRR | nDCG@10 | p50 ms | p95 ms |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const run of current.retrievalRuns) {
      const metric = (name: keyof CompetitiveRetrievalMetrics): string => {
        const value = run.metrics[name].value;
        return value === null ? "N/M" : String(Number(value.toFixed(4)));
      };
      lines.push(
        `| ${run.configuration} | ${metric("recallAt5")} | ${metric("recallAt10")} | ${metric("mrr")} | ${metric("ndcgAt10")} | ${metric("latencyP50Ms")} | ${metric("latencyP95Ms")} |`,
      );
    }
  }
  lines.push(
    "",
    "External/reference systems are intentionally not ranked when comparable execution evidence is absent.",
    "",
  );
  return lines.join("\n");
}

async function main(): Promise<void> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Manifest;
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.systems)) {
    throw new Error("Competitive arena manifest is invalid.");
  }
  const ids = manifest.systems.map((system) => system.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("Competitive arena manifest contains duplicate systems.");
  }

  let retrievalReport: RetrievalReport | null = null;
  try {
    retrievalReport = JSON.parse(
      await readFile(retrievalPath, "utf8"),
    ) as RetrievalReport;
  } catch {
    retrievalReport = null;
  }

  const systems: CompetitiveSystemResult[] = manifest.systems.map((system) => {
    if (system.evidenceMode === "CURRENT_REGISTERED_RETRIEVAL") {
      if (!retrievalReport || !Array.isArray(retrievalReport.runs)) {
        return unexecutedSystem(system, "NOT_EXECUTED");
      }
      const reason =
        "This competitive report consumes registered retrieval evidence only; graph/code/temporal/team metrics require their own comparable harnesses.";
      return {
        id: system.id,
        label: system.label,
        executionStatus: "EXECUTED",
        executionKind: "CURRENT_RUNTIME",
        source: retrievalPath,
        limitations: [
          ...system.limitations,
          ...(retrievalReport.evidence?.limitations ?? []),
          "Context token values are the benchmark's labelled estimate, not a target-model tokenizer count.",
          "Provider cost records external API billing only; local compute cost is not monetized.",
        ],
        retrievalRuns: retrievalReport.runs.map((run) => ({
          configuration: run.configurationName,
          metrics: retrievalMetrics(run),
        })),
        graph: emptyGraph(reason),
        code: emptyCode(reason),
        temporal: emptyTemporal(reason),
        team: emptyTeam(reason),
      };
    }
    return unexecutedSystem(
      system,
      system.evidenceMode === "REFERENCE_ONLY"
        ? "REFERENCE_ONLY"
        : "NOT_EXECUTED",
    );
  });

  const report = buildCompetitiveArenaReport(systems, manifest.scope);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await mkdir(path.dirname(markdownPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, markdown(report), "utf8");
  console.log(
    JSON.stringify(
      {
        outputPath,
        markdownPath,
        status: report.status,
        coverage: report.coverage,
        winner: report.winner,
      },
      null,
      2,
    ),
  );
}

await main();
