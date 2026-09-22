import { access, readFile } from "node:fs/promises";
import path from "node:path";
import fg from "fast-glob";

const root = process.cwd();
const failures = [];
const productGuides = [
  "docs/guides/team-context.md",
  "docs/guides/enterprise-deployment.md",
  "docs/guides/agent-integration.md",
  "docs/guides/graph-model.md",
  "docs/guides/code-context.md",
  "docs/guides/temporal-truth.md",
  "docs/guides/retrieval-context-engineering.md",
  "docs/guides/knowledge-profiles.md",
  "docs/guides/federation.md",
  "docs/guides/contributor-reviewer.md",
  "docs/guides/assurance-connectors.md",
  "docs/guides/operations-recovery.md",
  "docs/guides/workspace-operating-model.md",
  "docs/guides/connector-contract.md",
  "docs/guides/coordination-plane.md",
  "docs/guides/software-delivery-workspace-profile.md",
];
const requiredGuideSections = [
  "What this feature is",
  "When to use it",
  "Configuration",
  "Normal workflow",
  "Security and governance boundaries",
  "Degraded and offline behavior",
  "Failure and recovery",
  "Example",
  "Limitations",
];
const requiredGuideTopics = {
  "docs/guides/workspace-operating-model.md": [
    "systems of record",
    "work claim",
    "handoff",
    "incident",
    "deployment",
    "approved akp knowledge",
  ],
  "docs/guides/connector-contract.md": [
    "mirror_indexed",
    "remote_federated",
    "source_acl_exact",
    "deletion",
    "freshness",
    "write-back",
  ],
  "docs/guides/coordination-plane.md": [
    "workcontext",
    "blackboard",
    "lease",
    "fencing",
    "handoff",
    "canonical knowledge",
  ],
  "docs/guides/software-delivery-workspace-profile.md": [
    "decisioncandidate",
    "pullrequest",
    "incident",
    "build",
    "deployment",
    "testrun",
    "externalobjectref",
  ],
};
const required = [
  "README.md",
  "ARCHITECTURE.md",
  "CONTRIBUTING.md",
  "AGENTS.md",
  "docs/status.md",
  "docs/architecture/c4.md",
  "docs/architecture/database-erd.md",
  "docs/security/threat-model.md",
  "docs/runbooks/local-operations.md",
  ...productGuides,
];
for (const file of required) {
  await access(path.join(root, file)).catch(() =>
    failures.push(`missing required document: ${file}`),
  );
}

const actualProductGuides = (
  await fg(["docs/guides/*.md"], {
    cwd: root,
    onlyFiles: true,
  })
).sort();
const expectedProductGuides = [...productGuides].sort();
if (
  JSON.stringify(actualProductGuides) !== JSON.stringify(expectedProductGuides)
) {
  const expected = new Set(expectedProductGuides);
  const actual = new Set(actualProductGuides);
  for (const guide of expectedProductGuides) {
    if (!actual.has(guide)) failures.push(`missing product guide: ${guide}`);
  }
  for (const guide of actualProductGuides) {
    if (!expected.has(guide))
      failures.push(`unexpected product guide: ${guide}`);
  }
}
for (const guide of productGuides) {
  const raw = await readFile(path.join(root, guide), "utf8");
  const headings = new Set(
    raw
      .split(/\r?\n/)
      .map((line) => /^##\s+(.+?)\s*$/.exec(line)?.[1] ?? null)
      .filter(Boolean),
  );
  for (const section of requiredGuideSections) {
    if (!headings.has(section)) {
      failures.push(`${guide}: missing required guide section "${section}"`);
    }
  }
  const normalizedGuide = raw.toLowerCase();
  for (const topic of requiredGuideTopics[guide] ?? []) {
    if (!normalizedGuide.includes(topic)) {
      failures.push(`${guide}: missing required product topic "${topic}"`);
    }
  }
}

const releaseStatus = await readFile(path.join(root, "docs/status.md"), "utf8");
const requiredReleaseLimitations = [
  "vendor-specific live connectors",
  "registered public product corpus is small",
  "version-bound to that tested provider",
  "not a claim of multi-region high availability",
  "Late-interaction retrieval is not retained",
];
if (!releaseStatus.includes("## v0.4 release limitations")) {
  failures.push("docs/status.md: missing v0.4 release limitations section");
}
for (const limitation of requiredReleaseLimitations) {
  if (!releaseStatus.includes(limitation)) {
    failures.push(
      `docs/status.md: missing explicit v0.4 limitation marker "${limitation}"`,
    );
  }
}

const markdownFiles = await fg(["*.md", "docs/**/*.md", "reports/**/*.md"], {
  cwd: root,
  onlyFiles: true,
  ignore: [
    "docs/archive/**",
    "docs/assurance/archive/**",
    "docs/assurance/releases/**",
  ],
});
for (const relativePath of markdownFiles) {
  const raw = await readFile(path.join(root, relativePath), "utf8");
  if (/\b(TODO|TBD)\b/.test(raw)) {
    failures.push(`${relativePath}: unresolved TODO/TBD marker`);
  }
  for (const match of raw.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = String(match[1]).split("#", 1)[0]?.trim() ?? "";
    if (
      !target ||
      /^(?:https?:|mailto:|#)/i.test(target) ||
      path.isAbsolute(target)
    ) {
      continue;
    }
    const resolved = path.resolve(
      path.dirname(path.join(root, relativePath)),
      target,
    );
    await access(resolved).catch(() =>
      failures.push(`${relativePath}: broken link ${target}`),
    );
  }
}

console.log(
  JSON.stringify({
    status: failures.length ? "FAILED" : "PASSED",
    markdownFiles: markdownFiles.length,
    productGuides: actualProductGuides.length,
    requiredGuideSections: requiredGuideSections.length,
    failures,
  }),
);
if (failures.length) process.exitCode = 1;
