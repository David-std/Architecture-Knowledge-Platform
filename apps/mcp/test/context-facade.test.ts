import { describe, expect, it, vi } from "vitest";
import { dispatchAkpContext } from "../src/context-facade.js";

describe("akp_context façade", () => {
  it("delegates status and preserves an explicit action envelope", async () => {
    const api = vi.fn(async () => ({ status: "UP" }));
    const writeApi = vi.fn();

    await expect(
      dispatchAkpContext(
        { action: "STATUS" },
        { api, writeApi: writeApi as never },
      ),
    ).resolves.toEqual({
      schemaVersion: 1,
      action: "STATUS",
      status: "OK",
      delegatedTo: "akp_status",
      result: { status: "UP" },
    });
    expect(api).toHaveBeenCalledWith("/v1/status");
    expect(writeApi).not.toHaveBeenCalled();
  });

  it("delegates search and global synthesis to the existing retrieval/context APIs", async () => {
    const api = vi.fn(async (route: string, init?: RequestInit) => ({
      route,
      body: init?.body,
    }));
    const writeApi = vi.fn();
    const scope = {
      spaceId: "11111111-1111-4111-8111-111111111111",
      vaultId: "22222222-2222-4222-8222-222222222222",
      query: "dependency inversion",
    };

    const search = await dispatchAkpContext(
      { action: "SEARCH", ...scope },
      { api, writeApi: writeApi as never },
    );
    expect(search).toMatchObject({
      action: "SEARCH",
      delegatedTo: "akp_search",
    });
    expect(api).toHaveBeenNthCalledWith(
      1,
      "/v1/search",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String((api.mock.calls[0]?.[1] as RequestInit).body))).toMatchObject({
      query: "dependency inversion",
      spaceId: scope.spaceId,
      vaultIds: [scope.vaultId],
      intent: "CONCEPTUAL",
    });

    const global = await dispatchAkpContext(
      { action: "GLOBAL", ...scope },
      { api, writeApi: writeApi as never },
    );
    expect(global).toMatchObject({
      action: "GLOBAL",
      delegatedTo: "akp_build_context",
    });
    expect(api).toHaveBeenNthCalledWith(
      2,
      "/v1/context",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.parse(String((api.mock.calls[1]?.[1] as RequestInit).body))).toMatchObject({
      intent: "GLOBAL_SYNTHESIS",
      packetMode: "COMPACT_AGENT_PACKET",
    });
  });

  it("delegates code impact and temporal reads without creating another retrieval stack", async () => {
    const api = vi.fn(async (route: string, init?: RequestInit) => ({
      route,
      body: init?.body,
    }));
    const writeApi = vi.fn();
    const spaceId = "11111111-1111-4111-8111-111111111111";
    const vaultId = "22222222-2222-4222-8222-222222222222";

    const code = await dispatchAkpContext(
      {
        action: "CODE",
        codeOperation: "IMPACT",
        spaceId,
        vaultId,
        selector: {
          repository: "akp-project:22222222-2222-4222-8222-222222222222:api",
          name: "PaymentService",
        },
        codeOptions: { maxHops: 3, includeTests: true },
      },
      { api, writeApi: writeApi as never },
    );
    expect(code).toMatchObject({
      action: "CODE",
      delegatedTo: "akp_analyze_code_impact",
    });
    expect(api).toHaveBeenNthCalledWith(
      1,
      "/v1/code/impact",
      expect.objectContaining({ method: "POST" }),
    );

    const temporal = await dispatchAkpContext(
      {
        action: "TEMPORAL",
        spaceId,
        vaultId,
        temporal: {
          mode: "HISTORY",
          subjectRef: "ADR-42",
          predicate: "status",
          limit: 20,
        },
      },
      { api, writeApi: writeApi as never },
    );
    expect(temporal).toMatchObject({
      action: "TEMPORAL",
      delegatedTo: "temporal_truth",
    });
    expect(api.mock.calls[1]?.[0]).toContain("/v1/truth/facts?");
    expect(api.mock.calls[1]?.[0]).toContain("subjectRef=ADR-42");
    expect(api.mock.calls[1]?.[0]).toContain("mode=HISTORY");
  });

  it("routes capture and task writes through existing idempotent workspace use cases", async () => {
    const api = vi.fn();
    const writeApi = vi.fn(async () => ({ accepted: true }));
    const sessionId = "33333333-3333-4333-8333-333333333333";

    await dispatchAkpContext(
      {
        action: "CAPTURE",
        sessionId,
        idempotencyKey: "capture-12345678",
        capture: {
          eventType: "FINDING",
          payload: { summary: "Observed behavior" },
        },
      },
      { api: api as never, writeApi },
    );
    expect(writeApi).toHaveBeenNthCalledWith(
      1,
      `/v1/sessions/${sessionId}/events`,
      "capture-12345678",
      {
        eventType: "FINDING",
        payload: { summary: "Observed behavior" },
      },
    );

    await dispatchAkpContext(
      {
        action: "TASK",
        sessionId,
        idempotencyKey: "task-12345678",
        task: {
          status: "COMPLETED",
          outcome: "Completed with reviewed evidence.",
          touchedResources: ["src/payment.ts"],
        },
      },
      { api: api as never, writeApi },
    );
    expect(writeApi).toHaveBeenNthCalledWith(
      2,
      `/v1/sessions/${sessionId}/work-context`,
      "task-12345678",
      expect.objectContaining({ status: "COMPLETED" }),
    );
  });

  it("fails closed on missing action-specific scope instead of widening it", async () => {
    const api = vi.fn();
    const writeApi = vi.fn();
    await expect(
      dispatchAkpContext(
        { action: "SEARCH", query: "architecture" },
        { api: api as never, writeApi: writeApi as never },
      ),
    ).rejects.toThrow("AKP_CONTEXT_SPACE_REQUIRED");
    expect(api).not.toHaveBeenCalled();
    expect(writeApi).not.toHaveBeenCalled();
  });
});
