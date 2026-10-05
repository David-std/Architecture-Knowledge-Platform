import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { assessRetrievalAnswerability } from "../packages/retrieval/src/index.js";
import {
  evaluateEvidenceAdmission,
  evidenceAdmissionReport,
  loadEvidenceAdmissionPack,
} from "./evidence-admission-pack.js";

type FrozenInput = { path: string; gitBlobSha: string };
type ExperimentManifest = {
  schemaVersion: string;
  frozen: boolean;
  baselineSha: string;
  inputs: FrozenInput[];
  protocol: {
    baselineAuthority: string[];
    candidateAuthority: string[];
    removedAuthority: string[];
    runtimeChanged: boolean;
    productionDefaultsChanged: boolean;
    noNewHeuristics: boolean;
    noTuningAfterHeldout: boolean;
  };
  decisionRule: {
    outcomes: string[];
  };
};

const root = path.resolve(".");
const protocolPath = path.resolve(
  "evals/generic/deterministic-structural-authority/manifest.json",
);
const outputPath = path.resolve(
  process.env.AKP_DETERMINISTIC_STRUCTURAL_AUTHORITY_REPORT ??
    "reports/ci/deterministic-structural-authority-shadow.json",
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitBlobSha(filePath: string): string {
  return execFileSync("git", ["hash-object", filePath], {
    cwd: root,
    encoding: "utf8",
  }).trim();
}

function assertAncestor(sha: string): void {
  execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
    cwd: root,
    stdio: "ignore",
  });
}

function noRegression(candidate: number | null, baseline: number | null) {
  if (baseline === null) return candidate === null;
  return candidate !== null && candidate >= baseline;
}

function noIncrease(candidate: number | null, baseline: number | null) {
  if (baseline === null) return candidate === null;
  return candidate !== null && candidate <= baseline;
}

const protocolRaw = await readFile(protocolPath, "utf8");
const protocol = JSON.parse(protocolRaw) as ExperimentManifest;
if (
  protocol.schemaVersion !==
    "akp.deterministic-structural-authority-shadow.v1" ||
  protocol.frozen !== true ||
  protocol.protocol.runtimeChanged !== false ||
  protocol.protocol.productionDefaultsChanged !== false ||
  protocol.protocol.noNewHeuristics !== true ||
  protocol.protocol.noTuningAfterHeldout !== true
) {
  throw new Error("DETERMINISTIC_STRUCTURAL_AUTHORITY_PROTOCOL_DRIFT");
}
assertAncestor(protocol.baselineSha);

const sourceHashes: Record<string, string> = {};
for (const input of protocol.inputs) {
  const absolute = path.resolve(input.path);
  if (gitBlobSha(absolute) !== input.gitBlobSha) {
    throw new Error(`FROZEN_INPUT_CHANGED:${input.path}`);
  }
  sourceHashes[input.path] = sha256(await readFile(absolute, "utf8"));
}

const { manifest: sourceManifest, cases } = await loadEvidenceAdmissionPack([
  "development",
  "heldout",
]);
const candidateAuthority = new Set(protocol.protocol.candidateAuthority);
const removedAuthority = new Set(protocol.protocol.removedAuthority);

const baselineResults = await evaluateEvidenceAdmission(
  cases,
  async (hits, query) => assessRetrievalAnswerability(hits, query),
);

const reasonImpact = new Map<
  string,
  { baselineAdmitted: number; candidateAdmitted: number; removed: number }
>();

const candidateResults = await evaluateEvidenceAdmission(
  cases,
  async (hits, query) => {
    const baseline = assessRetrievalAnswerability(hits, query);
    const supportedCandidateKeys = baseline.candidateSignals
      .filter((signal) => candidateAuthority.has(signal.passageSupport.reason))
      .map((signal) => signal.candidateKey);

    for (const signal of baseline.candidateSignals) {
      const reason = signal.passageSupport.reason;
      const current = reasonImpact.get(reason) ?? {
        baselineAdmitted: 0,
        candidateAdmitted: 0,
        removed: 0,
      };
      const baselineAccepted = baseline.supportedCandidateKeys.includes(
        signal.candidateKey,
      );
      const candidateAccepted = supportedCandidateKeys.includes(
        signal.candidateKey,
      );
      if (baselineAccepted) current.baselineAdmitted += 1;
      if (candidateAccepted) current.candidateAdmitted += 1;
      if (baselineAccepted && !candidateAccepted) current.removed += 1;
      reasonImpact.set(reason, current);
    }

    if (
      supportedCandidateKeys.some(
        (key) => !baseline.supportedCandidateKeys.includes(key),
      )
    ) {
      throw new Error("CANDIDATE_CREATED_SUPPORT");
    }
    return {
      supportedCandidateKeys,
      candidateSignals: baseline.candidateSignals,
    };
  },
);

const baseline = evidenceAdmissionReport(
  baselineResults,
  "deterministic-current-authority",
);
const candidate = evidenceAdmissionReport(
  candidateResults,
  "deterministic-structural-authority-shadow",
);

const candidateById = new Map(candidateResults.map((row) => [row.id, row]));
const changes = baselineResults.flatMap((row) => {
  const next = candidateById.get(row.id);
  if (!next) throw new Error(`CANDIDATE_RESULT_MISSING:${row.id}`);
  if (row.admitted.join("\n") === next.admitted.join("\n")) return [];
  return [
    {
      id: row.id,
      split: row.split,
      intent: row.intent,
      language: row.language,
      challenges: row.challenges,
      answerable: row.answerable,
      baselineAdmitted: row.admitted,
      candidateAdmitted: next.admitted,
      baselineGoldAdmitted: row.goldAdmitted,
      candidateGoldAdmitted: next.goldAdmitted,
      baselineWrongAdmissions: row.wrongAdmissions,
      candidateWrongAdmissions: next.wrongAdmissions,
      baselineStrictCorrect: row.strictCorrect,
      candidateStrictCorrect: next.strictCorrect,
    },
  ];
});

const candidateCreatedAdmissions = changes.filter((row) =>
  row.candidateAdmitted.some((unit) => !row.baselineAdmitted.includes(unit)),
);
const candidateCausedFalseAbstentions = changes.filter(
  (row) =>
    row.answerable && row.baselineGoldAdmitted && !row.candidateGoldAdmitted,
);
const falseAcceptancesRemoved = changes.filter(
  (row) =>
    !row.answerable &&
    row.baselineAdmitted.length > 0 &&
    row.candidateAdmitted.length === 0,
);
const wrongAdmissionsRemoved = changes.filter(
  (row) =>
    row.candidateWrongAdmissions.length < row.baselineWrongAdmissions.length,
);

const alignment = (
  sourceManifest as {
    alignmentAudit?: {
      development?: Array<{ questionId: string; family: string }>;
      independent?: Array<{ questionId: string; family: string }>;
    };
  }
).alignmentAudit;
const alignmentRows = [
  ...(alignment?.development ?? []).map((row) => ({
    partition: "development" as const,
    ...row,
  })),
  ...(alignment?.independent ?? []).map((row) => ({
    partition: "independent" as const,
    ...row,
  })),
].map((row) => {
  const before = baselineResults.find((item) => item.id === row.questionId);
  const after = candidateResults.find((item) => item.id === row.questionId);
  if (!before || !after) {
    throw new Error(`ALIGNMENT_QUESTION_MISSING:${row.questionId}`);
  }
  return {
    ...row,
    answerable: before.answerable,
    baselineGoldAdmitted: before.goldAdmitted,
    candidateGoldAdmitted: after.goldAdmitted,
    baselineStrictCorrect: before.strictCorrect,
    candidateStrictCorrect: after.strictCorrect,
    baselineAdmitted: before.admitted,
    candidateAdmitted: after.admitted,
  };
});

const gates = {
  candidateAdmissionsSubsetOfBaseline: candidateCreatedAdmissions.length === 0,
  developmentAnswerableRecallNoRegression: noRegression(
    candidate.development.answerableRecall,
    baseline.development.answerableRecall,
  ),
  heldoutAnswerableRecallNoRegression: noRegression(
    candidate.heldout.answerableRecall,
    baseline.heldout.answerableRecall,
  ),
  developmentAdmittedPrecisionNoRegression: noRegression(
    candidate.development.admittedPrecision,
    baseline.development.admittedPrecision,
  ),
  heldoutAdmittedPrecisionNoRegression: noRegression(
    candidate.heldout.admittedPrecision,
    baseline.heldout.admittedPrecision,
  ),
  developmentStrictAccuracyNoRegression: noRegression(
    candidate.development.strictAccuracy,
    baseline.development.strictAccuracy,
  ),
  heldoutStrictAccuracyNoRegression: noRegression(
    candidate.heldout.strictAccuracy,
    baseline.heldout.strictAccuracy,
  ),
  developmentFalseAcceptanceNoIncrease: noIncrease(
    candidate.development.falseAcceptanceRate,
    baseline.development.falseAcceptanceRate,
  ),
  heldoutFalseAcceptanceNoIncrease: noIncrease(
    candidate.heldout.falseAcceptanceRate,
    baseline.heldout.falseAcceptanceRate,
  ),
  runtimeUnchanged: protocol.protocol.runtimeChanged === false,
  productionDefaultsUnchanged:
    protocol.protocol.productionDefaultsChanged === false,
};

const invariantPass =
  gates.candidateAdmissionsSubsetOfBaseline &&
  gates.runtimeUnchanged &&
  gates.productionDefaultsUnchanged;
const regression =
  !gates.developmentAnswerableRecallNoRegression ||
  !gates.heldoutAnswerableRecallNoRegression ||
  !gates.developmentAdmittedPrecisionNoRegression ||
  !gates.heldoutAdmittedPrecisionNoRegression ||
  !gates.developmentStrictAccuracyNoRegression ||
  !gates.heldoutStrictAccuracyNoRegression ||
  !gates.developmentFalseAcceptanceNoIncrease ||
  !gates.heldoutFalseAcceptanceNoIncrease;
const measuredAdvantage =
  falseAcceptancesRemoved.length > 0 || wrongAdmissionsRemoved.length > 0;

const outcome = !invariantPass
  ? "INVALID_EXPERIMENT"
  : regression
    ? "REJECT_REGRESSION"
    : measuredAdvantage
      ? "PROMOTE_TO_RUNTIME_CANDIDATE"
      : "REJECT_NO_MEASURED_ADVANTAGE";

if (!protocol.decisionRule.outcomes.includes(outcome)) {
  throw new Error(`OUTCOME_NOT_PREDECLARED:${outcome}`);
}

const report = {
  schemaVersion: protocol.schemaVersion,
  generatedAt: new Date().toISOString(),
  baselineSha: protocol.baselineSha,
  protocolHash: sha256(protocolRaw),
  sourceHashes,
  outcome,
  runtimeChanged: false,
  productionDefaultsChanged: false,
  independentVariable:
    "Remove deterministic authority from PASSAGE_TEXT_SUPPORT and PASSAGE_CUE_SUPPORT only.",
  preservedAuthority: protocol.protocol.candidateAuthority,
  removedAuthority: protocol.protocol.removedAuthority,
  baseline,
  candidate,
  gates,
  reasonImpact: Object.fromEntries(
    [...reasonImpact.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ),
  changes,
  candidateCausedFalseAbstentions: candidateCausedFalseAbstentions.map(
    (row) => row.id,
  ),
  falseAcceptancesRemoved: falseAcceptancesRemoved.map((row) => row.id),
  wrongAdmissionsRemoved: wrongAdmissionsRemoved.map((row) => row.id),
  alignmentAudit: {
    methodologicalStatus:
      "Frozen existing regression partition; independent families are disjoint but previously inspected and not a blind holdout.",
    rows: alignmentRows,
  },
  claimBoundary: [
    "Supplied-candidate deterministic evidence-admission measurement only; retrieval quality is not measured.",
    "No support reason, heuristic, threshold, source text or production default is changed in this worker.",
    "PROMOTE_TO_RUNTIME_CANDIDATE would only permit a separate runtime-change worker.",
    "A REJECT must not be retuned against individual heldout failures.",
  ],
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify(report, null, 2) + "\n");

if (!invariantPass) process.exitCode = 1;
