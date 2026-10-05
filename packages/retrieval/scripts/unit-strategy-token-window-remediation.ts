import "dotenv/config";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AutoTokenizer } from "@huggingface/transformers";
import {
  LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR,
  LocalSemanticEmbeddingAdapter,
  MAX_EMBEDDING_UNIT_CHARACTERS,
  MULTILINGUAL_E5_SMALL_MODEL,
  MULTILINGUAL_E5_SMALL_PASSAGE_PREFIX,
  MULTILINGUAL_E5_SMALL_REVISION,
  parseKnowledgeUnits,
} from "../src/index.js";

type Case = {
  id: string;
  family: string;
  title: string;
  source: string;
  requireSplit: boolean;
  requiredMarker: string;
};

type Manifest = {
  schemaVersion: string;
  frozen: boolean;
  frozenAt: string;
  baselineSha: string;
  singleIndependentVariable: string;
  baselineEvidence: {
    measurementManifestGitBlobSha: string;
    workflowRun: number;
    artifact: number;
    artifactSha256: string;
    maxEmbeddingUnitCharacters: number;
    modelMaxTokens: number;
    maxObservedPrefixedTokens: number;
    tokenWindowViolationCount: number;
    violatingUnitType: string;
  };
  candidatePolicy: {
    parser: string;
    maxEmbeddingUnitCharacters: number;
    embeddingModel: string;
    modelRevision: string;
    modelMaxTokens: number;
    passagePrefix: string;
    tokenCountIncludesRolePrefix: boolean;
  };
  cases: Case[];
  requiredStructuralGates: Record<string, boolean>;
  requiredRemediationGates: Record<string, boolean | number>;
  governedOutcomes: {
    promote: string;
    reject: string;
    invalid: string;
  };
  decisionRule: {
    invalidIfAnyStructuralOrVectorGateFails: boolean;
    rejectIfAnyPrefixedEmbeddingEligibleUnitExceedsModelMaxTokens: boolean;
    promoteOtherwise: boolean;
    noRetuningAfterExecution: boolean;
    claimBoundary: string;
  };
}

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const fixturePath = path.join(
  repositoryRoot,
  "evals",
  "registered",
  "unit-strategy-token-window-remediation.json",
);
const outputPath = path.resolve(
  repositoryRoot,
  process.env.AKP_UNIT_STRATEGY_REMEDIATION_REPORT ??
    "reports/ci/unit-strategy-token-window-remediation.json",
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertAncestor(sha: string): void {
  execFileSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
    cwd: repositoryRoot,
    stdio: "ignore",
  });
}

const raw = await readFile(fixturePath, "utf8");
const manifest = JSON.parse(raw) as Manifest;

if (
  manifest.schemaVersion !==
    "akp.unit-strategy-token-window-remediation.v1" ||
  manifest.frozen !== true ||
  manifest.singleIndependentVariable !== "MAX_EMBEDDING_UNIT_CHARACTERS" ||
  manifest.decisionRule.noRetuningAfterExecution !== true ||
  manifest.candidatePolicy.parser !== "parseKnowledgeUnits" ||
  manifest.candidatePolicy.maxEmbeddingUnitCharacters !==
    MAX_EMBEDDING_UNIT_CHARACTERS ||
  manifest.candidatePolicy.embeddingModel !== MULTILINGUAL_E5_SMALL_MODEL ||
  manifest.candidatePolicy.modelRevision !== MULTILINGUAL_E5_SMALL_REVISION ||
  manifest.candidatePolicy.modelMaxTokens !==
    LOCAL_MULTILINGUAL_E5_SMALL_DESCRIPTOR.runtime.maxTokens ||
  manifest.candidatePolicy.passagePrefix !==
    MULTILINGUAL_E5_SMALL_PASSAGE_PREFIX ||
  manifest.baselineEvidence.modelMaxTokens !==
    manifest.candidatePolicy.modelMaxTokens
) {
  throw new Error("Frozen token-window remediation contract drifted.");
}
assertAncestor(manifest.baselineSha);

const tokenizer = await AutoTokenizer.from_pretrained(
  MULTILINGUAL_E5_SMALL_MODEL,
  {
    revision: MULTILINGUAL_E5_SMALL_REVISION,
    ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
      ? { cache_dir: process.env.AKP_MODEL_CACHE_DIR }
      : {}),
    local_files_only: process.env.AKP_LOCAL_FILES_ONLY === "1",
  },
);
const adapter = new LocalSemanticEmbeddingAdapter({
  ...(process.env.AKP_MODEL_CACHE_DIR?.trim()
    ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
    : {}),
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
  maxBatchSize: 16,
});

const observations = [];
let allStructuralGatesPass = true;
let totalEligible = 0;
let totalVectors = 0;
let maxObservedTokens = 0;
let baselineMaxObservedTokens = 0;
let baselineTokenWindowViolationCount = 0;
const tokenWindowViolations: Array<{
  caseId: string;
  unitKey: string;
  unitType: string;
  characters: number;
  tokens: number;
}> = [];

try {
  await adapter.load();

  for (const testCase of manifest.cases) {
    const baselineUnits = parseKnowledgeUnits(testCase.title, testCase.source, {
      maxEmbeddingUnitCharacters:
        manifest.baselineEvidence.maxEmbeddingUnitCharacters,
    });
    const baselineEligible = baselineUnits.filter(
      (unit) => unit.embeddingEligible,
    );
    for (const unit of baselineEligible) {
      const prefixed =
        `${MULTILINGUAL_E5_SMALL_PASSAGE_PREFIX}${unit.body}`;
      const tokens = tokenizer.encode(prefixed).length;
      baselineMaxObservedTokens = Math.max(
        baselineMaxObservedTokens,
        tokens,
      );
      if (tokens > manifest.baselineEvidence.modelMaxTokens) {
        baselineTokenWindowViolationCount += 1;
      }
    }

    const units = parseKnowledgeUnits(testCase.title, testCase.source);
    const eligible = units.filter((unit) => unit.embeddingEligible);
    const containers = units.filter((unit) => unit.containerOnly);
    const documentContainers = units.filter(
      (unit) => unit.unitType === "DOCUMENT",
    );
    const sectionContainers = units.filter(
      (unit) => unit.unitType === "SECTION",
    );
    const tableContainers = units.filter((unit) => unit.unitType === "TABLE");
    const tableRows = units.filter((unit) => unit.unitType === "TABLE_ROW");
    const tableCells = units.filter((unit) => unit.unitType === "TABLE_CELL");
    const fragments = units.filter(
      (unit) => unit.locator.fragment !== undefined,
    );
    const byKey = new Map(units.map((unit) => [unit.unitKey, unit]));

    const fragmentParents = fragments.map((unit) =>
      unit.parentUnitKey ? byKey.get(unit.parentUnitKey) : undefined,
    );
    const markerLeaves = eligible.filter((unit) =>
      unit.body.includes(testCase.requiredMarker),
    );

    const groups = new Map<string, typeof eligible>();
    for (const unit of eligible) {
      const group = groups.get(unit.contentHash) ?? [];
      group.push(unit);
      groups.set(unit.contentHash, group);
    }
    const duplicateGroups = [...groups.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([contentHash, group]) => ({
        contentHash,
        count: group.length,
        unitKeys: group.map((unit) => unit.unitKey),
        startChars: group.map((unit) => unit.locator.startChar),
      }));

    const structuralGates = {
      documentContainerIsNotEmbeddingEligible:
        documentContainers.length === 1 &&
        documentContainers.every(
          (unit) => unit.containerOnly && !unit.embeddingEligible,
        ),
      sectionContainersAreNotEmbeddingEligible: sectionContainers.every(
        (unit) => unit.containerOnly && !unit.embeddingEligible,
      ),
      splitParentsAreContainers:
        !testCase.requireSplit ||
        (fragments.length > 1 &&
          fragmentParents.every(
            (unit) => unit?.containerOnly && !unit.embeddingEligible,
          )),
      splitChildrenAreEmbeddingEligible:
        !testCase.requireSplit ||
        (fragments.length > 1 &&
          fragments.every((unit) => unit.embeddingEligible)),
      splitChildrenPreserveParentLineage: fragments.every((unit, index) => {
        const parent = fragmentParents[index];
        return (
          parent !== undefined &&
          unit.locator.startChar >= parent.locator.startChar &&
          unit.locator.endChar <= parent.locator.endChar
        );
      }),
      requiredMarkersRemainInEmbeddingEligibleLeaves: markerLeaves.length > 0,
      exactDuplicateLeavesRemainSourceDistinct:
        testCase.family !== "DUPLICATE_CONTAINER" ||
        duplicateGroups.some(
          (group) =>
            new Set(group.unitKeys).size === group.count &&
            new Set(group.startChars).size === group.count,
        ),
      exactDuplicateLeavesRetainEqualContentHash:
        testCase.family !== "DUPLICATE_CONTAINER" || duplicateGroups.length > 0,
      tableContainerIsNotEmbeddingEligible: tableContainers.every(
        (unit) => unit.containerOnly && !unit.embeddingEligible,
      ),
      tableRowsAreEmbeddingEligible: tableRows.every(
        (unit) => unit.embeddingEligible,
      ),
      tableCellsAreNotEmbeddingEligible: tableCells.every(
        (unit) => !unit.embeddingEligible,
      ),
    };

    const tokenRows = eligible.map((unit) => {
      const prefixed = `${MULTILINGUAL_E5_SMALL_PASSAGE_PREFIX}${unit.body}`;
      const tokens = tokenizer.encode(prefixed).length;
      maxObservedTokens = Math.max(maxObservedTokens, tokens);
      if (tokens > manifest.candidatePolicy.modelMaxTokens) {
        tokenWindowViolations.push({
          caseId: testCase.id,
          unitKey: unit.unitKey,
          unitType: unit.unitType,
          characters: unit.body.length,
          tokens,
        });
      }
      return {
        unitKey: unit.unitKey,
        parentUnitKey: unit.parentUnitKey,
        unitType: unit.unitType,
        contentHash: unit.contentHash,
        characters: unit.body.length,
        tokenEstimate: unit.tokenEstimate,
        exactPrefixedTokens: tokens,
        fragment: unit.locator.fragment ?? null,
        sourceStartLine: unit.locator.sourceStartLine,
        sourceEndLine: unit.locator.sourceEndLine,
        sourceStartChar: unit.locator.startChar,
        sourceEndChar: unit.locator.endChar,
      };
    });

    const vectors = await adapter.embedPassages(
      eligible.map((unit) => unit.body),
    );
    const vectorGate = vectors.length === eligible.length;
    allStructuralGatesPass =
      allStructuralGatesPass &&
      Object.values(structuralGates).every(Boolean) &&
      vectorGate;
    totalEligible += eligible.length;
    totalVectors += vectors.length;

    observations.push({
      id: testCase.id,
      family: testCase.family,
      sourceSha256: sha256(testCase.source),
      sourceCharacters: testCase.source.length,
      units: units.length,
      containers: containers.length,
      embeddingEligibleUnits: eligible.length,
      fragments: fragments.length,
      duplicateGroups,
      structuralGates: {
        ...structuralGates,
        oneVectorPerEmbeddingEligibleUnit: vectorGate,
      },
      tokenRows,
    });
  }

  const baselineReproduced =
    baselineMaxObservedTokens ===
      manifest.baselineEvidence.maxObservedPrefixedTokens &&
    baselineTokenWindowViolationCount ===
      manifest.baselineEvidence.tokenWindowViolationCount;
  const outcome =
    !baselineReproduced || !allStructuralGatesPass
      ? manifest.governedOutcomes.invalid
      : tokenWindowViolations.length > 0
        ? manifest.governedOutcomes.reject
        : manifest.governedOutcomes.promote;

  const report = {
    schemaVersion: manifest.schemaVersion,
    evidenceLevel:
      "REGISTERED_REAL_TOKENIZER_REAL_MODEL_TOKEN_WINDOW_REMEDIATION",
    generatedAt: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim(),
    baselineSha: manifest.baselineSha,
    singleIndependentVariable: manifest.singleIndependentVariable,
    baselineReproduced,
    baseline: {
      maxEmbeddingUnitCharacters:
        manifest.baselineEvidence.maxEmbeddingUnitCharacters,
      maxObservedPrefixedTokens: baselineMaxObservedTokens,
      modelMaxTokens: manifest.baselineEvidence.modelMaxTokens,
      tokenWindowViolationCount: baselineTokenWindowViolationCount,
      evidence: manifest.baselineEvidence,
    },
    candidate: {
      maxEmbeddingUnitCharacters:
        manifest.candidatePolicy.maxEmbeddingUnitCharacters,
    },
    fixture: {
      path: path.relative(repositoryRoot, fixturePath).replaceAll("\\", "/"),
      sha256: sha256(raw),
      cases: manifest.cases.length,
    },
    runtimeChanged: true,
    policy: manifest.candidatePolicy,
    outcome,
    structuralGatesPass: allStructuralGatesPass,
    tokenWindowComplete: tokenWindowViolations.length === 0,
    totals: {
      embeddingEligibleUnits: totalEligible,
      vectorsCreated: totalVectors,
      maxObservedPrefixedTokens: maxObservedTokens,
      modelMaxTokens: manifest.candidatePolicy.modelMaxTokens,
      tokenWindowViolationCount: tokenWindowViolations.length,
    },
    tokenWindowViolations,
    observations,
    claimBoundary: manifest.decisionRule.claimBoundary,
  };

  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (outcome === manifest.governedOutcomes.invalid) {
    process.exitCode = 1;
  }
} finally {
  await adapter.dispose();
}
