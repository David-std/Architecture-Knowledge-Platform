import { describe, expect, it } from "vitest";
import {
  CAPABILITY_ACCEPTANCE_COLUMNS,
  evaluateCapabilityAcceptance,
  renderCapabilityAcceptanceMarkdown,
  type CapabilityAcceptanceManifest,
  type CapabilityEvidenceLedger,
} from "../src/capability-acceptance.js";

function manifest(): CapabilityAcceptanceManifest {
  const requirements = Object.fromEntries(
    CAPABILITY_ACCEPTANCE_COLUMNS.map((column) => [
      column,
      { evidence: [`evidence:${column}`] },
    ]),
  ) as CapabilityAcceptanceManifest["capabilities"][number]["requirements"];
  return {
    schemaVersion: 1,
    release: "v0.4.0",
    capabilities: [
      {
        id: "example",
        title: "Example capability",
        mandatory: true,
        requirements,
        remainingLimitation: null,
      },
    ],
  };
}

function ledger(
  overrides: Record<string, "PASSED" | "FAILED" | "SKIPPED"> = {},
): CapabilityEvidenceLedger {
  return {
    schemaVersion: 1,
    commit: "a".repeat(40),
    generatedAt: "2026-09-20T07:00:00.000Z",
    evidence: Object.fromEntries(
      CAPABILITY_ACCEPTANCE_COLUMNS.map((column) => {
        const id = `evidence:${column}`;
        return [
          id,
          {
            status: overrides[id] ?? "PASSED",
            source: id,
            kind:
              column === "docs"
                ? "DOCUMENT"
                : column === "operatorSurface"
                  ? "OPERATOR_SURFACE"
                  : "EXECUTABLE",
          },
        ];
      }),
    ),
  };
}

describe("capability acceptance", () => {
  it("derives PRODUCTIZED only when every mandatory stage is proven", () => {
    const report = evaluateCapabilityAcceptance(manifest(), ledger());
    expect(report.status).toBe("PASSED");
    expect(report.capabilities[0]?.maturity).toBe("PRODUCTIZED");
    expect(report.summary.mandatoryNotProductized).toEqual([]);
  });

  it("cannot override failing executable evidence with a manual maturity claim", () => {
    const report = evaluateCapabilityAcceptance(
      manifest(),
      ledger({ "evidence:benchmark": "FAILED" }),
    );
    expect(report.status).toBe("FAILED");
    expect(report.capabilities[0]?.maturity).toBe("OPERABLE");
    expect(report.capabilities[0]?.cells.benchmark.status).toBe("FAILED");
  });

  it("treats skipped or missing remote CI evidence as unproven", () => {
    const skipped = evaluateCapabilityAcceptance(
      manifest(),
      ledger({ "evidence:remoteCi": "SKIPPED" }),
    );
    expect(skipped.capabilities[0]?.maturity).toBe("DOCUMENTED");
    expect(skipped.capabilities[0]?.cells.remoteCi.status).toBe("UNPROVEN");

    const missingLedger = ledger();
    delete missingLedger.evidence["evidence:remoteCi"];
    const missing = evaluateCapabilityAcceptance(manifest(), missingLedger);
    expect(missing.capabilities[0]?.maturity).toBe("DOCUMENTED");
    expect(missing.status).toBe("FAILED");
  });

  it("renders the computed matrix without changing evidence state", () => {
    const report = evaluateCapabilityAcceptance(manifest(), ledger());
    const markdown = renderCapabilityAcceptanceMarkdown(report);
    expect(markdown).toContain("# Capability Acceptance Matrix");
    expect(markdown).toContain("| Example capability | PRODUCTIZED |");
    expect(markdown).toContain("| Remote CI |");
  });
});
