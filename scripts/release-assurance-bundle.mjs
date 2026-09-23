import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const workflowReportPath = path.resolve(
  root,
  process.env.AKP_RELEASE_ASSURANCE_WORKFLOW_REPORT ??
    "reports/ci/release-assurance-workflows.json",
);
const outputDir = path.resolve(
  root,
  process.env.AKP_RELEASE_ASSURANCE_PACKAGE_DIR ??
    "reports/ci/release-assurance-package",
);
const repository =
  process.env.GITHUB_REPOSITORY?.trim() ||
  process.env.AKP_RELEASE_ASSURANCE_REPOSITORY?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
const expectedCommit =
  process.env.AKP_RELEASE_ASSURANCE_COMMIT?.trim() ||
  process.env.GITHUB_SHA?.trim() ||
  null;

if (!repository) throw new Error("GITHUB_REPOSITORY is required.");
if (!token) throw new Error("GITHUB_TOKEN is required.");

const reportSpecs = [
  {
    workflow: "semantic-retrieval",
    artifact: (runId) => `semantic-retrieval-${runId}`,
    files: [
      ["competitive-arena.json", "competitive/competitive-arena.json"],
      ["competitive-arena.md", "competitive/competitive-arena.md"],
      [
        "registered-corpus-retrieval-benchmark.json",
        "competitive/registered-corpus-retrieval-benchmark.json",
      ],
      [
        "runtime-retrieval-benchmark.json",
        "competitive/runtime-retrieval-benchmark.json",
      ],
      ["filtered-ann-baseline.json", "competitive/filtered-ann-baseline.json"],
      [
        "contextual-chunk-benchmark.json",
        "competitive/contextual-chunk-benchmark.json",
      ],
    ],
  },
  {
    workflow: "domain-quality",
    artifact: (runId) => `domain-quality-${runId}`,
    files: [
      [
        "domain-quality-benchmark.json",
        "quality/domain-quality-benchmark.json",
      ],
      [
        "registered-graph-code-metrics.json",
        "quality/registered-graph-code-metrics.json",
      ],
      [
        "registered-temporal-truth-metrics.json",
        "quality/registered-temporal-truth-metrics.json",
      ],
      [
        "registered-workspace-team-metrics.json",
        "quality/registered-workspace-team-metrics.json",
      ],
      [
        "registered-retrieval-diagnostics.json",
        "quality/registered-retrieval-diagnostics.json",
      ],
    ],
  },
  {
    workflow: "agent-arena",
    artifact: (runId) => `agent-arena-${runId}`,
    files: [["agent-five-arm-arena.json", "agents/agent-five-arm-arena.json"]],
  },
  {
    workflow: "agent-ab",
    artifact: (runId) => `agent-ab-${runId}`,
    files: [
      ["agent-ab-benchmark.json", "agents/agent-ab-benchmark.json"],
      ["agent-context-ergonomics.json", "agents/agent-context-ergonomics.json"],
      [
        "context-tokenizer-baseline.json",
        "agents/context-tokenizer-baseline.json",
      ],
    ],
  },
  {
    workflow: "federation-two-node",
    artifact: (runId) => `federation-two-node-${runId}`,
    files: [
      ["two-node-federation.json", "enterprise/two-node-federation.json"],
    ],
  },
  {
    workflow: "scale-benchmark",
    artifact: (runId) => `scale-benchmark-${runId}-consolidated`,
    files: [["load-scale-benchmark.json", "scale/load-scale-benchmark.json"]],
  },
  {
    workflow: "scale-benchmark",
    artifact: (runId) => `enterprise-state-scale-${runId}`,
    files: [
      [
        "enterprise-state-scale-benchmark.json",
        "scale/enterprise-state-scale-benchmark.json",
      ],
      [
        "enterprise-scale-combinations.json",
        "scale/enterprise-scale-combinations.json",
      ],
    ],
  },
  {
    workflow: "concurrency-benchmark",
    artifact: (runId) => `concurrency-benchmark-${runId}`,
    files: [
      ["concurrency-benchmark.json", "scale/concurrency-benchmark.json"],
      [
        "event-concurrency-benchmark.json",
        "scale/event-concurrency-benchmark.json",
      ],
    ],
  },
  {
    workflow: "resilience-matrix",
    artifact: (runId) => `resilience-matrix-${runId}`,
    files: [["resilience-matrix.json", "operations/resilience-matrix.json"]],
  },
  {
    workflow: "recovery",
    artifact: (runId) => `recovery-diagnostics-${runId}`,
    files: [
      ["recovery-state-seed.json", "operations/recovery-state-seed.json"],
      [
        "restored-derived-context.json",
        "operations/restored-derived-context.json",
      ],
    ],
  },
];

const localFiles = [
  [
    "reports/ci/release-assurance-workflows.json",
    "same-sha/release-assurance-workflows.json",
  ],
  [
    "reports/ci/release-assurance-evidence.json",
    "same-sha/release-assurance-evidence.json",
  ],
  [
    "reports/ci/capability-acceptance.json",
    "acceptance/capability-acceptance.json",
  ],
  [
    "reports/ci/capability-acceptance.md",
    "acceptance/capability-acceptance.md",
  ],
  [
    "evals/registered/competitive-arena-v0.4.json",
    "competitive/competitive-arena-manifest.json",
  ],
];

function objectRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `GitHub API ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
    );
  }
  return response.json();
}

async function downloadArtifact(artifact, destination) {
  const response = await fetch(artifact.archive_download_url, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Artifact download ${response.status} ${response.statusText}: ${body.slice(0, 500)}`,
    );
  }
  await writeFile(destination, Buffer.from(await response.arrayBuffer()));
}

async function zipEntries(zipPath) {
  const { stdout } = await execFileAsync("unzip", ["-Z1", zipPath], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function selectZipEntry(entries, requestedName) {
  const normalized = requestedName.replaceAll("\\", "/");
  const cleanedEntries = entries.map((entry) => ({
    entry,
    clean: entry.replaceAll("\\", "/").replace(/^\.\//u, ""),
  }));
  const exactMatches = cleanedEntries.filter(
    ({ clean }) => clean === normalized,
  );
  if (exactMatches.length === 1) {
    return exactMatches[0].entry;
  }
  if (exactMatches.length > 1) {
    throw new Error(
      `Expected exactly one exact artifact entry named ${requestedName}; found ${exactMatches.length}: ${exactMatches.map(({ entry }) => entry).join(", ")}`,
    );
  }

  const basenameMatches = cleanedEntries.filter(
    ({ clean }) => path.posix.basename(clean) === normalized,
  );
  if (basenameMatches.length !== 1) {
    throw new Error(
      `Expected exactly one artifact entry named ${requestedName}; found ${basenameMatches.length}: ${basenameMatches.map(({ entry }) => entry).join(", ")}`,
    );
  }
  return basenameMatches[0].entry;
}

async function readZipEntry(zipPath, entry) {
  const { stdout } = await execFileAsync("unzip", ["-p", zipPath, entry], {
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function ensureJsonIfApplicable(destination, bytes) {
  if (!destination.endsWith(".json")) return;
  const parsed = JSON.parse(bytes.toString("utf8"));
  objectRecord(parsed, destination);
}

async function copyLocalFile(sourceRelative, destinationRelative, records) {
  const source = path.resolve(root, sourceRelative);
  const destination = path.resolve(outputDir, destinationRelative);
  const bytes = await readFile(source);
  await ensureJsonIfApplicable(destinationRelative, bytes);
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, bytes);
  records.push({
    kind: "LOCAL_SAME_SHA",
    source: sourceRelative,
    output: destinationRelative,
    sha256: sha256(bytes),
    bytes: bytes.length,
  });
}

async function walkFiles(directory, relative = "") {
  const base = path.resolve(directory, relative);
  const entries = await readdir(base, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const next = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(directory, next)));
    } else if (entry.isFile()) {
      files.push(next);
    }
  }
  return files;
}

const workflowReport = objectRecord(
  JSON.parse(await readFile(workflowReportPath, "utf8")),
  "same-SHA workflow report",
);
if (
  workflowReport.schemaVersion !== 1 ||
  workflowReport.status !== "PASSED" ||
  typeof workflowReport.commit !== "string"
) {
  throw new Error("Same-SHA workflow report is not a passing v1 report.");
}
if (
  expectedCommit &&
  expectedCommit.toLowerCase() !== workflowReport.commit.toLowerCase()
) {
  throw new Error(
    `Release assurance package commit ${workflowReport.commit} does not match expected commit ${expectedCommit}.`,
  );
}
const workflowByName = new Map(
  (Array.isArray(workflowReport.workflows) ? workflowReport.workflows : [])
    .filter(
      (workflow) =>
        workflow &&
        typeof workflow.workflow === "string" &&
        workflow.status === "PASSED" &&
        Number.isSafeInteger(Number(workflow.runId)),
    )
    .map((workflow) => [workflow.workflow, workflow]),
);

await rm(outputDir, { recursive: true, force: true });
await mkdir(outputDir, { recursive: true });
const records = [];

for (const [source, destination] of localFiles) {
  await copyLocalFile(source, destination, records);
}

const paritySource = path.resolve(root, "reports/ci/parity-exclusions");
const parityDestination = path.resolve(outputDir, "parity-exclusions");
await cp(paritySource, parityDestination, { recursive: true });
for (const relative of await walkFiles(parityDestination)) {
  const bytes = await readFile(path.resolve(parityDestination, relative));
  records.push({
    kind: "LOCAL_SAME_SHA",
    source: `reports/ci/parity-exclusions/${relative}`,
    output: `parity-exclusions/${relative}`,
    sha256: sha256(bytes),
    bytes: bytes.length,
  });
}

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "akp-release-assurance-"),
);
try {
  const artifactCache = new Map();
  for (const spec of reportSpecs) {
    const workflow = workflowByName.get(spec.workflow);
    if (!workflow) {
      throw new Error(
        `No passing same-SHA workflow entry exists for ${spec.workflow}.`,
      );
    }
    const runId = Number(workflow.runId);
    const artifactsPayload = await githubJson(
      `https://api.github.com/repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`,
    );
    const artifacts = Array.isArray(artifactsPayload.artifacts)
      ? artifactsPayload.artifacts
      : [];
    const artifactName = spec.artifact(runId);
    const matches = artifacts.filter(
      (artifact) =>
        artifact?.name === artifactName &&
        artifact?.expired !== true &&
        Number.isSafeInteger(Number(artifact?.id)),
    );
    if (matches.length !== 1) {
      throw new Error(
        `Expected exactly one non-expired artifact ${artifactName} for ${spec.workflow} run ${runId}; found ${matches.length}.`,
      );
    }
    const artifact = matches[0];
    let cached = artifactCache.get(artifact.id);
    if (!cached) {
      const zipPath = path.join(
        temporaryDirectory,
        `${spec.workflow}-${artifact.id}.zip`,
      );
      await downloadArtifact(artifact, zipPath);
      cached = { zipPath, entries: await zipEntries(zipPath) };
      artifactCache.set(artifact.id, cached);
    }

    for (const [sourceName, destinationRelative] of spec.files) {
      const entry = selectZipEntry(cached.entries, sourceName);
      const bytes = await readZipEntry(cached.zipPath, entry);
      await ensureJsonIfApplicable(destinationRelative, bytes);
      const destination = path.resolve(outputDir, destinationRelative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
      records.push({
        kind: "REMOTE_SAME_SHA_ARTIFACT",
        workflow: spec.workflow,
        runId,
        runAttempt: workflow.runAttempt ?? null,
        artifactId: Number(artifact.id),
        artifactName,
        artifactEntry: entry,
        output: destinationRelative,
        sha256: sha256(bytes),
        bytes: bytes.length,
      });
    }
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

records.sort((left, right) => left.output.localeCompare(right.output));
const duplicateOutputs = records
  .map((record) => record.output)
  .filter((value, index, values) => values.indexOf(value) !== index);
if (duplicateOutputs.length > 0) {
  throw new Error(
    `Release assurance package contains duplicate outputs: ${[
      ...new Set(duplicateOutputs),
    ].join(", ")}`,
  );
}

const packageIndex = {
  schemaVersion: 1,
  evidenceLevel: "SAME_SHA_RELEASE_ASSURANCE_PACKAGE",
  repository,
  commit: workflowReport.commit,
  generatedAt: new Date().toISOString(),
  claimPolicy: {
    manualStatusOverrideAllowed: false,
    unsupportedSuperiorityClaimAllowed: false,
    staleCompetitorReadmeNumbersAllowed: false,
    missingMandatoryReportAllowed: false,
  },
  reports: records,
};
await writeFile(
  path.join(outputDir, "index.json"),
  `${JSON.stringify(packageIndex, null, 2)}\n`,
  "utf8",
);

const indexBytes = await readFile(path.join(outputDir, "index.json"));
const packageFiles = await walkFiles(outputDir);
const summary = {
  status: "PACKAGED",
  commit: workflowReport.commit,
  reports: records.length,
  files: packageFiles.length,
  indexSha256: sha256(indexBytes),
  outputDir: path.relative(root, outputDir),
};
console.log(JSON.stringify(summary, null, 2));
