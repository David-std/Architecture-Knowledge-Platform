import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  aggregateAgentAbArm,
  aggregateToolErgonomics,
  type AgentAbArmObservation,
  type ToolErgonomicsArm,
  type ToolErgonomicsObservation,
} from "../packages/evaluation/src/index.js";

type JsonRecord = Record<string, unknown>;

const shardDir = path.resolve(
  process.env.AKP_AGENT_SHARD_DIR ?? "reports/ci/shards",
);
const agentAbOutput = path.resolve(
  process.env.AKP_AGENT_AB_REPORT ?? "reports/ci/agent-ab-benchmark.json",
);
const ergonomicsOutput = path.resolve(
  process.env.AKP_TOOL_ERGONOMICS_REPORT ??
    "reports/ci/agent-context-ergonomics.json",
);
const providerHealthOutput = path.resolve(
  process.env.AKP_AGENT_PROVIDER_HEALTH_REPORT ??
    "reports/ci/local-agent-provider-health.json",
);
const tokenizerOutput = path.resolve(
  process.env.AKP_CONTEXT_TOKENIZER_REPORT ??
    "reports/ci/context-tokenizer-baseline.json",
);
const taskPath = path.resolve(
  process.env.AKP_AGENT_AB_TASKS ??
    "evals/registered/agent-ab-public-product-tasks.json",
);

const AB_ARMS = ["A_RAW_SEARCH", "B_AKP_CONTEXT_PACKET"] as const;
const ERGONOMICS_ARMS: readonly ToolErgonomicsArm[] = [
  "EXPERT_TOOLS_ONLY",
  "AKP_CONTEXT_FACADE",
  "FACADE_WITH_INSTRUCTIONS",
];
const NOISE_TASK_IDS = new Set([
  "agent-public-concept-canonical-authority",
  "agent-public-source-sanitized-packet",
  "agent-public-no-answer-cloud-region",
]);

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(label + " must be an object.");
  }
  return value as JsonRecord;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(label + " must be an array.");
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(label + " must be a string.");
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value)) throw new Error(label + " must be an integer.");
  return value as number;
}

function stable(value: unknown): string {
  return JSON.stringify(value);
}

async function readJson(file: string): Promise<JsonRecord> {
  return record(JSON.parse(await readFile(file, "utf8")), file);
}

async function shardFiles(prefix: string): Promise<string[]> {
  const names = await readdir(shardDir);
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".json"))
    .sort()
    .map((name) => path.join(shardDir, name));
}

function validateShardSet(
  reports: JsonRecord[],
  expectedCount: number,
  taskIds: string[],
  label: string,
): void {
  if (reports.length !== expectedCount) {
    throw new Error(
      label + " expected " + expectedCount + " shard reports, got " + reports.length + ".",
    );
  }
  const seen = new Set<number>();
  const canonicalTaskSet = stable(reports[0]?.taskSet);
  const canonicalClaimPolicy = stable(reports[0]?.claimPolicy);
  const canonicalProvider = stable(record(record(reports[0]?.execution, label + " execution").provider, label + " provider"));
  for (const report of reports) {
    if (report.status !== "PROVEN_SHARD") {
      throw new Error(label + " shard status is " + String(report.status) + ".");
    }
    const shard = record(report.shard, label + " shard");
    const index = integer(shard.index, label + " shard index");
    const count = integer(shard.count, label + " shard count");
    if (count !== expectedCount || index < 0 || index >= expectedCount || seen.has(index)) {
      throw new Error(label + " shard coordinates are invalid or duplicated.");
    }
    seen.add(index);
    const expectedTaskIds = taskIds.filter(
      (_taskId, taskIndex) => taskIndex % expectedCount === index,
    );
    if (stable(shard.taskIds) !== stable(expectedTaskIds)) {
      throw new Error(label + " shard " + index + " task assignment changed.");
    }
    if (
      stable(report.taskSet) !== canonicalTaskSet ||
      stable(report.claimPolicy) !== canonicalClaimPolicy
    ) {
      throw new Error(label + " shard task set or claim policy drifted.");
    }
    const provider = record(record(report.execution, label + " execution").provider, label + " provider");
    if (stable(provider) !== canonicalProvider) {
      throw new Error(label + " shard provider settings drifted.");
    }
  }
}

function uniqueObservationKeys(
  observations: JsonRecord[],
  taskIds: string[],
  arms: readonly string[],
  label: string,
): void {
  const expected = new Set(
    taskIds.flatMap((taskId) => arms.map((arm) => taskId + "::" + arm)),
  );
  const observed = new Set<string>();
  for (const observation of observations) {
    const key =
      stringValue(observation.taskId, label + " taskId") +
      "::" +
      stringValue(observation.arm, label + " arm");
    if (!expected.has(key)) throw new Error(label + " unexpected observation " + key + ".");
    if (observed.has(key)) throw new Error(label + " duplicate observation " + key + ".");
    observed.add(key);
  }
  if (observed.size !== expected.size) {
    const missing = [...expected].filter((key) => !observed.has(key));
    throw new Error(label + " missing observations: " + missing.join(", "));
  }
}

function sortObservations(
  observations: JsonRecord[],
  taskIds: string[],
  arms: readonly string[],
): JsonRecord[] {
  const taskOrder = new Map(taskIds.map((taskId, index) => [taskId, index]));
  const armOrder = new Map(arms.map((arm, index) => [arm, index]));
  return [...observations].sort((left, right) => {
    const leftTask = taskOrder.get(String(left.taskId)) ?? Number.MAX_SAFE_INTEGER;
    const rightTask = taskOrder.get(String(right.taskId)) ?? Number.MAX_SAFE_INTEGER;
    if (leftTask !== rightTask) return leftTask - rightTask;
    return (
      (armOrder.get(String(left.arm)) ?? Number.MAX_SAFE_INTEGER) -
      (armOrder.get(String(right.arm)) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

async function main(): Promise<void> {
  const taskFile = await readJson(taskPath);
  const taskIds = array(taskFile.tasks, "registered tasks").map((task, index) =>
    stringValue(record(task, "task " + index).id, "task id"),
  );
  if (taskIds.length !== 6) {
    throw new Error("Registered Agent A/B corpus must contain exactly six tasks.");
  }

  const abReports = await Promise.all(
    (await shardFiles("agent-ab-shard-")).map(readJson),
  );
  validateShardSet(abReports, 3, taskIds, "Agent A/B");
  const abObservations = abReports.flatMap((report) =>
    array(report.observations, "Agent A/B observations").map((value) =>
      record(value, "Agent A/B observation"),
    ),
  );
  uniqueObservationKeys(abObservations, taskIds, AB_ARMS, "Agent A/B");
  const noiseTaskIds = abObservations
    .filter((observation) => {
      if (observation.arm !== "B_AKP_CONTEXT_PACKET") return false;
      const metadata = record(
        observation.retrievalMetadata,
        "Agent A/B retrieval metadata",
      );
      return metadata.noiseProbe !== undefined;
    })
    .map((observation) => String(observation.taskId))
    .sort();
  const expectedNoiseTaskIds = [...NOISE_TASK_IDS].sort();
  if (stable(noiseTaskIds) !== stable(expectedNoiseTaskIds)) {
    throw new Error("Agent A/B controlled noise probe coverage changed.");
  }
  const sortedAb = sortObservations(abObservations, taskIds, AB_ARMS);
  const typedAb = sortedAb as unknown as AgentAbArmObservation[];
  const firstAb = abReports[0]!;
  await writeJson(agentAbOutput, {
    ...firstAb,
    generatedAt: new Date().toISOString(),
    status: "PROVEN",
    shard: null,
    shardAggregation: {
      shards: 3,
      taskAssignment: "ORIGINAL_INDEX_MODULO_SHARD_COUNT",
      complete: true,
    },
    aggregates: AB_ARMS.map((arm) =>
      aggregateAgentAbArm(typedAb.filter((observation) => observation.arm === arm)),
    ),
    observations: sortedAb,
    winner: null,
  });

  const ergonomicsReports = await Promise.all(
    (await shardFiles("agent-context-shard-")).map(readJson),
  );
  validateShardSet(ergonomicsReports, 6, taskIds, "Agent context ergonomics");
  const ergonomicsObservations = ergonomicsReports.flatMap((report) =>
    array(report.observations, "Agent context observations").map((value) =>
      record(value, "Agent context observation"),
    ),
  );
  uniqueObservationKeys(
    ergonomicsObservations,
    taskIds,
    ERGONOMICS_ARMS,
    "Agent context ergonomics",
  );
  const sortedErgonomics = sortObservations(
    ergonomicsObservations,
    taskIds,
    ERGONOMICS_ARMS,
  );
  const typedErgonomics =
    sortedErgonomics as unknown as ToolErgonomicsObservation[];
  const firstErgonomics = ergonomicsReports[0]!;
  await writeJson(ergonomicsOutput, {
    ...firstErgonomics,
    generatedAt: new Date().toISOString(),
    status: "PROVEN",
    shard: null,
    shardAggregation: {
      shards: 6,
      taskAssignment: "ORIGINAL_INDEX_MODULO_SHARD_COUNT",
      complete: true,
    },
    aggregates: ERGONOMICS_ARMS.map((arm) =>
      aggregateToolErgonomics(
        typedErgonomics.filter((observation) => observation.arm === arm),
      ),
    ),
    observations: sortedErgonomics,
    winner: null,
  });

  const providerFiles = await shardFiles("provider-health-");
  if (providerFiles.length !== 9) {
    throw new Error(
      "Expected provider health evidence from 9 benchmark shards, got " +
        providerFiles.length +
        ".",
    );
  }
  const providerReports = await Promise.all(providerFiles.map(readJson));
  const providerIdentity = stable({
    provider: providerReports[0]?.provider,
    model: providerReports[0]?.model,
    revision: providerReports[0]?.revision,
    dtype: providerReports[0]?.dtype,
  });
  for (const providerReport of providerReports) {
    const identity = stable({
      provider: providerReport.provider,
      model: providerReport.model,
      revision: providerReport.revision,
      dtype: providerReport.dtype,
    });
    if (identity !== providerIdentity) {
      throw new Error("Benchmark shards did not use one pinned provider identity.");
    }
  }
  await writeJson(providerHealthOutput, providerReports[0]);

  const tokenizerInput = path.join(shardDir, "context-tokenizer-baseline.json");
  await writeFile(tokenizerOutput, await readFile(tokenizerInput));

  console.log(
    JSON.stringify(
      {
        status: "PROVEN",
        tasks: taskIds.length,
        agentAbObservations: sortedAb.length,
        noiseProbes: noiseTaskIds.length,
        ergonomicsObservations: sortedErgonomics.length,
        providerShards: providerReports.length,
      },
      null,
      2,
    ),
  );
}

await main();
