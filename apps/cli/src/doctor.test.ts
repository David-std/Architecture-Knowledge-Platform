import { describe, expect, it, vi } from "vitest";
import type { Postgres } from "@akp/postgres";
import {
  graphChecks,
  modelRoutingCheck,
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

  it("reports disabled model routing without requiring a provider", () => {
    expect(modelRoutingCheck({ AKP_LLM_PROVIDER: "disabled" })).toMatchObject({
      id: "model-routing",
      status: "OK",
      details: {
        mode: "DISABLED",
        externalProviderRequired: false,
        secretsExposed: false,
      },
    });
  });

  it("reports role-policy routing without exposing endpoint URLs or keys", () => {
    const check = modelRoutingCheck({
      AKP_MODEL_ROLE_POLICIES_JSON: JSON.stringify([
        {
          role: "KNOWLEDGE_COMPILE",
          provider: "openai-compatible",
          model: "local-compiler",
          endpointRef: "local",
          dataResidency: "LOCAL_ONLY",
          fallbackRolesOrModels: [],
        },
      ]),
      AKP_MODEL_ENDPOINTS_JSON: JSON.stringify({
        local: {
          baseUrl: "http://127.0.0.1:11434/v1",
          dataResidency: "LOCAL_ONLY",
          apiKeyEnv: "LOCAL_MODEL_KEY",
        },
      }),
      LOCAL_MODEL_KEY: "must-not-be-rendered",
    });
    expect(check).toMatchObject({
      id: "model-routing",
      status: "OK",
      details: {
        mode: "ROLE_POLICY",
        endpointCount: 1,
        secretsExposed: false,
      },
    });
    expect(JSON.stringify(check)).not.toContain("must-not-be-rendered");
    expect(JSON.stringify(check)).not.toContain("11434");
  });

  it("fails safely on unresolved model endpoint references", () => {
    expect(
      modelRoutingCheck({
        AKP_MODEL_ROLE_POLICIES_JSON: JSON.stringify([
          {
            role: "KNOWLEDGE_COMPILE",
            provider: "openai-compatible",
            model: "compiler",
            endpointRef: "missing",
            dataResidency: "LOCAL_ONLY",
          },
        ]),
        AKP_MODEL_ENDPOINTS_JSON: "{}",
      }),
    ).toMatchObject({
      id: "model-routing",
      status: "FAIL",
      details: { code: "MODEL_ENDPOINT_REF_UNRESOLVED" },
    });
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

  it("reports current CODE graph health without treating retired history as stale", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("with ranked as")) {
        return {
          rows: [
            {
              graph_domain: "CODE",
              active: 1,
              stale: 0,
              failed: 0,
              building: 0,
              retired: 1,
              latest_update: new Date("2026-09-20T05:00:00.000Z"),
            },
          ],
        };
      }
      if (sql.includes("from projects p")) {
        return {
          rows: [
            {
              repository: "akp-project:vault:payments",
              slug: "payments",
              requested_sha: "a".repeat(40),
              active_graph_sha: "a".repeat(40),
              active_freshness: "FRESH",
              provider: "graphify",
              provider_version: "0.9.63",
              last_build: new Date("2026-09-20T05:00:00.000Z"),
              node_count: 42,
              edge_count: 51,
              warning_count: "37",
              warnings: [
                { code: "CODE_GRAPH_FILE_EXCLUDED", path: "gen/a.ts" },
              ],
              last_failure_code: "GRAPHIFY_PROCESS_FAILED",
              last_failure_at: new Date("2026-09-20T04:00:00.000Z"),
            },
          ],
        };
      }
      throw new Error("UNEXPECTED_DOCTOR_QUERY");
    });
    const result = await graphChecks({
      pool: { query },
    } as unknown as Postgres);

    expect(result.graphs).toMatchObject({
      details: {
        domains: {
          CODE: {
            active: 1,
            stale: 0,
            failed: 0,
            retired: 1,
          },
        },
      },
    });
    expect(result.code).toMatchObject({
      status: "OK",
      details: {
        projects: [
          {
            repository: "akp-project:vault:payments",
            requestedSha: "a".repeat(40),
            activeGraphSha: "a".repeat(40),
            stale: false,
            provider: "graphify",
            providerVersion: "0.9.63",
            nodeCount: 42,
            edgeCount: 51,
            warningCount: 37,
            lastFailure: {
              code: "GRAPHIFY_PROCESS_FAILED",
              unrecovered: false,
            },
            status: "OK",
          },
        ],
      },
    });
    expect(JSON.stringify(result.code)).not.toContain("root_path");
  });
});
