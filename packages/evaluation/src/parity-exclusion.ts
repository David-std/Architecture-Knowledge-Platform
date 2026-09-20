import type {
  CapabilityAcceptanceReport,
  CapabilityMaturity,
} from "./capability-acceptance.js";

export const PARITY_EXCLUSION_CLASSIFICATIONS = [
  "IMPLEMENTED",
  "ADAPTER_PROVIDED",
  "BENCHMARKED_NOT_ADOPTED",
  "DEFERRED_WITH_REASON",
  "BLOCKED_EXTERNAL",
] as const;

export type ParityExclusionClassification =
  (typeof PARITY_EXCLUSION_CLASSIFICATIONS)[number];

export interface ParityExclusionItemDefinition {
  id: string;
  title: string;
  classification: ParityExclusionClassification;
  requiredCapabilities: string[];
  rationale: string;
  reference?: string;
}

export interface ParityExclusionDomainDefinition {
  id: string;
  title: string;
  items: ParityExclusionItemDefinition[];
}

export interface ParityExclusionManifest {
  schemaVersion: 1;
  release: string;
  domains: ParityExclusionDomainDefinition[];
}

export interface ParityExclusionItemResult
  extends ParityExclusionItemDefinition {
  status: "SUPPORTED" | "EXCLUDED" | "FAILED";
  capabilityMaturity: Record<string, CapabilityMaturity>;
  failures: string[];
}

export interface ParityExclusionDomainResult {
  id: string;
  title: string;
  status: "PASSED" | "FAILED";
  items: ParityExclusionItemResult[];
}

export interface ParityExclusionReport {
  schemaVersion: 1;
  release: string;
  commit: string;
  generatedAt: string;
  status: "PASSED" | "FAILED";
  domains: ParityExclusionDomainResult[];
  failures: string[];
}

const expectedDomainIds = [
  "code-graph",
  "enterprise-workspace-context",
  "retrieval-context-engineering",
  "temporal-truth",
  "coordination-plane",
  "connectors",
] as const;

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function isImplementedClassification(
  classification: ParityExclusionClassification,
): boolean {
  return (
    classification === "IMPLEMENTED" ||
    classification === "ADAPTER_PROVIDED"
  );
}

export function evaluateParityExclusions(
  manifest: ParityExclusionManifest,
  acceptance: CapabilityAcceptanceReport,
): ParityExclusionReport {
  if (manifest.schemaVersion !== 1 || acceptance.schemaVersion !== 1) {
    throw new Error("Unsupported parity/exclusion schema version.");
  }
  if (manifest.release !== acceptance.release) {
    throw new Error("Parity/exclusion and capability releases do not match.");
  }

  const actualDomainIds = manifest.domains.map((domain) => domain.id).sort();
  const expected = [...expectedDomainIds].sort();
  if (
    !unique(actualDomainIds) ||
    JSON.stringify(actualDomainIds) !== JSON.stringify(expected)
  ) {
    throw new Error(
      "Parity/exclusion manifest must define the six required domains exactly once.",
    );
  }

  const capabilityById = new Map(
    acceptance.capabilities.map((capability) => [capability.id, capability]),
  );
  const reportFailures: string[] = [];
  const domains = manifest.domains.map((domain) => {
    if (!domain.title.trim() || domain.items.length === 0) {
      throw new Error(
        `Parity/exclusion domain ${domain.id} must have a title and items.`,
      );
    }
    const itemIds = domain.items.map((item) => item.id);
    if (!unique(itemIds)) {
      throw new Error(
        `Parity/exclusion domain ${domain.id} contains duplicate item IDs.`,
      );
    }

    const items = domain.items.map((item) => {
      if (
        !item.id.trim() ||
        !item.title.trim() ||
        !item.rationale.trim() ||
        !PARITY_EXCLUSION_CLASSIFICATIONS.includes(item.classification)
      ) {
        throw new Error(
          `Parity/exclusion item ${domain.id}/${item.id} is incomplete.`,
        );
      }
      if (!unique(item.requiredCapabilities)) {
        throw new Error(
          `Parity/exclusion item ${domain.id}/${item.id} repeats a capability.`,
        );
      }
      if (
        isImplementedClassification(item.classification) &&
        item.requiredCapabilities.length === 0
      ) {
        throw new Error(
          `Implemented parity/exclusion item ${domain.id}/${item.id} needs capability evidence.`,
        );
      }

      const failures: string[] = [];
      const capabilityMaturity: Record<string, CapabilityMaturity> = {};
      for (const capabilityId of item.requiredCapabilities) {
        const capability = capabilityById.get(capabilityId);
        if (!capability) {
          failures.push(`UNKNOWN_CAPABILITY:${capabilityId}`);
          continue;
        }
        capabilityMaturity[capabilityId] = capability.maturity;
        if (
          isImplementedClassification(item.classification) &&
          capability.maturity !== "PRODUCTIZED"
        ) {
          failures.push(
            `CAPABILITY_NOT_PRODUCTIZED:${capabilityId}:${capability.maturity}`,
          );
        }
      }

      const excluded =
        item.classification === "DEFERRED_WITH_REASON" ||
        item.classification === "BLOCKED_EXTERNAL" ||
        item.classification === "BENCHMARKED_NOT_ADOPTED";
      const status: ParityExclusionItemResult["status"] =
        failures.length > 0 ? "FAILED" : excluded ? "EXCLUDED" : "SUPPORTED";
      for (const failure of failures) {
        reportFailures.push(`${domain.id}/${item.id}:${failure}`);
      }
      return {
        ...item,
        status,
        capabilityMaturity,
        failures,
      };
    });

    return {
      id: domain.id,
      title: domain.title,
      status: items.some((item) => item.status === "FAILED")
        ? ("FAILED" as const)
        : ("PASSED" as const),
      items,
    };
  });

  return {
    schemaVersion: 1,
    release: manifest.release,
    commit: acceptance.commit,
    generatedAt: acceptance.generatedAt,
    status: reportFailures.length === 0 ? "PASSED" : "FAILED",
    domains,
    failures: reportFailures,
  };
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

export function renderParityExclusionDomainMarkdown(
  report: ParityExclusionReport,
  domainId: string,
): string {
  const domain = report.domains.find((candidate) => candidate.id === domainId);
  if (!domain) throw new Error(`Unknown parity/exclusion domain ${domainId}.`);

  const lines = [
    `# ${domain.title} parity / exclusion report`,
    "",
    `Release: ${report.release}`,
    `Commit: ${report.commit}`,
    `Status: ${domain.status}`,
    "",
    "| Item | Classification | Status | Required capabilities | Reference | Rationale |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const item of domain.items) {
    lines.push(
      `| ${escapeCell(item.title)} | ${item.classification} | ${item.status} | ${escapeCell(item.requiredCapabilities.join(", ") || "None")} | ${escapeCell(item.reference ?? "None")} | ${escapeCell(item.rationale)} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderParityExclusionIndexMarkdown(
  report: ParityExclusionReport,
): string {
  const lines = [
    "# v0.4 parity / exclusion reports",
    "",
    `Release: ${report.release}`,
    `Commit: ${report.commit}`,
    `Status: ${report.status}`,
    "",
    "| Domain | Status | Supported | Explicitly excluded |",
    "| --- | --- | ---: | ---: |",
  ];
  for (const domain of report.domains) {
    const supported = domain.items.filter(
      (item) => item.status === "SUPPORTED",
    ).length;
    const excluded = domain.items.filter(
      (item) => item.status === "EXCLUDED",
    ).length;
    lines.push(
      `| ${escapeCell(domain.title)} | ${domain.status} | ${supported} | ${excluded} |`,
    );
  }
  lines.push("");
  return lines.join("\n");
}
