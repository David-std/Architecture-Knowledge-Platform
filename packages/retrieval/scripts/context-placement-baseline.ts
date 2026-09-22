import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildContextPacket,
  projectContextPacket,
  UNTRUSTED_RETRIEVED_CONTENT_ACTION,
  type PacketCandidateKind,
} from "../src/index.js";

type PlacementCandidate = {
  id: string;
  kind: PacketCandidateKind;
  score: number;
  content?: string;
  contentRepeat?: number;
  mandatory?: boolean;
  conflictGroup?: string;
};

type PlacementRegression = {
  id: string;
  kind: "CONTEXT_PLACEMENT_AND_MANDATORY_CONSTRAINTS";
  requiredActions: string[];
  candidates: PlacementCandidate[];
};

type RegressionPack = {
  productionDefaultsChanged: boolean;
  cases: Array<Record<string, unknown>>;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const fixturePath = path.join(
  repositoryRoot,
  "evals",
  "registered",
  "context-correctness-regressions.json",
);
const outputPath = path.resolve(
  repositoryRoot,
  process.env.AKP_CONTEXT_PLACEMENT_REPORT ??
    "reports/ci/context-placement-baseline.json",
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function documentId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

const raw = await readFile(fixturePath, "utf8");
const fixture = JSON.parse(raw) as RegressionPack;
if (fixture.productionDefaultsChanged !== false) {
  throw new Error(
    "Context placement baseline must not change production defaults.",
  );
}
const regression = fixture.cases.find(
  (item) => item.kind === "CONTEXT_PLACEMENT_AND_MANDATORY_CONSTRAINTS",
) as PlacementRegression | undefined;
if (!regression) {
  throw new Error("Missing ContextPacket placement regression case.");
}

const candidates = regression.candidates.map((candidate, index) => ({
  hit: {
    documentId: documentId(index),
    vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    revision: "baseline-context-placement",
    title: candidate.id,
    type: "benchmark",
    document: {
      externalId: `baseline:${candidate.id}`,
      path: `benchmarks/${candidate.id}.md`,
      title: candidate.id,
    },
    trust: "HUMAN_REVIEWED" as const,
    lifecycle: "ACTIVE" as const,
    score: candidate.score,
    reasons: ["baseline-context-placement"],
    excerpt: candidate.content ?? "oversized evidence",
    citations: [`source:${candidate.id}`],
  },
  content: candidate.content ?? "x".repeat(candidate.contentRepeat ?? 12_000),
  kind: candidate.kind,
  ...(candidate.mandatory ? { mandatory: true } : {}),
}));

const conflictGroups = new Map<string, string[]>();
regression.candidates.forEach((candidate, index) => {
  if (!candidate.conflictGroup) return;
  const ids = conflictGroups.get(candidate.conflictGroup) ?? [];
  ids.push(documentId(index));
  conflictGroups.set(candidate.conflictGroup, ids);
});
const materialConflicts = [...conflictGroups.entries()].map(
  ([id, documentIds]) => ({ id, documentIds }),
);
const continuationSections: string[][] = [];

const packet = buildContextPacket({
  request: {
    query: "apply the authorized architecture rule",
    spaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    vaultIds: [],
    federated: false,
    types: [],
    minimumTrust: "MACHINE_SUPPORTED",
    mode: "SOURCE_BACKED",
    limit: 20,
  },
  intent: "WORKFLOW_EXECUTION",
  corpusRevision: "baseline-context-placement",
  maxTokens: 2_000,
  requiredActions: regression.requiredActions,
  conflicts: ["transport-policy (OPEN)"],
  materialConflicts,
  continuationSink: (payload) => {
    continuationSections.push(
      payload.sections.map((section) => section.title),
    );
  },
  candidates,
});
const compact = projectContextPacket(packet, { maxTokens: 4_000 });
const selectedTitles = packet.sections.map((section) => section.title);
const selectedTitleSet = new Set(selectedTitles);
const continuationTitles = [...new Set(continuationSections.flat())].sort();
const requiredPrefix = packet.requiredActions.slice(
  0,
  regression.requiredActions.length,
);
const compactRequiredPrefix = compact.requiredActions.slice(
  0,
  regression.requiredActions.length,
);

const checks = {
  mandatoryRulePreserved: selectedTitleSet.has("governance-rule"),
  mandatoryRulePlacedFirst: packet.sections[0]?.title === "governance-rule",
  materialConflictCoveragePreserved:
    selectedTitleSet.has("conflict-current") &&
    selectedTitleSet.has("conflict-peer"),
  oversizedSourceDidNotMonopolizeBudget:
    !selectedTitleSet.has("oversized-source"),
  continuationEmitted: packet.continuations.length > 0,
  continuationDetailRetainedOutOfBand:
    continuationTitles.includes("continuation-detail"),
  requiredActionOrderPreserved:
    JSON.stringify(requiredPrefix) === JSON.stringify(regression.requiredActions),
  compactRequiredActionOrderPreserved:
    JSON.stringify(compactRequiredPrefix) ===
    JSON.stringify(regression.requiredActions),
  retrievedContentDoesNotContainRequiredActions: regression.requiredActions.every(
    (action) =>
      packet.sections.every((section) => !section.content.includes(action)),
  ),
  untrustedContentBoundaryPresent: packet.requiredActions.includes(
    UNTRUSTED_RETRIEVED_CONTENT_ACTION,
  ),
};
const failures = Object.entries(checks)
  .filter(([, passed]) => !passed)
  .map(([name]) => name);
if (failures.length > 0) {
  throw new Error(
    `CONTEXT_PLACEMENT_BASELINE_FAILED:${failures.join(",")}`,
  );
}

const report = {
  schemaVersion: 1,
  evidenceLevel: "BASELINE_CONTEXT_PLACEMENT_MEASUREMENT",
  status: "PROVEN",
  productionDefaultsChanged: false,
  fixture: {
    path: path.relative(repositoryRoot, fixturePath),
    sha256: sha256(raw),
    regressionId: regression.id,
  },
  packet: {
    packetId: packet.packetId,
    packetHash: packet.packetHash,
    status: packet.status,
    selectedTitles,
    continuationTitles,
    conflicts: packet.conflicts,
    requiredActions: packet.requiredActions,
    tokenizer: packet.budget.tokenizer,
    maxTokens: packet.budget.maxTokens,
    serializedTokens: packet.budget.serializedTokens,
  },
  compactPacket: {
    maxTokens: compact.budget.maxTokens,
    serializedTokens: compact.budget.serializedTokens,
    requiredActions: compact.requiredActions,
  },
  checks,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      outputPath,
      status: report.status,
      selectedTitles,
      continuationTitles,
      checks,
    },
    null,
    2,
  ),
);
