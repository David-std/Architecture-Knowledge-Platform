import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const definitionPath = path.resolve(
  root,
  process.env.AKP_DEEP_SPEC_TRACEABILITY_MANIFEST ??
    "evals/registered/v0.4-deep-spec-traceability.json",
);
const acceptancePath = path.resolve(
  root,
  process.env.AKP_CAPABILITY_ACCEPTANCE_MANIFEST ??
    "evals/registered/v0.4-capability-acceptance.json",
);
const sourceMapPath = path.resolve(
  root,
  process.env.AKP_CAPABILITY_EVIDENCE_SOURCES ??
    "evals/registered/v0.4-evidence-sources.json",
);
const ledgerPath = path.resolve(
  root,
  process.env.AKP_CAPABILITY_EVIDENCE_LEDGER ??
    "reports/ci/release-assurance-evidence.json",
);
const outputPath = path.resolve(
  root,
  process.env.AKP_DEEP_SPEC_TRACEABILITY_JSON ??
    "reports/ci/deep-spec-traceability.json",
);
const markdownPath = path.resolve(
  root,
  process.env.AKP_DEEP_SPEC_TRACEABILITY_MARKDOWN ??
    "reports/ci/deep-spec-traceability.md",
);

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function stringList(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array.`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${label} entries must be non-empty strings.`);
    }
    return entry;
  });
}

const [definitionRaw, acceptanceRaw, sourceMapRaw, ledgerRaw] =
  await Promise.all([
    readFile(definitionPath, "utf8"),
    readFile(acceptancePath, "utf8"),
    readFile(sourceMapPath, "utf8"),
    readFile(ledgerPath, "utf8"),
  ]);

const definition = record(JSON.parse(definitionRaw), "traceability manifest");
const acceptance = record(JSON.parse(acceptanceRaw), "capability manifest");
const sourceMap = record(JSON.parse(sourceMapRaw), "evidence source map");
const ledger = record(JSON.parse(ledgerRaw), "same-SHA evidence ledger");

if (
  definition.schemaVersion !== 1 ||
  acceptance.schemaVersion !== 1 ||
  sourceMap.schemaVersion !== 1 ||
  ledger.schemaVersion !== 1 ||
  definition.release !== acceptance.release ||
  definition.release !== sourceMap.release
) {
  throw new Error("Deep Spec traceability inputs are incompatible.");
}
if (
  typeof ledger.commit !== "string" ||
  !/^[a-f0-9]{40}$/i.test(ledger.commit)
) {
  throw new Error(
    "Deep Spec traceability requires a same-SHA evidence ledger.",
  );
}
const expectedCommit =
  process.env.AKP_RELEASE_ASSURANCE_COMMIT?.trim() ||
  process.env.GITHUB_SHA?.trim() ||
  null;
if (
  expectedCommit &&
  expectedCommit.toLowerCase() !== ledger.commit.toLowerCase()
) {
  throw new Error(
    `Traceability ledger commit ${ledger.commit} does not match expected commit ${expectedCommit}.`,
  );
}

const dimensions = stringList(
  definition.evidenceDimensions,
  "traceability evidenceDimensions",
);
const expectedDimensions = [
  "runtimeEvidence",
  "negativeEvidence",
  "integrationEvidence",
  "sameShaWorkflowEvidence",
  "artifactEvidence",
];
if (
  dimensions.length !== expectedDimensions.length ||
  expectedDimensions.some((dimension) => !dimensions.includes(dimension))
) {
  throw new Error("Deep Spec traceability dimensions are incomplete.");
}

const capabilities = Array.isArray(acceptance.capabilities)
  ? acceptance.capabilities.map((value) => record(value, "capability"))
  : [];
const capabilityIds = new Set(capabilities.map((capability) => capability.id));
const acceptanceEvidenceIds = new Set();
for (const capability of capabilities) {
  const requirements = record(
    capability.requirements,
    `capability ${String(capability.id)} requirements`,
  );
  for (const requirementValue of Object.values(requirements)) {
    const requirement = record(requirementValue, "capability requirement");
    for (const evidenceId of Array.isArray(requirement.evidence)
      ? requirement.evidence
      : []) {
      acceptanceEvidenceIds.add(evidenceId);
    }
  }
}
const sourceDefinitions = record(sourceMap.evidence, "evidence source map");
const evidenceLedger = record(ledger.evidence, "same-SHA evidence ledger");

function sourceTypes(evidenceId) {
  const definitionValue = sourceDefinitions[evidenceId];
  if (!definitionValue) return [];
  const sourceDefinition = record(
    definitionValue,
    `evidence source definition ${evidenceId}`,
  );
  return (
    Array.isArray(sourceDefinition.sources) ? sourceDefinition.sources : []
  ).map((source) => String(record(source, "evidence source").type ?? ""));
}

function evaluateEvidence(evidenceId, dimension) {
  if (!acceptanceEvidenceIds.has(evidenceId)) {
    throw new Error(
      `Deep Spec ${dimension} references evidence outside capability acceptance: ${evidenceId}`,
    );
  }
  if (!sourceDefinitions[evidenceId]) {
    throw new Error(
      `Deep Spec ${dimension} has no evidence source mapping: ${evidenceId}`,
    );
  }
  const result = evidenceLedger[evidenceId];
  if (!result) {
    throw new Error(
      `Deep Spec ${dimension} is absent from the same-SHA ledger: ${evidenceId}`,
    );
  }
  const ledgerRecord = record(result, `ledger evidence ${evidenceId}`);
  const types = sourceTypes(evidenceId);
  if (
    dimension === "sameShaWorkflowEvidence" &&
    !types.some((type) => type === "WORKFLOW" || type === "STEP")
  ) {
    throw new Error(
      `Deep Spec workflow evidence is not executable: ${evidenceId}`,
    );
  }
  return {
    id: evidenceId,
    status: ledgerRecord.status,
    sourceTypes: types,
    detail: ledgerRecord.detail ?? null,
  };
}

const workstreamValues = Array.isArray(definition.workstreams)
  ? definition.workstreams
  : [];
const expectedWorkstreams = Array.from(
  { length: 13 },
  (_, index) => `P${index}`,
);
const actualWorkstreamIds = workstreamValues.map(
  (value) => record(value, "workstream").id,
);
if (
  actualWorkstreamIds.length !== expectedWorkstreams.length ||
  expectedWorkstreams.some((id) => !actualWorkstreamIds.includes(id))
) {
  throw new Error(
    "Deep Spec traceability must contain exactly P0 through P12.",
  );
}

const workstreams = workstreamValues.map((value) => {
  const workstream = record(value, "workstream");
  const id = String(workstream.id);
  const mappedCapabilities = stringList(
    workstream.capabilityIds,
    `${id}.capabilityIds`,
  );
  for (const capabilityId of mappedCapabilities) {
    if (!capabilityIds.has(capabilityId)) {
      throw new Error(
        `Deep Spec ${id} references unknown capability ${capabilityId}.`,
      );
    }
  }

  const evidence = Object.fromEntries(
    dimensions.map((dimension) => [
      dimension,
      stringList(workstream[dimension], `${id}.${dimension}`).map(
        (evidenceId) => evaluateEvidence(evidenceId, dimension),
      ),
    ]),
  );
  const failed = Object.values(evidence)
    .flat()
    .filter((entry) => entry.status !== "PASSED");

  if (
    id === "P12" &&
    workstream.selfArtifact !== "reports/ci/deep-spec-traceability.json"
  ) {
    throw new Error(
      "P12 must name the generated same-SHA traceability artifact.",
    );
  }

  return {
    id,
    title: String(workstream.title ?? id),
    capabilityIds: mappedCapabilities,
    status: failed.length === 0 ? "PASSED" : "FAILED",
    evidence,
    ...(workstream.selfArtifact
      ? { selfArtifact: String(workstream.selfArtifact) }
      : {}),
  };
});

const failedWorkstreams = workstreams.filter(
  (workstream) => workstream.status !== "PASSED",
);
const output = {
  schemaVersion: 1,
  evidenceLevel: "DEEP_SPEC_SAME_SHA_TRACEABILITY",
  release: definition.release,
  commit: ledger.commit,
  generatedAt: new Date().toISOString(),
  status: failedWorkstreams.length === 0 ? "PASSED" : "FAILED",
  dimensions,
  workstreams,
};

const lines = [
  "# Deep Spec same-SHA traceability",
  "",
  `Commit: \`${ledger.commit}\``,
  `Status: **${output.status}**`,
  "",
  "| Workstream | Status | Runtime | Negative | Integration | Workflow | Artifact |",
  "| --- | --- | --- | --- | --- | --- | --- |",
];
for (const workstream of workstreams) {
  const cell = (dimension) =>
    workstream.evidence[dimension]
      .map((entry) => `${entry.id} (${entry.status})`)
      .join("<br>");
  lines.push(
    `| ${workstream.id} — ${workstream.title} | ${workstream.status} | ${cell("runtimeEvidence")} | ${cell("negativeEvidence")} | ${cell("integrationEvidence")} | ${cell("sameShaWorkflowEvidence")} | ${cell("artifactEvidence")} |`,
  );
}
lines.push("");

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
await writeFile(markdownPath, `${lines.join("\n")}\n`, "utf8");

console.log(
  JSON.stringify(
    {
      status: output.status,
      commit: output.commit,
      workstreams: workstreams.length,
      failed: failedWorkstreams.map((workstream) => workstream.id),
      outputPath: path.relative(root, outputPath),
      markdownPath: path.relative(root, markdownPath),
    },
    null,
    2,
  ),
);

if (failedWorkstreams.length > 0) process.exitCode = 1;
