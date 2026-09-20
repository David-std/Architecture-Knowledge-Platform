import { describe, expect, it } from "vitest";
import {
  evaluateParityExclusions,
  renderParityExclusionDomainMarkdown,
  renderParityExclusionIndexMarkdown,
  type ParityExclusionManifest,
} from "../src/parity-exclusion.js";
import type { CapabilityAcceptanceReport } from "../src/capability-acceptance.js";

const domains = [
  "code-graph",
  "enterprise-workspace-context",
  "retrieval-context-engineering",
  "temporal-truth",
  "coordination-plane",
  "connectors",
];

function acceptance(
  maturity: CapabilityAcceptanceReport["capabilities"][number]["maturity"] = "PRODUCTIZED",
): CapabilityAcceptanceReport {
  return {
    schemaVersion: 1,
    release: "v0.4.0",
    commit: "a".repeat(40),
    generatedAt: "2026-09-20T00:00:00.000Z",
    status: maturity === "PRODUCTIZED" ? "PASSED" : "FAILED",
    capabilities: [
      {
        id: "capability-a",
        title: "Capability A",
        mandatory: true,
        maturity,
        cells: {} as CapabilityAcceptanceReport["capabilities"][number]["cells"],
        remainingLimitation: null,
      },
    ],
    summary: {
      total: 1,
      mandatory: 1,
      productized: maturity === "PRODUCTIZED" ? 1 : 0,
      mandatoryNotProductized:
        maturity === "PRODUCTIZED" ? [] : ["capability-a"],
    },
  };
}

function manifest(): ParityExclusionManifest {
  return {
    schemaVersion: 1,
    release: "v0.4.0",
    domains: domains.map((id) => ({
      id,
      title: id,
      items: [
        {
          id: "implemented",
          title: "Implemented item",
          classification: "IMPLEMENTED",
          requiredCapabilities: ["capability-a"],
          rationale: "Backed by the capability acceptance matrix.",
        },
        {
          id: "deferred",
          title: "Deferred reference",
          classification: "DEFERRED_WITH_REASON",
          requiredCapabilities: [],
          rationale: "No comparable executed adapter is part of this release.",
        },
      ],
    })),
  };
}

describe("parity exclusion reporting", () => {
  it("passes only when implemented claims are backed by productized capabilities", () => {
    const report = evaluateParityExclusions(manifest(), acceptance());
    expect(report.status).toBe("PASSED");
    expect(report.domains).toHaveLength(6);
    expect(report.domains[0]?.items[0]).toMatchObject({
      status: "SUPPORTED",
      capabilityMaturity: { "capability-a": "PRODUCTIZED" },
    });
    expect(report.domains[0]?.items[1]?.status).toBe("EXCLUDED");
  });

  it("fails an implemented claim when its capability is not productized", () => {
    const report = evaluateParityExclusions(manifest(), acceptance("OPERABLE"));
    expect(report.status).toBe("FAILED");
    expect(report.failures[0]).toContain("CAPABILITY_NOT_PRODUCTIZED");
  });

  it("requires exactly the six Deep Spec parity/exclusion domains", () => {
    const value = manifest();
    value.domains = value.domains.slice(0, 5);
    expect(() => evaluateParityExclusions(value, acceptance())).toThrow(
      /six required domains/,
    );
  });

  it("renders index and domain reports without converting exclusions to support", () => {
    const report = evaluateParityExclusions(manifest(), acceptance());
    expect(renderParityExclusionIndexMarkdown(report)).toContain(
      "Explicitly excluded",
    );
    expect(renderParityExclusionDomainMarkdown(report, "code-graph")).toContain(
      "DEFERRED_WITH_REASON",
    );
  });
});
