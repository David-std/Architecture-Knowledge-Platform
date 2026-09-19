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

  it("enriches bootstrap without replacing authorized context or revision provenance", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const bootstrap = {
      schemaVersion: 1,
      revisionSetHash: "a".repeat(64),
      effectiveRevisionSetHash: "b".repeat(64),
      contextRevisionSet: {
        corpus: { revision: "corpus:r7" },
        authorization: { revision: "auth:r3" },
      },
      authorization: {
        principalId: "principal-a",
        allowedActions: ["workspace:read", "workspace:event:append"],
      },
      workContext: {
        session: {
          id: sessionId,
          projectId: "44444444-4444-4444-8444-444444444444",
        },
      },
      agentInstructionDigest: {
        directives: [
          "USE_PINNED_CONTEXT_REVISION",
          "PROMOTION_REQUIRES_GOVERNED_REVIEW",
        ],
      },
      context: {
        packetMode: "COMPACT_AGENT_PACKET",
        packetHash: "packet-hash",
        gaps: ["MANDATORY_KIND:decision"],
        conflicts: ["ADR-1 conflicts with ADR-2"],
        continuations: [
          {
            handle: "c".repeat(64),
            reason: "budget",
            remainingTokens: 800,
          },
        ],
      },
    };
    const api = vi.fn(async () => bootstrap);
    const writeApi = vi.fn();

    const result = await dispatchAkpContext(
      {
        action: "BOOTSTRAP",
        sessionId,
        query: "prepare refactor",
      },
      { api, writeApi: writeApi as never },
    );

    expect(result).toMatchObject({
      schemaVersion: 1,
      action: "BOOTSTRAP",
      status: "OK",
      delegatedTo: "akp_bootstrap_session_context",
      result: {
        revisionSetHash: bootstrap.revisionSetHash,
        effectiveRevisionSetHash: bootstrap.effectiveRevisionSetHash,
        contextRevisionSet: bootstrap.contextRevisionSet,
        context: bootstrap.context,
        permittedActions: ["workspace:read", "workspace:event:append"],
        mandatoryPolicies: [
          "USE_PINNED_CONTEXT_REVISION",
          "PROMOTION_REQUIRES_GOVERNED_REVIEW",
        ],
        gaps: ["MANDATORY_KIND:decision"],
        conflicts: ["ADR-1 conflicts with ADR-2"],
        continuationTokens: ["c".repeat(64)],
        codeOrientation: {
          projectId: "44444444-4444-4444-8444-444444444444",
          mode: "PROJECT_SCOPED_TARGETED",
          action: "CODE",
        },
        instructionBundle: {
          digest: expect.stringMatching(/^[a-f0-9]{64}$/),
          resourceUri: expect.stringMatching(
            /^akp:\/\/instructions\/agent\/v1\/[a-f0-9]{64}$/,
          ),
        },
      },
    });
    expect(api).toHaveBeenCalledWith(
      `/v1/sessions/${sessionId}/bootstrap`,
      expect.objectContaining({ method: "POST" }),
    );
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
    expect(
      JSON.parse(String((api.mock.calls[0]?.[1] as RequestInit).body)),
    ).toMatchObject({
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
    expect(
      JSON.parse(String((api.mock.calls[1]?.[1] as RequestInit).body)),
    ).toMatchObject({
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

  it("returns an explicit degraded envelope only for optional Code Graph readiness failures", async () => {
    const api = vi.fn(async () => {
      throw new Error('AKP API 409: {"code":"CODE_GRAPH_NOT_READY"}');
    });
    const writeApi = vi.fn();

    await expect(
      dispatchAkpContext(
        {
          action: "CODE",
          codeOperation: "SYMBOL",
          spaceId: "11111111-1111-4111-8111-111111111111",
          vaultId: "22222222-2222-4222-8222-222222222222",
          selector: {
            repository: "akp-project:22222222-2222-4222-8222-222222222222:api",
            name: "PaymentService",
          },
        },
        { api, writeApi: writeApi as never },
      ),
    ).resolves.toMatchObject({
      action: "CODE",
      status: "DEGRADED",
      delegatedTo: "akp_find_code_symbol",
      error: { code: "CODE_GRAPH_NOT_READY", statusCode: 409 },
      diagnostics: {
        optionalChannel: "CODE_GRAPH",
        freshnessPolicy: "FRESH_ONLY",
        retryAfterRefresh: true,
        expertToolsUnaffected: true,
      },
    });

    api.mockRejectedValueOnce(
      new Error('AKP API 403: {"code":"VAULT_ACCESS_DENIED"}'),
    );
    await expect(
      dispatchAkpContext(
        {
          action: "CODE",
          codeOperation: "SYMBOL",
          spaceId: "11111111-1111-4111-8111-111111111111",
          vaultId: "22222222-2222-4222-8222-222222222222",
          selector: {
            repository: "akp-project:22222222-2222-4222-8222-222222222222:api",
            name: "PaymentService",
          },
        },
        { api, writeApi: writeApi as never },
      ),
    ).rejects.toThrow("VAULT_ACCESS_DENIED");
  });

  it("returns an explicit strict-pin error when task context revisions changed", async () => {
    const api = vi.fn(async () => {
      throw new Error('AKP API 409: {"code":"CONTEXT_REVISION_CHANGED"}');
    });
    const writeApi = vi.fn();

    await expect(
      dispatchAkpContext(
        {
          action: "BOOTSTRAP",
          sessionId: "33333333-3333-4333-8333-333333333333",
        },
        { api, writeApi: writeApi as never },
      ),
    ).resolves.toMatchObject({
      action: "BOOTSTRAP",
      status: "ERROR",
      error: { code: "CONTEXT_REVISION_CHANGED", statusCode: 409 },
      diagnostics: {
        pinPolicy: "STRICT",
        revisionChanged: true,
        retryRequiresRebootstrap: true,
        expertToolsUnaffected: true,
      },
    });
  });

  it("keeps no-answer explicit in the façade envelope", async () => {
    const noAnswer = {
      reason: "NO_SOURCE_BACKED_MATCH",
      message: "No source-backed material matched the request.",
    };
    const api = vi.fn(async () => ({ hits: [], noAnswer }));
    const writeApi = vi.fn();

    await expect(
      dispatchAkpContext(
        {
          action: "SEARCH",
          query: "unknown cloud region",
          spaceId: "11111111-1111-4111-8111-111111111111",
          vaultId: "22222222-2222-4222-8222-222222222222",
        },
        { api, writeApi: writeApi as never },
      ),
    ).resolves.toMatchObject({
      action: "SEARCH",
      status: "NO_ANSWER",
      noAnswer,
      result: { hits: [], noAnswer },
    });
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
