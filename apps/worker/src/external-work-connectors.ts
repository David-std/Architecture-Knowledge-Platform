import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  SourceConnectorCheckpoint,
  SourceConnectorFetchInput,
  SourceConnectorObject,
  SourceConnectorPort,
  SourceConnectorPullInput,
  SourceConnectorScope,
  SourceConnectorWebhookRequest,
  SourceConnectorWebhookVerification,
} from "@akp/domain";

export type ProviderHealthState = "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";

export interface ProviderHealth {
  state: ProviderHealthState;
  observedAt: string;
  reason?: string;
}

type FetchLike = typeof fetch;

function isoCheckpoint(value = new Date()): SourceConnectorCheckpoint {
  return { kind: "OPAQUE_CURSOR", value: value.toISOString() };
}

function boundedLimit(value: number | undefined): number {
  return Math.max(1, Math.min(100, value ?? 50));
}

const PROVIDER_POLL_OVERLAP_MS = 5 * 60 * 1000;

function overlappedCheckpointValue(
  value: string | undefined,
  overlapMs = PROVIDER_POLL_OVERLAP_MS,
): string | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Date(parsed.getTime() - overlapMs).toISOString();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function header(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function jiraIssueToObject(
  issue: Record<string, unknown>,
  baseUrl: string,
): SourceConnectorObject {
  const fields = jsonObject(issue.fields);
  const project = jsonObject(fields.project);
  const security = jsonObject(fields.security);
  const assignee = jsonObject(fields.assignee);
  const status = jsonObject(fields.status);
  const id = stringValue(issue.id) ?? stringValue(issue.key);
  const key = stringValue(issue.key) ?? id;
  const updated = stringValue(fields.updated);
  if (!id || !key || !updated) throw new Error("JIRA_ISSUE_IDENTITY_INVALID");
  const aclFingerprint = sha256(
    JSON.stringify({
      projectId: stringValue(project.id) ?? null,
      securityId: stringValue(security.id) ?? null,
    }),
  );
  return {
    objectId: id,
    objectType: "ISSUE",
    sourceSystem: "jira",
    sourceVersion: updated,
    operation: "UPSERT",
    ...(stringValue(fields.summary)
      ? { title: stringValue(fields.summary)! }
      : {}),
    contentTrust: "UNTRUSTED_EXTERNAL",
    permissions: {
      fidelity: "SOURCE_ACL_MAPPED",
      uncertain: true,
      aclFingerprint,
    },
    attachments: [],
    metadata: {
      provider: "jira",
      providerVerified: true,
      key,
      canonicalUrl: `${baseUrl.replace(/\/$/u, "")}/browse/${encodeURIComponent(key)}`,
      updatedAt: updated,
      status: stringValue(status.name) ?? null,
      projectId: stringValue(project.id) ?? null,
      assigneeAccountId: stringValue(assignee.accountId) ?? null,
      aclBasis: "API_VISIBILITY_PLUS_PROJECT_SECURITY_HINTS",
    },
  };
}

export interface JiraCloudSourceConnectorOptions {
  baseUrl: string;
  authorizationHeader: string;
  jql?: string;
  fetchImpl?: FetchLike;
  webhookVerifier?: (
    request: SourceConnectorWebhookRequest,
  ) => Promise<boolean> | boolean;
  freshnessSlaSeconds?: number;
}

export class JiraCloudSourceConnector implements SourceConnectorPort {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: JiraCloudSourceConnectorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  describe() {
    return {
      schemaVersion: 1 as const,
      connectorId: "jira-cloud",
      sourceSystem: "jira",
      objectTypes: ["ISSUE"],
      incremental: { cursor: true, webhook: false },
      permissionFidelity: "SOURCE_ACL_MAPPED" as const,
      replication: "REFERENCE" as const,
      dataResidency: "EXTERNAL" as const,
      attachments: { supported: false },
      rateLimit: { kind: "NONE" as const },
      checkpointModel: "OPAQUE_CURSOR" as const,
      deletionPropagation: "NONE" as const,
      sourceVersioning: true,
      freshnessSlaSeconds: this.options.freshnessSlaSeconds ?? 300,
      contentTrust: "UNTRUSTED_EXTERNAL" as const,
    };
  }

  async checkpoint(
    _scope: SourceConnectorScope,
  ): Promise<SourceConnectorCheckpoint> {
    return isoCheckpoint();
  }

  async *pull(
    input: SourceConnectorPullInput,
  ): AsyncIterable<SourceConnectorObject> {
    const from = overlappedCheckpointValue(input.from?.value);
    const target = input.target.value;
    let nextPageToken: string | undefined;
    do {
      const clauses = [
        this.options.jql?.trim() ? `(${this.options.jql.trim()})` : "",
        from ? `updated > "${from.replace(/"/gu, '\\\"')}"` : "",
        `updated <= "${target.replace(/"/gu, '\\\"')}"`,
      ].filter(Boolean);
      const response = await this.request("/rest/api/3/search/jql", {
        method: "POST",
        body: JSON.stringify({
          jql: `${clauses.join(" AND ")} ORDER BY updated ASC, key ASC`,
          maxResults: boundedLimit(input.pageSize),
          ...(nextPageToken ? { nextPageToken } : {}),
          fields: [
            "summary",
            "updated",
            "status",
            "project",
            "security",
            "assignee",
          ],
        }),
      });
      const issues = Array.isArray(response.issues) ? response.issues : [];
      for (const issue of issues) {
        yield jiraIssueToObject(jsonObject(issue), this.options.baseUrl);
      }
      nextPageToken = stringValue(response.nextPageToken);
    } while (nextPageToken);
  }

  async fetchById(
    input: SourceConnectorFetchInput,
  ): Promise<SourceConnectorObject | null> {
    const response = await this.fetchImpl(
      `${this.options.baseUrl.replace(/\/$/u, "")}/rest/api/3/issue/${encodeURIComponent(input.objectId)}?fields=summary,updated,status,project,security,assignee`,
      {
        headers: {
          accept: "application/json",
          authorization: this.options.authorizationHeader,
        },
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`JIRA_HTTP_${response.status}`);
    return jiraIssueToObject(
      jsonObject(await response.json()),
      this.options.baseUrl,
    );
  }

  async verifyWebhook(
    request: SourceConnectorWebhookRequest,
  ): Promise<SourceConnectorWebhookVerification> {
    if (!this.options.webhookVerifier) {
      return { accepted: false, reason: "JIRA_WEBHOOK_VERIFIER_REQUIRED" };
    }
    const accepted = await this.options.webhookVerifier(request);
    if (!accepted)
      return { accepted: false, reason: "JIRA_WEBHOOK_SIGNATURE_INVALID" };
    const payload = jsonObject(
      JSON.parse(Buffer.from(request.rawBody).toString("utf8")),
    );
    const issue = jsonObject(payload.issue);
    const eventId =
      header(request.headers, "x-atlassian-webhook-identifier") ??
      stringValue(payload.webhookEvent) ??
      stringValue(issue.id);
    return {
      accepted: true,
      ...(eventId ? { eventId } : {}),
      checkpoint: isoCheckpoint(),
    };
  }

  async health(): Promise<ProviderHealth> {
    const observedAt = new Date().toISOString();
    try {
      await this.request("/rest/api/3/myself", { method: "GET" });
      return { state: "AVAILABLE", observedAt };
    } catch (error) {
      return {
        state: "UNAVAILABLE",
        observedAt,
        reason: error instanceof Error ? error.message : "JIRA_UNAVAILABLE",
      };
    }
  }

  private async request(
    path: string,
    init: RequestInit,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(
      `${this.options.baseUrl.replace(/\/$/u, "")}${path}`,
      {
        ...init,
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          authorization: this.options.authorizationHeader,
          ...(init.headers ?? {}),
        },
      },
    );
    if (!response.ok) throw new Error(`JIRA_HTTP_${response.status}`);
    return jsonObject(await response.json());
  }
}

function linearIssueToObject(
  issue: Record<string, unknown>,
): SourceConnectorObject {
  const id = stringValue(issue.id);
  const identifier = stringValue(issue.identifier);
  const updatedAt = stringValue(issue.updatedAt);
  if (!id || !identifier || !updatedAt) {
    throw new Error("LINEAR_ISSUE_IDENTITY_INVALID");
  }
  const team = jsonObject(issue.team);
  const state = jsonObject(issue.state);
  const assignee = jsonObject(issue.assignee);
  const aclFingerprint = sha256(
    JSON.stringify({ teamId: stringValue(team.id) ?? null }),
  );
  return {
    objectId: id,
    objectType: "ISSUE",
    sourceSystem: "linear",
    sourceVersion: updatedAt,
    operation: "UPSERT",
    ...(stringValue(issue.title) ? { title: stringValue(issue.title)! } : {}),
    contentTrust: "UNTRUSTED_EXTERNAL",
    permissions: {
      fidelity: "SOURCE_ACL_MAPPED",
      uncertain: true,
      aclFingerprint,
    },
    attachments: [],
    metadata: {
      provider: "linear",
      providerVerified: true,
      identifier,
      canonicalUrl: stringValue(issue.url) ?? null,
      updatedAt,
      teamId: stringValue(team.id) ?? null,
      teamKey: stringValue(team.key) ?? null,
      status: stringValue(state.name) ?? null,
      assigneeId: stringValue(assignee.id) ?? null,
      aclBasis: "API_VISIBILITY_PLUS_TEAM_SCOPE_HINTS",
    },
  };
}

export interface LinearSourceConnectorOptions {
  authorizationHeader: string;
  endpoint?: string;
  webhookSecret?: string;
  fetchImpl?: FetchLike;
  freshnessSlaSeconds?: number;
  now?: () => number;
}

export class LinearSourceConnector implements SourceConnectorPort {
  private readonly fetchImpl: FetchLike;
  private readonly endpoint: string;

  constructor(private readonly options: LinearSourceConnectorOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.endpoint = options.endpoint ?? "https://api.linear.app/graphql";
  }

  describe() {
    return {
      schemaVersion: 1 as const,
      connectorId: "linear",
      sourceSystem: "linear",
      objectTypes: ["ISSUE"],
      incremental: { cursor: true, webhook: false },
      permissionFidelity: "SOURCE_ACL_MAPPED" as const,
      replication: "REFERENCE" as const,
      dataResidency: "EXTERNAL" as const,
      attachments: { supported: false },
      rateLimit: { kind: "NONE" as const },
      checkpointModel: "OPAQUE_CURSOR" as const,
      deletionPropagation: "NONE" as const,
      sourceVersioning: true,
      freshnessSlaSeconds: this.options.freshnessSlaSeconds ?? 300,
      contentTrust: "UNTRUSTED_EXTERNAL" as const,
    };
  }

  async checkpoint(
    _scope: SourceConnectorScope,
  ): Promise<SourceConnectorCheckpoint> {
    return isoCheckpoint();
  }

  async *pull(
    input: SourceConnectorPullInput,
  ): AsyncIterable<SourceConnectorObject> {
    let after: string | null = null;
    const from = overlappedCheckpointValue(input.from?.value);
    do {
      const data = await this.graphql(
        `query Issues($first:Int!,$after:String,$from:DateTimeOrDuration,$target:DateTimeOrDuration){
          issues(
            first:$first,
            after:$after,
            orderBy:updatedAt,
            filter:{updatedAt:{gt:$from,lte:$target}}
          ){
            nodes{
              id identifier title updatedAt url
              team{id key}
              state{name}
              assignee{id}
            }
            pageInfo{hasNextPage endCursor}
          }
        }`,
        {
          first: boundedLimit(input.pageSize),
          after,
          from: from ?? null,
          target: input.target.value,
        },
      );
      const issues = jsonObject(data.issues);
      const nodes = Array.isArray(issues.nodes) ? issues.nodes : [];
      for (const issue of nodes) yield linearIssueToObject(jsonObject(issue));
      const pageInfo = jsonObject(issues.pageInfo);
      after =
        pageInfo.hasNextPage === true
          ? (stringValue(pageInfo.endCursor) ?? null)
          : null;
    } while (after);
  }

  async fetchById(
    input: SourceConnectorFetchInput,
  ): Promise<SourceConnectorObject | null> {
    const data = await this.graphql(
      `query Issue($id:String!){
        issue(id:$id){
          id identifier title updatedAt url
          team{id key}
          state{name}
          assignee{id}
        }
      }`,
      { id: input.objectId },
    );
    if (!data.issue) return null;
    return linearIssueToObject(jsonObject(data.issue));
  }

  async verifyWebhook(
    request: SourceConnectorWebhookRequest,
  ): Promise<SourceConnectorWebhookVerification> {
    const secret = this.options.webhookSecret;
    if (!secret)
      return { accepted: false, reason: "LINEAR_WEBHOOK_SECRET_REQUIRED" };
    const signature = header(request.headers, "linear-signature");
    if (!signature || !/^[a-f0-9]{64}$/iu.test(signature)) {
      return { accepted: false, reason: "LINEAR_WEBHOOK_SIGNATURE_INVALID" };
    }
    const computed = createHmac("sha256", secret)
      .update(request.rawBody)
      .digest();
    const supplied = Buffer.from(signature, "hex");
    if (
      supplied.length !== computed.length ||
      !timingSafeEqual(supplied, computed)
    ) {
      return { accepted: false, reason: "LINEAR_WEBHOOK_SIGNATURE_INVALID" };
    }
    const payload = jsonObject(
      JSON.parse(Buffer.from(request.rawBody).toString("utf8")),
    );
    const webhookTimestamp = Number(payload.webhookTimestamp);
    const now = this.options.now?.() ?? Date.now();
    if (
      !Number.isFinite(webhookTimestamp) ||
      Math.abs(now - webhookTimestamp) > 60_000
    ) {
      return { accepted: false, reason: "LINEAR_WEBHOOK_TIMESTAMP_INVALID" };
    }
    const eventId =
      header(request.headers, "linear-delivery") ??
      stringValue(payload.id) ??
      stringValue(jsonObject(payload.data).id);
    return {
      accepted: true,
      ...(eventId ? { eventId } : {}),
      checkpoint: isoCheckpoint(new Date(webhookTimestamp)),
    };
  }

  async health(): Promise<ProviderHealth> {
    const observedAt = new Date().toISOString();
    try {
      await this.graphql("query Viewer { viewer { id } }", {});
      return { state: "AVAILABLE", observedAt };
    } catch (error) {
      return {
        state: "UNAVAILABLE",
        observedAt,
        reason: error instanceof Error ? error.message : "LINEAR_UNAVAILABLE",
      };
    }
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: this.options.authorizationHeader,
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`LINEAR_HTTP_${response.status}`);
    const payload = jsonObject(await response.json());
    if (Array.isArray(payload.errors) && payload.errors.length > 0) {
      const code = stringValue(jsonObject(payload.errors[0]).message);
      throw new Error(code ? `LINEAR_GRAPHQL_${code}` : "LINEAR_GRAPHQL_ERROR");
    }
    return jsonObject(payload.data);
  }
}
