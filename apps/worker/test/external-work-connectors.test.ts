import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  JiraCloudSourceConnector,
  LinearSourceConnector,
} from "../src/external-work-connectors.js";

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of iterable) values.push(value);
  return values;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("external work source connectors", () => {
  it("maps Jira issues as read-only verified provider references with mapped ACL provenance", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(String(body.jql)).toContain("updated >");
        expect(String(body.jql)).toContain("updated <=");
        return jsonResponse({
          issues: [
            {
              id: "10001",
              key: "ARCH-42",
              fields: {
                summary: "Bound provider issue",
                updated: "2026-09-28T05:00:00.000+0000",
                status: { name: "In Progress" },
                project: { id: "10000" },
                security: { id: "7" },
                assignee: { accountId: "acct-1" },
              },
            },
          ],
        });
      },
    );
    const connector = new JiraCloudSourceConnector({
      baseUrl: "https://example.atlassian.net",
      authorizationHeader: "Bearer test-only",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(connector.describe()).toMatchObject({
      sourceSystem: "jira",
      replication: "REFERENCE",
      permissionFidelity: "SOURCE_ACL_MAPPED",
      deletionPropagation: "NONE",
      incremental: { cursor: true, webhook: false },
    });

    const objects = await collect(
      connector.pull({
        scope: {},
        from: { kind: "OPAQUE_CURSOR", value: "2026-09-27T00:00:00.000Z" },
        target: { kind: "OPAQUE_CURSOR", value: "2026-09-28T06:00:00.000Z" },
        pageSize: 25,
      }),
    );

    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({
      objectId: "10001",
      sourceSystem: "jira",
      sourceVersion: "2026-09-28T05:00:00.000+0000",
      operation: "UPSERT",
      contentTrust: "UNTRUSTED_EXTERNAL",
      permissions: {
        fidelity: "SOURCE_ACL_MAPPED",
        uncertain: true,
      },
      metadata: {
        provider: "jira",
        providerVerified: true,
        key: "ARCH-42",
        status: "In Progress",
        aclBasis: "API_VISIBILITY_PLUS_PROJECT_SECURITY_HINTS",
      },
    });
  });

  it("fails Jira webhook verification closed unless a deployment verifier is supplied", async () => {
    const request = {
      rawBody: new TextEncoder().encode(
        JSON.stringify({
          webhookEvent: "jira:issue_updated",
          issue: { id: "10001" },
        }),
      ),
      headers: {},
    };
    const connector = new JiraCloudSourceConnector({
      baseUrl: "https://example.atlassian.net",
      authorizationHeader: "Bearer test-only",
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    await expect(connector.verifyWebhook(request)).resolves.toEqual({
      accepted: false,
      reason: "JIRA_WEBHOOK_VERIFIER_REQUIRED",
    });

    const verified = new JiraCloudSourceConnector({
      baseUrl: "https://example.atlassian.net",
      authorizationHeader: "Bearer test-only",
      fetchImpl: vi.fn() as unknown as typeof fetch,
      webhookVerifier: () => true,
    });
    await expect(verified.verifyWebhook(request)).resolves.toMatchObject({
      accepted: true,
      eventId: "jira:issue_updated",
    });
  });

  it("maps Linear GraphQL issues and advances cursor pagination without write-back", async () => {
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as {
          variables: { after: string | null };
        };
        if (body.variables.after === null) {
          return jsonResponse({
            data: {
              issues: {
                nodes: [
                  {
                    id: "lin-1",
                    identifier: "ENG-7",
                    title: "Bound Linear issue",
                    updatedAt: "2026-09-28T05:30:00.000Z",
                    url: "https://linear.app/example/issue/ENG-7",
                    team: { id: "team-1", key: "ENG" },
                    state: { name: "Started" },
                    assignee: { id: "user-1" },
                  },
                ],
                pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
              },
            },
          });
        }
        return jsonResponse({
          data: {
            issues: {
              nodes: [],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        });
      },
    );
    const connector = new LinearSourceConnector({
      authorizationHeader: "test-only-key",
      endpoint: "https://linear.invalid/graphql",
      fetchImpl: fetchImpl as typeof fetch,
    });

    const objects = await collect(
      connector.pull({
        scope: {},
        target: { kind: "OPAQUE_CURSOR", value: "2026-09-28T06:00:00.000Z" },
        pageSize: 50,
      }),
    );

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(objects).toHaveLength(1);
    expect(objects[0]).toMatchObject({
      objectId: "lin-1",
      sourceSystem: "linear",
      sourceVersion: "2026-09-28T05:30:00.000Z",
      operation: "UPSERT",
      permissions: {
        fidelity: "SOURCE_ACL_MAPPED",
        uncertain: true,
      },
      metadata: {
        provider: "linear",
        providerVerified: true,
        identifier: "ENG-7",
        teamKey: "ENG",
        status: "Started",
        aclBasis: "API_VISIBILITY_PLUS_TEAM_SCOPE_HINTS",
      },
    });
    expect(connector.describe()).toMatchObject({
      replication: "REFERENCE",
      dataResidency: "EXTERNAL",
      deletionPropagation: "NONE",
      incremental: { cursor: true, webhook: false },
    });
  });

  it("verifies Linear webhook HMAC and freshness before accepting provider events", async () => {
    const secret = "linear-test-secret";
    const now = Date.parse("2026-09-28T06:00:00.000Z");
    const payload = JSON.stringify({
      id: "delivery-1",
      webhookTimestamp: now,
      data: { id: "lin-1" },
    });
    const signature = createHmac("sha256", secret)
      .update(payload)
      .digest("hex");
    const connector = new LinearSourceConnector({
      authorizationHeader: "test-only-key",
      webhookSecret: secret,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      now: () => now,
    });

    await expect(
      connector.verifyWebhook({
        rawBody: new TextEncoder().encode(payload),
        headers: { "linear-signature": signature },
      }),
    ).resolves.toMatchObject({
      accepted: true,
      eventId: "delivery-1",
    });

    const stalePayload = JSON.stringify({
      id: "delivery-2",
      webhookTimestamp: now - 120_000,
      data: { id: "lin-2" },
    });
    const staleSignature = createHmac("sha256", secret)
      .update(stalePayload)
      .digest("hex");
    await expect(
      connector.verifyWebhook({
        rawBody: new TextEncoder().encode(stalePayload),
        headers: { "linear-signature": staleSignature },
      }),
    ).resolves.toEqual({
      accepted: false,
      reason: "LINEAR_WEBHOOK_TIMESTAMP_INVALID",
    });
  });
});
