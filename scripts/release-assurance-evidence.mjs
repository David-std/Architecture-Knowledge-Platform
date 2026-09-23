import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const manifestPath = path.resolve(
  root,
  process.env.AKP_CAPABILITY_ACCEPTANCE_MANIFEST ??
    "evals/registered/v0.4-capability-acceptance.json",
);
const sourceMapPath = path.resolve(
  root,
  process.env.AKP_CAPABILITY_EVIDENCE_SOURCES ??
    "evals/registered/v0.4-evidence-sources.json",
);
const workflowReportPath = path.resolve(
  root,
  process.env.AKP_RELEASE_ASSURANCE_WORKFLOW_REPORT ??
    "reports/ci/release-assurance-workflows.json",
);
const outputPath = path.resolve(
  root,
  process.env.AKP_CAPABILITY_EVIDENCE_LEDGER ??
    "reports/ci/release-assurance-evidence.json",
);

function objectRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function evidenceKind(id) {
  if (id.startsWith("doc:")) return "DOCUMENT";
  if (id.startsWith("surface:")) return "OPERATOR_SURFACE";
  return "EXECUTABLE";
}

function sourceLabel(source) {
  if (source.type === "WORKFLOW") return `workflow:${source.workflow}`;
  if (source.type === "STEP") {
    return `step:${source.workflow}/${source.job ?? "*"}/${source.step}`;
  }
  if (source.type === "FILE") return `file:${source.path}`;
  return `unknown:${String(source.type)}`;
}

const [manifestRaw, sourceMapRaw, workflowReportRaw] = await Promise.all([
  readFile(manifestPath, "utf8"),
  readFile(sourceMapPath, "utf8"),
  readFile(workflowReportPath, "utf8"),
]);

const manifest = objectRecord(JSON.parse(manifestRaw), "acceptance manifest");
const sourceMap = objectRecord(JSON.parse(sourceMapRaw), "evidence source map");
const workflowReport = objectRecord(
  JSON.parse(workflowReportRaw),
  "same-SHA workflow report",
);

if (
  manifest.schemaVersion !== 1 ||
  sourceMap.schemaVersion !== 1 ||
  manifest.release !== sourceMap.release
) {
  throw new Error(
    "Capability manifest and evidence source map are incompatible.",
  );
}
if (
  workflowReport.schemaVersion !== 1 ||
  typeof workflowReport.commit !== "string" ||
  !/^[a-f0-9]{40}$/i.test(workflowReport.commit)
) {
  throw new Error("Same-SHA workflow report header is invalid.");
}
const expectedCommit =
  process.env.AKP_RELEASE_ASSURANCE_COMMIT?.trim() ||
  process.env.GITHUB_SHA?.trim() ||
  null;
if (
  expectedCommit &&
  expectedCommit.toLowerCase() !== workflowReport.commit.toLowerCase()
) {
  throw new Error(
    `Workflow assurance commit ${workflowReport.commit} does not match expected commit ${expectedCommit}.`,
  );
}

const capabilities = Array.isArray(manifest.capabilities)
  ? manifest.capabilities
  : [];
const requiredEvidenceIds = new Set();
for (const capabilityValue of capabilities) {
  const capability = objectRecord(capabilityValue, "capability");
  const requirements = objectRecord(
    capability.requirements,
    `capability ${String(capability.id)} requirements`,
  );
  for (const requirementValue of Object.values(requirements)) {
    const requirement = objectRecord(
      requirementValue,
      "capability requirement",
    );
    for (const id of Array.isArray(requirement.evidence)
      ? requirement.evidence
      : []) {
      if (typeof id !== "string" || !id.trim()) {
        throw new Error("Capability evidence IDs must be non-empty strings.");
      }
      requiredEvidenceIds.add(id);
    }
  }
}

const sourceDefinitions = objectRecord(
  sourceMap.evidence,
  "evidence source map",
);
for (const id of Object.keys(sourceDefinitions)) {
  if (!requiredEvidenceIds.has(id)) {
    throw new Error(`Evidence source map contains unknown ID ${id}.`);
  }
}

const workflowEntries = Array.isArray(workflowReport.workflows)
  ? workflowReport.workflows
  : [];
const workflowByName = new Map(
  workflowEntries
    .filter((entry) => entry && typeof entry.workflow === "string")
    .map((entry) => [entry.workflow, entry]),
);

async function evaluateSource(sourceValue) {
  const source = objectRecord(sourceValue, "evidence source");
  if (source.type === "FILE") {
    if (typeof source.path !== "string" || !source.path.trim()) {
      return { passed: false, detail: "FILE source has no path." };
    }
    try {
      await access(path.resolve(root, source.path));
      return { passed: true, detail: sourceLabel(source) };
    } catch {
      return {
        passed: false,
        detail: `${sourceLabel(source)} is missing at the checked-out SHA`,
      };
    }
  }

  if (typeof source.workflow !== "string" || !source.workflow.trim()) {
    return { passed: false, detail: "Workflow source has no workflow name." };
  }
  const workflow = workflowByName.get(source.workflow);
  if (!workflow || workflow.status !== "PASSED") {
    return {
      passed: false,
      detail: `${sourceLabel(source)} is not backed by a successful same-SHA workflow`,
    };
  }
  if (source.type === "WORKFLOW") {
    return {
      passed: true,
      detail: `${sourceLabel(source)} run=${workflow.runId ?? "unknown"} attempt=${workflow.runAttempt ?? "unknown"}`,
    };
  }
  if (source.type !== "STEP") {
    return {
      passed: false,
      detail: `Unsupported evidence source type ${String(source.type)}`,
    };
  }
  if (typeof source.step !== "string" || !source.step.trim()) {
    return { passed: false, detail: "STEP source has no step name." };
  }

  const jobs = Array.isArray(workflow.jobs) ? workflow.jobs : [];
  const eligibleJobs =
    typeof source.job === "string" && source.job.trim()
      ? jobs.filter((job) => job?.name === source.job)
      : jobs;
  const matched = eligibleJobs.flatMap((job) =>
    (Array.isArray(job?.steps) ? job.steps : [])
      .filter((step) => step?.name === source.step)
      .map((step) => ({ job, step })),
  );
  if (matched.length !== 1) {
    return {
      passed: false,
      detail: `${sourceLabel(source)} matched ${matched.length} steps; exactly one is required`,
    };
  }
  const [{ job, step }] = matched;
  if (job?.conclusion !== "success" || step?.conclusion !== "success") {
    return {
      passed: false,
      detail: `${sourceLabel(source)} did not complete successfully`,
    };
  }
  return {
    passed: true,
    detail: `${sourceLabel(source)} jobId=${job.id ?? "unknown"}`,
  };
}

const evidence = {};
for (const id of [...requiredEvidenceIds].sort()) {
  const definitionValue = sourceDefinitions[id];
  if (!definitionValue) {
    evidence[id] = {
      status: "SKIPPED",
      source: path.relative(root, sourceMapPath),
      kind: evidenceKind(id),
      detail:
        "No executed evidence source is mapped for this ID; it cannot raise capability maturity.",
    };
    continue;
  }

  const definition = objectRecord(
    definitionValue,
    `evidence source definition ${id}`,
  );
  const sources = Array.isArray(definition.sources) ? definition.sources : [];
  if (sources.length === 0) {
    throw new Error(`Evidence source definition ${id} has no sources.`);
  }
  const results = [];
  for (const source of sources) results.push(await evaluateSource(source));
  const failures = results.filter((result) => !result.passed);
  evidence[id] = {
    status: failures.length === 0 ? "PASSED" : "FAILED",
    source: path.relative(root, sourceMapPath),
    kind: evidenceKind(id),
    detail: results.map((result) => result.detail).join("; "),
  };
}

const counts = { PASSED: 0, FAILED: 0, SKIPPED: 0 };
for (const record of Object.values(evidence)) counts[record.status] += 1;

const ledger = {
  schemaVersion: 1,
  commit: workflowReport.commit,
  generatedAt: new Date().toISOString(),
  evidence,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      status: counts.FAILED === 0 ? "GENERATED" : "GENERATED_WITH_FAILURES",
      commit: ledger.commit,
      evidence: Object.keys(evidence).length,
      counts,
      outputPath,
    },
    null,
    2,
  ),
);
