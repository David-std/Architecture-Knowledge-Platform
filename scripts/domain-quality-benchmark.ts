import "dotenv/config";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";

type CommandSpec = {
  label: string;
  args: string[];
};

type DomainSpec = {
  id: string;
  evidenceId: string;
  description: string;
  commands: CommandSpec[];
  limitations: string[];
};

const domains: DomainSpec[] = [
  {
    id: "graph-quality",
    evidenceId: "benchmark:graph-quality",
    description:
      "Registered typed-graph, authorization, PPR and community-index scenario groups.",
    commands: [
      {
        label: "federated graph integration",
        args: [
          "--filter",
          "@akp/postgres",
          "exec",
          "vitest",
          "run",
          "test/federated-graph.integration.test.ts",
        ],
      },
      {
        label: "PPR adversarial behavior",
        args: [
          "--filter",
          "@akp/retrieval",
          "exec",
          "vitest",
          "run",
          "test/ppr.test.ts",
        ],
      },
      {
        label: "community index rollback and lifecycle",
        args: [
          "--filter",
          "@akp/indexing",
          "exec",
          "vitest",
          "run",
          "test/community-index.integration.test.ts",
        ],
      },
    ],
    limitations: [
      "This benchmark reports registered scenario-group execution, not graph precision/recall estimates over an external corpus.",
    ],
  },
  {
    id: "code-quality",
    evidenceId: "benchmark:code-quality",
    description:
      "Registered code query, impact, lifecycle and runtime-coverage scenario groups.",
    commands: [
      {
        label: "code graph API integration",
        args: [
          "--filter",
          "@akp/api",
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "test/code-graph-query.integration.test.ts",
          "test/projects-code-graph.integration.test.ts",
        ],
      },
      {
        label: "code query and lifecycle",
        args: [
          "--filter",
          "@akp/project-adapter",
          "exec",
          "vitest",
          "run",
          "test/code-query.test.ts",
          "test/code-graph-lifecycle.test.ts",
          "test/runtime-coverage.test.ts",
        ],
      },
    ],
    limitations: [
      "Real Graphify provider execution is proven separately by the maintained CI adapter job; this scenario benchmark does not relabel fixture correctness as provider parity.",
    ],
  },
  {
    id: "temporal-truth",
    evidenceId: "benchmark:temporal-truth",
    description:
      "Registered current/as-of, withdrawal, stale-support and truth-maintenance scenario groups.",
    commands: [
      {
        label: "temporal truth API integration",
        args: [
          "--filter",
          "@akp/api",
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "test/temporal-truth-query.integration.test.ts",
          "test/temporal-truth-retrieval.integration.test.ts",
        ],
      },
      {
        label: "truth maintenance worker",
        args: [
          "--filter",
          "@akp/worker",
          "exec",
          "vitest",
          "run",
          "test/truth-maintenance.test.ts",
        ],
      },
    ],
    limitations: [
      "The registered scenarios measure correctness boundaries; they do not claim temporal extraction accuracy on an unlabeled external dataset.",
    ],
  },
  {
    id: "reasoning-adversarial",
    evidenceId: "benchmark:reasoning-adversarial",
    description:
      "Registered typed-plan validation, budget, timeout and fallback adversarial scenario groups.",
    commands: [
      {
        label: "reasoning application runtime",
        args: [
          "--filter",
          "@akp/api",
          "exec",
          "vitest",
          "run",
          "test/reasoning-runtime.test.ts",
        ],
      },
      {
        label: "reasoning validator and executor",
        args: [
          "--filter",
          "@akp/retrieval",
          "exec",
          "vitest",
          "run",
          "test/reasoning-executor.test.ts",
          "test/reasoning-plan.test.ts",
          "test/reasoning-planner.test.ts",
        ],
      },
    ],
    limitations: [
      "This is an adversarial runtime scenario benchmark, not a chain-of-thought quality score.",
    ],
  },
  {
    id: "federation-partial-failure",
    evidenceId: "benchmark:federation-partial-failure",
    description:
      "Registered peer-timeout, circuit, fanout and trust-preservation scenario groups.",
    commands: [
      {
        label: "federation runtime integration",
        args: [
          "--filter",
          "@akp/api",
          "exec",
          "vitest",
          "run",
          "--config",
          "vitest.integration.config.ts",
          "test/context-fabric.integration.test.ts",
        ],
      },
      {
        label: "federation contracts",
        args: [
          "--filter",
          "@akp/contracts",
          "exec",
          "vitest",
          "run",
          "test/federation.test.ts",
          "test/federation-fanout.test.ts",
        ],
      },
      {
        label: "federation circuit breaker",
        args: [
          "--filter",
          "@akp/postgres",
          "exec",
          "vitest",
          "run",
          "test/federation-circuit.test.ts",
        ],
      },
    ],
    limitations: [
      "The dead-peer path is a controlled local failure injection; no public-internet availability claim is made.",
    ],
  },
];

const outputPath = path.resolve(
  process.env.AKP_DOMAIN_QUALITY_REPORT ??
    "reports/ci/domain-quality-benchmark.json",
);

async function runCommand(spec: CommandSpec) {
  const started = performance.now();
  const child = spawn("pnpm", spec.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
    process.stderr.write(chunk);
  });
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
  return {
    label: spec.label,
    status: exitCode === 0 ? ("PASSED" as const) : ("FAILED" as const),
    exitCode,
    durationMs: Math.round(performance.now() - started),
    stdoutTail: stdout.slice(-2000),
    stderrTail: stderr.slice(-2000),
  };
}

const results = [];
for (const domain of domains) {
  const commands = [];
  for (const command of domain.commands) {
    commands.push(await runCommand(command));
  }
  const passed = commands.filter(
    (command) => command.status === "PASSED",
  ).length;
  results.push({
    id: domain.id,
    evidenceId: domain.evidenceId,
    description: domain.description,
    status: passed === commands.length ? "PASSED" : "FAILED",
    scenarioGroups: commands.length,
    passedScenarioGroups: passed,
    scenarioGroupPassRate: passed / commands.length,
    durationMs: commands.reduce((sum, command) => sum + command.durationMs, 0),
    commands,
    limitations: domain.limitations,
  });
}

const failed = results.filter((result) => result.status === "FAILED");
const report = {
  schemaVersion: 1,
  benchmark: "AKP_REGISTERED_DOMAIN_QUALITY",
  commit: process.env.GITHUB_SHA ?? null,
  generatedAt: new Date().toISOString(),
  runtime: {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
  },
  claimPolicy: {
    externalParityClaimAllowed: false,
    scenarioPassRateIsNotPrecisionOrRecall: true,
    hiddenChainOfThoughtMeasured: false,
  },
  status: failed.length === 0 ? "PROVEN" : "FAILED",
  domains: results,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      status: report.status,
      outputPath,
      domains: results.map((result) => ({
        id: result.id,
        status: result.status,
        scenarioGroups: result.scenarioGroups,
        scenarioGroupPassRate: result.scenarioGroupPassRate,
        durationMs: result.durationMs,
      })),
    },
    null,
    2,
  ),
);
if (failed.length > 0) process.exitCode = 1;
