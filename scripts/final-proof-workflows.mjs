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
  "agent-arena",
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
const commit = requiredEnv("GITHUB_SHA");
const token = requiredEnv("GITHUB_TOKEN");
const apiUrl = process.env.GITHUB_API_URL?.trim() || "https://api.github.com";
const outputPath = path.resolve(
  process.env.AKP_FINAL_PROOF_WORKFLOW_REPORT ??
    "reports/ci/final-proof-workflows.json",
);

if (!/^[a-f0-9]{40}$/i.test(commit)) {
  throw new Error(`GITHUB_SHA is not a full commit SHA: ${commit}`);
}

const runsUrl = new URL(`${apiUrl}/repos/${repository}/actions/runs`);
runsUrl.searchParams.set("head_sha", commit);
runsUrl.searchParams.set("per_page", "100");
const runsPayload = await githubJson(runsUrl, token);
const runs = Array.isArray(runsPayload.workflow_runs)
  ? runsPayload.workflow_runs
  : [];

const selectedRuns = [];
const failures = [];
for (const workflowName of requiredWorkflows) {
  const candidates = runs
    .filter((run) => run?.name === workflowName && run?.head_sha === commit)
    .sort((left, right) => Number(right?.id ?? 0) - Number(left?.id ?? 0));
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
  evidenceLevel: "SAME_SHA_REMOTE_WORKFLOW_PROOF",
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
