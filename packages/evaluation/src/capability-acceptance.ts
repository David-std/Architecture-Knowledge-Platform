export const CAPABILITY_ACCEPTANCE_COLUMNS = [
  "runtimeTest",
  "negativeTest",
  "integrationTest",
  "recoveryTest",
  "securityTest",
  "operatorSurface",
  "docs",
  "benchmark",
  "remoteCi",
] as const;

export type CapabilityAcceptanceColumn =
  (typeof CAPABILITY_ACCEPTANCE_COLUMNS)[number];

export const CAPABILITY_MATURITY_LADDER = [
  "DESIGNED",
  "FUNCTIONAL",
  "INTEGRATED",
  "HARDENED",
  "OPERABLE",
  "BENCHMARKED",
  "DOCUMENTED",
  "PRODUCTIZED",
] as const;

export type CapabilityMaturity =
  (typeof CAPABILITY_MATURITY_LADDER)[number];

export type EvidenceExecutionStatus = "PASSED" | "FAILED" | "SKIPPED";

export interface CapabilityEvidenceRecord {
  status: EvidenceExecutionStatus;
  source: string;
  kind: "EXECUTABLE" | "DOCUMENT" | "OPERATOR_SURFACE";
  detail?: string;
}

export interface CapabilityEvidenceLedger {
  schemaVersion: 1;
  commit: string;
  generatedAt: string;
  evidence: Record<string, CapabilityEvidenceRecord>;
}

export interface CapabilityRequirement {
  evidence: string[];
  required?: boolean;
  rationale?: string;
}

export interface CapabilityAcceptanceDefinition {
  id: string;
  title: string;
  mandatory: boolean;
  requirements: Record<CapabilityAcceptanceColumn, CapabilityRequirement>;
  remainingLimitation?: string | null;
}

export interface CapabilityAcceptanceManifest {
  schemaVersion: 1;
  release: string;
  capabilities: CapabilityAcceptanceDefinition[];
}

export type CapabilityCellStatus =
  | "PROVEN"
  | "FAILED"
  | "UNPROVEN"
  | "NOT_APPLICABLE";

export interface CapabilityCellResult {
  status: CapabilityCellStatus;
  evidence: string[];
  failedEvidence: string[];
  missingEvidence: string[];
  skippedEvidence: string[];
  rationale?: string;
}

export interface CapabilityAcceptanceResult {
  id: string;
  title: string;
  mandatory: boolean;
  maturity: CapabilityMaturity;
  cells: Record<CapabilityAcceptanceColumn, CapabilityCellResult>;
  remainingLimitation: string | null;
}

export interface CapabilityAcceptanceReport {
  schemaVersion: 1;
  release: string;
  commit: string;
  generatedAt: string;
  status: "PASSED" | "FAILED";
  capabilities: CapabilityAcceptanceResult[];
  summary: {
    total: number;
    mandatory: number;
    productized: number;
    mandatoryNotProductized: string[];
  };
}

function evaluateRequirement(
  requirement: CapabilityRequirement,
  ledger: CapabilityEvidenceLedger,
): CapabilityCellResult {
  const required = requirement.required ?? true;
  if (!required) {
    if (!requirement.rationale?.trim()) {
      throw new Error(
        "NOT_APPLICABLE capability requirements need an explicit rationale.",
      );
    }
    return {
      status: "NOT_APPLICABLE",
      evidence: [],
      failedEvidence: [],
      missingEvidence: [],
      skippedEvidence: [],
      rationale: requirement.rationale,
    };
  }

  if (requirement.evidence.length === 0) {
    return {
      status: "UNPROVEN",
      evidence: [],
      failedEvidence: [],
      missingEvidence: ["<no-evidence-declared>"],
      skippedEvidence: [],
    };
  }

  const failedEvidence: string[] = [];
  const missingEvidence: string[] = [];
  const skippedEvidence: string[] = [];
  for (const evidenceId of requirement.evidence) {
    const record = ledger.evidence[evidenceId];
    if (!record) {
      missingEvidence.push(evidenceId);
      continue;
    }
    if (record.status === "FAILED") failedEvidence.push(evidenceId);
    if (record.status === "SKIPPED") skippedEvidence.push(evidenceId);
  }

  const status: CapabilityCellStatus =
    failedEvidence.length > 0
      ? "FAILED"
      : missingEvidence.length > 0 || skippedEvidence.length > 0
        ? "UNPROVEN"
        : "PROVEN";

  return {
    status,
    evidence: [...requirement.evidence],
    failedEvidence,
    missingEvidence,
    skippedEvidence,
  };
}

function satisfied(cell: CapabilityCellResult): boolean {
  return cell.status === "PROVEN" || cell.status === "NOT_APPLICABLE";
}

export function deriveCapabilityMaturity(
  cells: Record<CapabilityAcceptanceColumn, CapabilityCellResult>,
): CapabilityMaturity {
  let maturity: CapabilityMaturity = "DESIGNED";
  if (!satisfied(cells.runtimeTest)) return maturity;
  maturity = "FUNCTIONAL";
  if (!satisfied(cells.integrationTest)) return maturity;
  maturity = "INTEGRATED";
  if (!satisfied(cells.negativeTest) || !satisfied(cells.securityTest)) {
    return maturity;
  }
  maturity = "HARDENED";
  if (!satisfied(cells.recoveryTest) || !satisfied(cells.operatorSurface)) {
    return maturity;
  }
  maturity = "OPERABLE";
  if (!satisfied(cells.benchmark)) return maturity;
  maturity = "BENCHMARKED";
  if (!satisfied(cells.docs)) return maturity;
  maturity = "DOCUMENTED";
  if (!satisfied(cells.remoteCi)) return maturity;
  return "PRODUCTIZED";
}

export function evaluateCapabilityAcceptance(
  manifest: CapabilityAcceptanceManifest,
  ledger: CapabilityEvidenceLedger,
): CapabilityAcceptanceReport {
  if (manifest.schemaVersion !== 1 || ledger.schemaVersion !== 1) {
    throw new Error("Unsupported capability acceptance schema version.");
  }
  const ids = new Set<string>();
  const capabilities = manifest.capabilities.map((capability) => {
    if (!capability.id.trim() || ids.has(capability.id)) {
      throw new Error(
        `Capability id is missing or duplicated: ${capability.id}`,
      );
    }
    ids.add(capability.id);
    const actualColumns = Object.keys(capability.requirements).sort();
    const expectedColumns = [...CAPABILITY_ACCEPTANCE_COLUMNS].sort();
    if (JSON.stringify(actualColumns) !== JSON.stringify(expectedColumns)) {
      throw new Error(
        `Capability ${capability.id} must define every acceptance column exactly once.`,
      );
    }
    const cells = Object.fromEntries(
      CAPABILITY_ACCEPTANCE_COLUMNS.map((column) => [
        column,
        evaluateRequirement(capability.requirements[column], ledger),
      ]),
    ) as Record<CapabilityAcceptanceColumn, CapabilityCellResult>;
    return {
      id: capability.id,
      title: capability.title,
      mandatory: capability.mandatory,
      maturity: deriveCapabilityMaturity(cells),
      cells,
      remainingLimitation: capability.remainingLimitation?.trim() || null,
    };
  });

  const mandatoryNotProductized = capabilities
    .filter(
      (capability) =>
        capability.mandatory && capability.maturity !== "PRODUCTIZED",
    )
    .map((capability) => capability.id);

  return {
    schemaVersion: 1,
    release: manifest.release,
    commit: ledger.commit,
    generatedAt: ledger.generatedAt,
    status: mandatoryNotProductized.length === 0 ? "PASSED" : "FAILED",
    capabilities,
    summary: {
      total: capabilities.length,
      mandatory: capabilities.filter((capability) => capability.mandatory)
        .length,
      productized: capabilities.filter(
        (capability) => capability.maturity === "PRODUCTIZED",
      ).length,
      mandatoryNotProductized,
    },
  };
}

function markdownCell(cell: CapabilityCellResult): string {
  if (cell.status === "NOT_APPLICABLE") {
    return `N/A — ${cell.rationale ?? "not applicable"}`;
  }
  return cell.status;
}

export function renderCapabilityAcceptanceMarkdown(
  report: CapabilityAcceptanceReport,
): string {
  const header = [
    "# Capability Acceptance Matrix",
    "",
    `Release: ${report.release}`,
    `Commit: ${report.commit}`,
    `Status: ${report.status}`,
    "",
    "| Capability | Maturity | Runtime test | Negative test | Integration test | Recovery test | Security test | Operator surface | Docs | Benchmark | Remote CI | Remaining limitation |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  const rows = report.capabilities.map((capability) => {
    const cell = (column: CapabilityAcceptanceColumn) =>
      markdownCell(capability.cells[column]).replaceAll("|", "\\|");
    return [
      capability.title.replaceAll("|", "\\|"),
      capability.maturity,
      cell("runtimeTest"),
      cell("negativeTest"),
      cell("integrationTest"),
      cell("recoveryTest"),
      cell("securityTest"),
      cell("operatorSurface"),
      cell("docs"),
      cell("benchmark"),
      cell("remoteCi"),
      (capability.remainingLimitation ?? "None").replaceAll("|", "\\|"),
    ].join(" | ");
  });
  return [...header, ...rows.map((row) => `| ${row} |`), ""].join("\n");
}
