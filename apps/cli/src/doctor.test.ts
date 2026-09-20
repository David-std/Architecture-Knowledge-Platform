import { describe, expect, it } from "vitest";
import {
  overallDoctorStatus,
  renderDoctorReport,
  type DoctorReport,
} from "./doctor.js";

describe("doctor rendering", () => {
  it("returns the worst bounded status for machine automation", () => {
    expect(
      overallDoctorStatus([
        { id: "a", label: "A", status: "OK", summary: "ok" },
        { id: "b", label: "B", status: "UNKNOWN", summary: "unknown" },
      ]),
    ).toBe("UNKNOWN");
    expect(
      overallDoctorStatus([
        { id: "a", label: "A", status: "WARN", summary: "warn" },
        { id: "b", label: "B", status: "FAIL", summary: "fail" },
      ]),
    ).toBe("FAIL");
  });

  it("renders the same diagnostic state in human-readable form", () => {
    const report: DoctorReport = {
      schemaVersion: 1,
      generatedAt: "2026-09-20T05:00:00.000Z",
      overall: "WARN",
      checks: [
        {
          id: "backup-recency",
          label: "Backup recency",
          status: "WARN",
          summary: "Latest backup is old.",
          details: { ageHours: 48 },
        },
      ],
    };
    const rendered = renderDoctorReport(report);
    expect(rendered).toContain("AKP doctor: WARN");
    expect(rendered).toContain("[WARN] Backup recency");
    expect(rendered).toContain('\"ageHours\":48');
  });
});
