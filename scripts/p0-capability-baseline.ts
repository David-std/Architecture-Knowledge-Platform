import "dotenv/config";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const manifestPath = path.join(
  repositoryRoot,
  "evals",
  "registered",
  "v0.3-capability-maturity-baseline.json",
);
const outputPath = path.resolve(
  repositoryRoot,
  process.env.AKP_P0_CAPABILITY_REPORT ??
    "reports/ci/p0-v0.3-capability-baseline.json",
);

type EvidenceStatus = "PROVEN" | "PARTIALLY_PROVEN" | "NOT_APPLICABLE";

type DimensionEvidence = {
  status: EvidenceStatus;
  evidence?: string[];
  limitation?: string;
  rationale?: string;
};

type Capability = {
  id: string;
  title: string;
  maturityStage: string;
  dimensions: Record<string, DimensionEvidence>;
};

type BaselineManifest = {
  schemaVersion: number;
  baselineVersion: string;
  baseCommit: string;
  maturityLadder: string[];
  evidenceStatuses: EvidenceStatus[];
  dimensions: string[];
  harnessAllowlist: string[];
  capabilities: Capability[];
};

async function git(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repositoryRoot,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout.trim();
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function inventory(files: string[]) {
  const matches = (prefix: string) => files.filter((item) => item.startsWith(prefix));
  const migrations = files.filter(
    (item) => item.startsWith("db/migrations/") && item.endsWith(".sql"),
  );
  const workflows = files.filter(
    (item) => item.startsWith(".github/workflows/") && item.endsWith(".yml"),
  );
  const tests = files.filter(
    (item) =>
      item.includes("/test/") ||
      item.includes("/tests/") ||
      item.endsWith(".test.ts") ||
      item.endsWith(".integration.test.ts"),
  );

  return {
    contracts: matches("packages/contracts/"),
    migrations,
    api: matches("apps/api/"),
    mcp: matches("apps/mcp/"),
    web: matches("apps/web/"),
    workflows,
    tests,
  };
}

const manifestRaw = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(manifestRaw) as BaselineManifest;
if (manifest.schemaVersion !== 1) {
  throw new Error(`Unsupported capability baseline schema ${manifest.schemaVersion}.`);
}
if (new Set(manifest.dimensions).size !== manifest.dimensions.length) {
  throw new Error("Capability baseline dimensions must be unique.");
}
if (new Set(manifest.harnessAllowlist).size !== manifest.harnessAllowlist.length) {
  throw new Error("P0 harness allowlist must be unique.");
}

await git(["cat-file", "-e", `${manifest.baseCommit}^{commit}`]);
const headCommit = await git(["rev-parse", "HEAD"]);
const baseFiles = lines(
  await git(["ls-tree", "-r", "--name-only", manifest.baseCommit]),
);
const baseFileSet = new Set(baseFiles);
const changedPaths = lines(
  await git(["diff", "--name-only", manifest.baseCommit, "HEAD"]),
);
const allowedPaths = new Set(manifest.harnessAllowlist);
const unexpectedProductChanges = changedPaths.filter(
  (item) => !allowedPaths.has(item),
);
if (unexpectedProductChanges.length > 0) {
  throw new Error(
    `P0 must not change product state. Unexpected paths: ${unexpectedProductChanges.join(", ")}`,
  );
}

const allowedEvidenceStatuses = new Set(manifest.evidenceStatuses);
const allowedMaturityStages = new Set(manifest.maturityLadder);
const allEvidence = new Set<string>();
const dimensionStatusCounts: Record<EvidenceStatus, number> = {
  PROVEN: 0,
  PARTIALLY_PROVEN: 0,
  NOT_APPLICABLE: 0,
};

for (const capability of manifest.capabilities) {
  if (!allowedMaturityStages.has(capability.maturityStage)) {
    throw new Error(
      `Capability ${capability.id} has unknown maturity stage ${capability.maturityStage}.`,
    );
  }

  const actualDimensions = Object.keys(capability.dimensions).sort();
  const expectedDimensions = [...manifest.dimensions].sort();
  if (JSON.stringify(actualDimensions) !== JSON.stringify(expectedDimensions)) {
    throw new Error(
      `Capability ${capability.id} must classify every acceptance dimension exactly once.`,
    );
  }

  for (const dimension of manifest.dimensions) {
    const evidence = capability.dimensions[dimension];
    if (!evidence || !allowedEvidenceStatuses.has(evidence.status)) {
      throw new Error(
        `Capability ${capability.id}/${dimension} has an invalid evidence status.`,
      );
    }
    dimensionStatusCounts[evidence.status] += 1;

    if (evidence.status === "NOT_APPLICABLE") {
      if (!evidence.rationale?.trim()) {
        throw new Error(
          `Capability ${capability.id}/${dimension} is NOT_APPLICABLE without rationale.`,
        );
      }
      if ((evidence.evidence?.length ?? 0) > 0) {
        throw new Error(
          `Capability ${capability.id}/${dimension} is NOT_APPLICABLE but declares evidence.`,
        );
      }
      continue;
    }

    if (!evidence.evidence || evidence.evidence.length === 0) {
      throw new Error(
        `Capability ${capability.id}/${dimension} requires executable or retained evidence.`,
      );
    }
    if (evidence.status === "PARTIALLY_PROVEN" && !evidence.limitation?.trim()) {
      throw new Error(
        `Capability ${capability.id}/${dimension} is PARTIALLY_PROVEN without an explicit limitation.`,
      );
    }

    for (const evidencePath of evidence.evidence) {
      if (!baseFileSet.has(evidencePath)) {
        throw new Error(
          `Capability ${capability.id}/${dimension} references evidence absent from ${manifest.baseCommit}: ${evidencePath}`,
        );
      }
      allEvidence.add(evidencePath);
    }
  }
}

const baselineInventory = inventory(baseFiles);
const inventoryCounts = Object.fromEntries(
  Object.entries(baselineInventory).map(([key, value]) => [key, value.length]),
);
const inventoryDigest = sha256(
  JSON.stringify({
    baseCommit: manifest.baseCommit,
    inventory: baselineInventory,
  }),
);

const report = {
  schemaVersion: 1,
  evidenceLevel: "P0_V0_3_CAPABILITY_MATURITY_BASELINE",
  status: "PROVEN",
  productionDefaultsChanged: false,
  baselineVersion: manifest.baselineVersion,
  baseCommit: manifest.baseCommit,
  executionHead: headCommit,
  claimBoundary:
    "This report inventories and classifies retained v0.3 evidence. It does not upgrade any PARTIALLY_PROVEN dimension, prove v0.4 capability completion, or enable a production feature/default.",
  harnessIsolation: {
    allowedPaths: manifest.harnessAllowlist,
    changedPaths,
    unexpectedProductChanges,
  },
  inventory: {
    counts: inventoryCounts,
    sha256: inventoryDigest,
    files: baselineInventory,
  },
  matrix: manifest.capabilities,
  summary: {
    capabilities: manifest.capabilities.length,
    dimensionsPerCapability: manifest.dimensions.length,
    dimensionStatusCounts,
    confirmedEvidenceFiles: [...allEvidence].sort(),
  },
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify(
    {
      status: report.status,
      baseCommit: report.baseCommit,
      executionHead: report.executionHead,
      inventoryCounts,
      dimensionStatusCounts,
      confirmedEvidenceFiles: report.summary.confirmedEvidenceFiles.length,
      outputPath,
    },
    null,
    2,
  ),
);
