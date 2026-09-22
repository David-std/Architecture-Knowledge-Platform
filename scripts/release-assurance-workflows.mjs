import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const requiredWorkflows = [
  "ci",
  "recovery",
  "resilience-matrix",
  "team-node",
  "semantic-retrieval",
  "scale-benchmark",
  "concurrency-benchmark",
  "document-intelligence-benchmark",
  "agent-ab",
  "long-context-placement",
  "agent-arena",
  "domain-quality",
  "federation-two-node",
];

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

async function githubJson(url, token) {
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

const repository = requiredEnv("GITHUB_REPOSITORY");
const commit =
  process.env.AKP_RELEASE_ASSURANCE_COMMIT?.trim() || requiredEnv("GITHUB_SHA");
const token = requiredEnv("GITHUB_TOKEN");
const apiUrl = process.env.GITHUB_API_URL?.trim() || "https://api.github.com";
const outputPath = path.resolve(
  process.env.AKP_RELEASE_ASSURANCE_WORKFLOW_REPORT ??
    "reports/ci/release-assurance-workflows.json",
);

if (!/^[a-f0-9]{40}$/i.test(commit)) {
  throw new Error(`GITHUB_SHA is not a full commit SHA: ${commit}`);
}

const runsUrl = new URL(`${apiUrl}/repos/${repository}/actions/runs`);
runsUrl.searchParams.set("head_sha", commit);
runsUrl.searchParams.set("per_page", "100");

const pollMs = Math.max(
  5_000,
  Number(process.env.AKP_RELEASE_ASSURANCE_POLL_MS ?? 15_000),
);
const waitMs = Math.max(
  pollMs,
  Number(process.env.AKP_RELEASE_ASSURANCE_WAIT_MS ?? 1_800_000),
);
const deadline = Date.now() + waitMs;

async function sameShaRuns() {
  const payload = await githubJson(runsUrl, token);
  return Array.isArray(payload.workflow_runs) ? payload.workflow_runs : [];
}

function candidatesFor(runs, workflowName) {
  return runs
    .filter((run) => run?.name === workflowName && run?.head_sha === commit)
    .sort((left, right) => Number(right?.id ?? 0) - Number(left?.id ?? 0));
}

let runs = [];
for (;;) {
  runs = await sameShaRuns();
  const pending = [];
  const terminalFailures = [];
  for (const workflowName of requiredWorkflows) {
    const candidates = candidatesFor(runs, workflowName);
    const successful = candidates.some(
      (run) => run?.status === "completed" && run?.conclusion === "success",
    );
    if (successful) continue;
    const active = candidates.some((run) => run?.status !== "completed");
    if (active || candidates.length === 0) {
      pending.push(workflowName);
    } else {
      terminalFailures.push(workflowName);
    }
  }
  if (terminalFailures.length > 0 || pending.length === 0) break;
  if (Date.now() >= deadline) break;
  console.log(
    JSON.stringify({
      status: "WAITING_FOR_SAME_SHA_WORKFLOWS",
      commit,
      pending,
      remainingMs: Math.max(0, deadline - Date.now()),
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, pollMs));
}

const selectedRuns = [];
const failures = [];
for (const workflowName of requiredWorkflows) {
  const candidates = candidatesFor(runs, workflowName);
  const successful = candidates.find(
    (run) => run?.status === "completed" && run?.conclusion === "success",
  );
  if (!successful) {
    failures.push(
      `${workflowName}: no completed successful run found for ${commit}`,
    );
    selectedRuns.push({
      workflow: workflowName,
      status: "MISSING_SUCCESS",
      candidates: candidates.map((run) => ({
        runId: run?.id ?? null,
        runAttempt: run?.run_attempt ?? null,
        status: run?.status ?? null,
        conclusion: run?.conclusion ?? null,
        event: run?.event ?? null,
        htmlUrl: run?.html_url ?? null,
      })),
    });
    continue;
  }

  const jobsPayload = await githubJson(
    `${apiUrl}/repos/${repository}/actions/runs/${successful.id}/jobs?per_page=100`,
    token,
  );
  const jobs = Array.isArray(jobsPayload.jobs) ? jobsPayload.jobs : [];
  const unsuccessfulJobs = jobs.filter(
    (job) => job?.status !== "completed" || job?.conclusion !== "success",
  );
  if (unsuccessfulJobs.length > 0) {
    failures.push(
      `${workflowName}: successful run ${successful.id} contains non-success jobs`,
    );
  }

  selectedRuns.push({
    workflow: workflowName,
    status: unsuccessfulJobs.length === 0 ? "PASSED" : "FAILED",
    runId: successful.id,
    runAttempt: successful.run_attempt ?? 1,
    event: successful.event ?? null,
    htmlUrl: successful.html_url ?? null,
    jobs: jobs.map((job) => ({
      id: job?.id ?? null,
      name: job?.name ?? null,
      status: job?.status ?? null,
      conclusion: job?.conclusion ?? null,
      steps: Array.isArray(job?.steps)
        ? job.steps.map((step) => ({
            name: step?.name ?? null,
            status: step?.status ?? null,
            conclusion: step?.conclusion ?? null,
          }))
        : [],
    })),
  });
}

const report = {
  schemaVersion: 1,
  evidenceLevel: "SAME_SHA_REMOTE_WORKFLOW_ASSURANCE",
  repository,
  commit,
  generatedAt: new Date().toISOString(),
  status: failures.length === 0 ? "PASSED" : "FAILED",
  requiredWorkflows,
  failures,
  workflows: selectedRuns,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      status: report.status,
      commit,
      workflows: selectedRuns.map((run) => ({
        workflow: run.workflow,
        status: run.status,
        runId: run.runId ?? null,
        runAttempt: run.runAttempt ?? null,
      })),
      failures,
      outputPath,
    },
    null,
    2,
  ),
);
if (failures.length > 0) process.exitCode = 1;
