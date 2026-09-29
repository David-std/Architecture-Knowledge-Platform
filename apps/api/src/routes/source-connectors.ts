import {
  createHash,
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify,
} from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  appendProviderSourceConnectorEvent,
  appendSourceConnectorEvent,
  registerSourceConnector,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import { actorOf, audit, requirePermission, type Permission } from "../auth.js";

const UUID = z.string().uuid();
const CONNECTOR_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WEBHOOK_MAX_BYTES = 1_500_000;
const WEBHOOK_MAX_SKEW_SECONDS = 300;

const Descriptor = z
  .object({
    schemaVersion: z.literal(1),
    sourceSystem: z.string().trim().min(1).max(120),
    objectTypes: z.array(z.string().trim().min(1).max(120)).min(1).max(100),
    incremental: z
      .object({
        cursor: z.boolean(),
        webhook: z.literal(true),
      })
      .strict(),
    permissionFidelity: z.enum([
      "SOURCE_ACL_EXACT",
      "SOURCE_ACL_MAPPED",
      "WORKSPACE_WIDE",
      "NONE",
      "UNKNOWN",
    ]),
    replication: z.enum(["FULL_MIRROR", "METADATA_ONLY", "REFERENCE"]),
    dataResidency: z.enum(["LOCAL", "ORG", "EXTERNAL"]),
    attachments: z
      .object({
        supported: z.boolean(),
        maxBytes: z.number().int().positive().max(100_000_000).optional(),
      })
      .strict(),
    rateLimit: z.union([
      z.object({ kind: z.literal("NONE") }).strict(),
      z
        .object({
          kind: z.literal("DECLARED"),
          requestsPerMinute: z.number().int().positive().max(100_000),
          burst: z.number().int().positive().max(100_000).optional(),
        })
        .strict(),
    ]),
    checkpointModel: z.literal("SOURCE_SEQUENCE"),
    deletionPropagation: z.enum(["TOMBSTONE", "NONE"]),
    sourceVersioning: z.boolean(),
    freshnessSlaSeconds: z.number().int().positive().max(31_536_000).optional(),
    contentTrust: z.literal("UNTRUSTED_EXTERNAL"),
  })
  .strict();

export const SourceConnectorRegistrationSchema = z
  .object({
    spaceId: UUID,
    vaultId: UUID,
    connectorKey: z.string().regex(CONNECTOR_KEY),
    publicKeyPem: z.string().min(32).max(8192),
    descriptor: Descriptor,
  })
  .strict();

const RegistrationBody = SourceConnectorRegistrationSchema;

export const ProviderSourceConnectorRegistrationSchema = z
  .object({
    spaceId: UUID,
    vaultId: UUID,
    connectorKey: z.string().regex(CONNECTOR_KEY),
    provider: z.enum(["jira", "linear"]),
    credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/),
    webhookSecretRef: z.string().regex(/^[A-Z][A-Z0-9_]{1,127}$/).optional(),
    baseUrl: z.string().url().max(2048).optional(),
    jql: z.string().trim().min(1).max(4000).optional(),
    authorizationScheme: z.enum(["RAW", "BASIC", "BEARER"]).optional(),
    freshnessSlaSeconds: z
      .number()
      .int()
      .positive()
      .max(31_536_000)
      .default(300),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.provider === "jira" && !value.baseUrl) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "Jira provider connectors require baseUrl.",
      });
    }
    if (value.baseUrl) {
      try {
        const url = new URL(value.baseUrl);
        const jiraCloud =
          value.provider === "jira" &&
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === "" &&
          url.pathname.replace(/\/+$/u, "") === "" &&
          url.hostname.toLowerCase().endsWith(".atlassian.net");
        const linearApi =
          value.provider === "linear" &&
          url.protocol === "https:" &&
          url.username === "" &&
          url.password === "" &&
          url.hostname.toLowerCase() === "api.linear.app" &&
          url.pathname.replace(/\/+$/u, "") === "/graphql";
        if (!jiraCloud && !linearApi) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["baseUrl"],
            message:
              "Provider endpoint is outside the fail-closed Jira Cloud/Linear allowlist.",
          });
        }
      } catch {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["baseUrl"],
          message: "Provider endpoint is invalid.",
        });
      }
    }
    if (value.provider === "jira" && value.authorizationScheme === "RAW") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizationScheme"],
        message: "Jira Cloud provider auth must be BASIC or BEARER.",
      });
    }
    if (value.provider === "linear" && value.authorizationScheme === "BASIC") {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["authorizationScheme"],
        message: "Linear provider auth must be RAW or BEARER.",
      });
    }
    if (value.provider === "linear" && value.jql) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["jql"],
        message: "JQL is only valid for Jira provider connectors.",
      });
    }
    if (value.provider === "jira" && /\border\s+by\b/iu.test(value.jql ?? "")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["jql"],
        message:
          "Jira provider JQL must not include ORDER BY; AKP appends deterministic ordering.",
      });
    }
  });

const ProviderRegistrationBody = ProviderSourceConnectorRegistrationSchema;

const WebhookBody = z
  .object({
    eventId: z.string().trim().min(1).max(200),
    sequence: z.number().int().positive(),
    occurredAt: z.string().datetime({ offset: true }),
    operation: z.enum(["UPSERT", "DELETE"]),
    object: z
      .object({
        id: z.string().trim().min(1).max(2048),
        type: z.string().trim().min(1).max(120),
        sourceVersion: z.string().trim().min(1).max(1024),
        title: z.string().max(1000).nullable().optional(),
        content: z.string().max(1_000_000).nullable().optional(),
        contentType: z.string().max(200).nullable().optional(),
        permissions: z
          .object({
            fidelity: z.enum([
              "SOURCE_ACL_EXACT",
              "SOURCE_ACL_MAPPED",
              "WORKSPACE_WIDE",
              "NONE",
            ]),
            uncertain: z.boolean(),
            aclFingerprint: z.string().max(1024).nullable().optional(),
          })
          .strict(),
        metadata: z.record(z.unknown()).default({}),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === "DELETE" && value.object.content != null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["object", "content"],
        message: "DELETE events cannot carry content.",
      });
    }
  });

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function headerValue(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const providerWebhookRawBodies = new WeakMap<FastifyRequest, Buffer>();

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function millisecondsTimestamp(value: unknown): string | null {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number)) return null;
  const date = new Date(number);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function hmacSha256Matches(
  rawBody: Buffer,
  secret: string,
  signatureHex: string,
): boolean {
  if (!/^[a-f0-9]{64}$/iu.test(signatureHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(signatureHex, "hex");
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export function verifyProviderWebhookSignature(input: {
  provider: "jira" | "linear";
  secret: string;
  rawBody: Buffer;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  body: unknown;
  nowMs?: number;
}): { accepted: boolean; eventId?: string; reason?: string } {
  const headers = input.headers;
  const readHeader = (name: string): string | null => {
    const value = headers[name] ?? headers[name.toLowerCase()];
    const first = Array.isArray(value) ? value[0] : value;
    return typeof first === "string" && first.trim() ? first.trim() : null;
  };

  if (input.provider === "linear") {
    const signature = readHeader("linear-signature");
    const delivery = readHeader("linear-delivery");
    const body = objectValue(input.body);
    const timestamp =
      millisecondsTimestamp(body.webhookTimestamp) ??
      millisecondsTimestamp(readHeader("linear-timestamp"));
    if (!signature || !delivery || !timestamp) {
      return { accepted: false, reason: "LINEAR_WEBHOOK_AUTH_REQUIRED" };
    }
    const nowMs = input.nowMs ?? Date.now();
    if (Math.abs(nowMs - new Date(timestamp).getTime()) > 60_000) {
      return { accepted: false, reason: "LINEAR_WEBHOOK_TIMESTAMP_INVALID" };
    }
    if (!hmacSha256Matches(input.rawBody, input.secret, signature)) {
      return { accepted: false, reason: "LINEAR_WEBHOOK_SIGNATURE_INVALID" };
    }
    return { accepted: true, eventId: delivery };
  }

  const signature = readHeader("x-hub-signature");
  const delivery = readHeader("x-atlassian-webhook-identifier");
  if (!signature || !delivery) {
    return { accepted: false, reason: "JIRA_WEBHOOK_AUTH_REQUIRED" };
  }
  const match = /^sha256=([a-f0-9]{64})$/iu.exec(signature);
  if (!match || !hmacSha256Matches(input.rawBody, input.secret, match[1]!)) {
    return { accepted: false, reason: "JIRA_WEBHOOK_SIGNATURE_INVALID" };
  }
  return { accepted: true, eventId: delivery };
}

export function providerWebhookEvent(input: {
  provider: "jira" | "linear";
  eventId: string;
  body: unknown;
  baseUrl?: string;
}): Omit<
  Parameters<typeof appendProviderSourceConnectorEvent>[1],
  "connectorId" | "payloadHash"
> {
  const body = objectValue(input.body);
  if (input.provider === "jira") {
    const issue = objectValue(body.issue);
    const fields = objectValue(issue.fields);
    const project = objectValue(fields.project);
    const security = objectValue(fields.security);
    const assignee = objectValue(fields.assignee);
    const status = objectValue(fields.status);
    const objectId = textValue(issue.id) ?? textValue(issue.key);
    const key = textValue(issue.key) ?? objectId;
    const eventType = textValue(body.webhookEvent) ?? "";
    const operation: "UPSERT" | "DELETE" = /_deleted$/iu.test(eventType)
      ? "DELETE"
      : "UPSERT";
    const occurredAt =
      millisecondsTimestamp(body.timestamp) ?? new Date().toISOString();
    const sourceVersion = textValue(fields.updated) ?? occurredAt;
    if (!objectId || !key) throw new Error("JIRA_WEBHOOK_ISSUE_IDENTITY_INVALID");
    const aclFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          projectId: textValue(project.id),
          securityId: textValue(security.id),
        }),
      )
      .digest("hex");
    return {
      eventId: input.eventId,
      occurredAt,
      operation,
      objectId,
      objectType: "ISSUE",
      sourceVersion,
      title: textValue(fields.summary),
      content: null,
      contentType: null,
      permissionFidelity: "SOURCE_ACL_MAPPED",
      permissionUncertain: true,
      aclFingerprint,
      metadata: {
        provider: "jira",
        providerVerified: true,
        key,
        canonicalUrl: input.baseUrl
          ? `${input.baseUrl.replace(/\/$/u, "")}/browse/${encodeURIComponent(key)}`
          : null,
        updatedAt: sourceVersion,
        status: textValue(status.name),
        projectId: textValue(project.id),
        assigneeAccountId: textValue(assignee.accountId),
        webhookEvent: eventType || null,
        aclBasis: "API_VISIBILITY_PLUS_PROJECT_SECURITY_HINTS",
        _akpProviderObservation: {
          providerVerified: true,
          observedVia: "AUTHENTICATED_PROVIDER_WEBHOOK",
          sourceVersion,
        },
      },
    };
  }

  const data = objectValue(body.data);
  const action = (textValue(body.action) ?? "").toLocaleLowerCase("en-US");
  const operation: "UPSERT" | "DELETE" =
    action === "remove" || action === "delete" ? "DELETE" : "UPSERT";
  const objectId = textValue(data.id);
  const identifier = textValue(data.identifier) ?? objectId;
  const team = objectValue(data.team);
  const state = objectValue(data.state);
  const assignee = objectValue(data.assignee);
  const occurredAt =
    millisecondsTimestamp(body.webhookTimestamp) ??
    textValue(body.createdAt) ??
    new Date().toISOString();
  const sourceVersion =
    textValue(data.updatedAt) ?? textValue(body.createdAt) ?? occurredAt;
  if (!objectId || !identifier) {
    throw new Error("LINEAR_WEBHOOK_ISSUE_IDENTITY_INVALID");
  }
  const aclFingerprint = createHash("sha256")
    .update(JSON.stringify({ teamId: textValue(team.id) }))
    .digest("hex");
  return {
    eventId: input.eventId,
    occurredAt,
    operation,
    objectId,
    objectType: "ISSUE",
    sourceVersion,
    title: textValue(data.title),
    content: null,
    contentType: null,
    permissionFidelity: "SOURCE_ACL_MAPPED",
    permissionUncertain: true,
    aclFingerprint,
    metadata: {
      provider: "linear",
      providerVerified: true,
      identifier,
      canonicalUrl: textValue(data.url),
      updatedAt: sourceVersion,
      teamId: textValue(team.id),
      teamKey: textValue(team.key),
      status: textValue(state.name),
      assigneeId: textValue(assignee.id),
      webhookAction: action || null,
      aclBasis: "API_VISIBILITY_PLUS_TEAM_SCOPE_HINTS",
      _akpProviderObservation: {
        providerVerified: true,
        observedVia: "AUTHENTICATED_PROVIDER_WEBHOOK",
        sourceVersion,
      },
    },
  };
}

async function captureProviderWebhookRawBody(
  request: FastifyRequest,
  payload: NodeJS.ReadableStream,
): Promise<Readable> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of payload) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > WEBHOOK_MAX_BYTES) {
      const error = new Error("PROVIDER_WEBHOOK_TOO_LARGE") as Error & {
        statusCode?: number;
      };
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks);
  providerWebhookRawBodies.set(request, raw);
  return Readable.from([raw]);
}

export function sourceConnectorWebhookMessage(
  connectorId: string,
  timestamp: string,
  body: unknown,
): Buffer {
  const bodyHash = createHash("sha256")
    .update(canonicalJson(body))
    .digest("hex");
  return Buffer.from(
    `AKP-SOURCE-WEBHOOK-V1\n${connectorId}\n${timestamp}\n${bodyHash}`,
    "utf8",
  );
}

export function verifySourceConnectorWebhookSignature(input: {
  connectorId: string;
  timestamp: string;
  signature: string;
  publicKeyPem: string;
  body: unknown;
  nowMs?: number;
}): boolean {
  if (!/^\d{10}$/.test(input.timestamp)) return false;
  const timestampMs = Number(input.timestamp) * 1000;
  const nowMs = input.nowMs ?? Date.now();
  if (
    !Number.isFinite(timestampMs) ||
    Math.abs(nowMs - timestampMs) > WEBHOOK_MAX_SKEW_SECONDS * 1000
  ) {
    return false;
  }

  let signature: Buffer;
  let publicKey: ReturnType<typeof createPublicKey>;
  try {
    signature = Buffer.from(input.signature, "base64");
    publicKey = createPublicKey(input.publicKeyPem);
  } catch {
    return false;
  }
  if (publicKey.asymmetricKeyType !== "ed25519" || signature.length !== 64) {
    return false;
  }
  const message = sourceConnectorWebhookMessage(
    input.connectorId,
    input.timestamp,
    input.body,
  );
  return verify(null, message, publicKey, signature);
}

function validEd25519PublicKey(publicKeyPem: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

async function requireWholeVault(
  db: Postgres,
  request: FastifyRequest,
  reply: FastifyReply,
  permission: Permission,
  spaceId: string,
  vaultId: string,
): Promise<boolean> {
  const actor = actorOf(request);
  if (!actor) {
    await reply.code(401).send({ code: "AUTH_REQUIRED" });
    return false;
  }
  try {
    const scope = await resolveAuthorizedVaultScope(db, {
      userId: actor.id,
      spaceId,
      permission,
      vaultId,
      vaultIds: [vaultId],
      federated: false,
    });
    if (
      scope.vaultIds.length !== 1 ||
      scope.vaultIds[0] !== vaultId ||
      scope.accessByVault[vaultId]?.pathPrefix !== null
    ) {
      await reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
      return false;
    }
    return true;
  } catch {
    await reply.code(403).send({ code: "VAULT_ACCESS_DENIED" });
    return false;
  }
}

export function registerSourceConnectorRoutes(
  app: FastifyInstance,
  db: Postgres,
): void {
  app.post(
    "/v1/source-connectors",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const parsed = RegistrationBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_SOURCE_CONNECTOR",
          issues: parsed.error.issues,
        });
      }
      if (
        !(await requireWholeVault(
          db,
          request,
          reply,
          "admin",
          parsed.data.spaceId,
          parsed.data.vaultId,
        ))
      ) {
        return;
      }
      if (!validEd25519PublicKey(parsed.data.publicKeyPem)) {
        return reply
          .code(400)
          .send({ code: "SOURCE_CONNECTOR_ED25519_KEY_REQUIRED" });
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const connector = await registerSourceConnector(db, {
        spaceId: parsed.data.spaceId,
        vaultId: parsed.data.vaultId,
        connectorKey: parsed.data.connectorKey,
        sourceSystem: parsed.data.descriptor.sourceSystem,
        publicKeyPem: parsed.data.publicKeyPem,
        descriptor: parsed.data.descriptor,
        createdByUserId: actor.id,
        createdByPrincipalId: actor.principalId,
      });
      await audit(
        db,
        request,
        "source_connector.register",
        "source_connector",
        String(connector.id),
        {
          vaultId: parsed.data.vaultId,
          connectorKey: parsed.data.connectorKey,
          sourceSystem: parsed.data.descriptor.sourceSystem,
          permissionFidelity: parsed.data.descriptor.permissionFidelity,
        },
        parsed.data.spaceId,
      );
      return reply.code(201).send({
        id: connector.id,
        spaceId: connector.space_id,
        vaultId: connector.vault_id,
        connectorKey: connector.connector_key,
        sourceSystem: connector.source_system,
        descriptor: connector.descriptor,
        state: connector.state,
      });
    },
  );

  app.post(
    "/v1/source-connectors/providers",
    { preHandler: requirePermission("admin") },
    async (request, reply) => {
      const parsed = ProviderRegistrationBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_PROVIDER_SOURCE_CONNECTOR",
          issues: parsed.error.issues,
        });
      }
      if (
        !(await requireWholeVault(
          db,
          request,
          reply,
          "admin",
          parsed.data.spaceId,
          parsed.data.vaultId,
        ))
      ) {
        return;
      }
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });

      const descriptor = {
        schemaVersion: 1,
        sourceSystem: parsed.data.provider,
        objectTypes: ["ISSUE"],
        incremental: {
          cursor: true,
          webhook: Boolean(parsed.data.webhookSecretRef),
        },
        permissionFidelity: "SOURCE_ACL_MAPPED",
        replication: "REFERENCE",
        dataResidency: "EXTERNAL",
        attachments: { supported: false },
        rateLimit:
          parsed.data.provider === "linear"
            ? { kind: "DECLARED", requestsPerMinute: 40 }
            : { kind: "NONE" },
        checkpointModel: "OPAQUE_CURSOR",
        deletionPropagation: "NONE",
        sourceVersioning: true,
        freshnessSlaSeconds: parsed.data.freshnessSlaSeconds,
        contentTrust: "UNTRUSTED_EXTERNAL",
        writeBack: "NONE",
      };
      const providerConfig = {
        ...(parsed.data.baseUrl
          ? parsed.data.provider === "linear"
            ? { endpoint: parsed.data.baseUrl }
            : { baseUrl: parsed.data.baseUrl }
          : {}),
        ...(parsed.data.jql ? { jql: parsed.data.jql } : {}),
        ...(parsed.data.webhookSecretRef
          ? { webhookSecretRef: parsed.data.webhookSecretRef }
          : {}),
        authorizationScheme:
          parsed.data.authorizationScheme ??
          (parsed.data.provider === "jira" ? "BASIC" : "RAW"),
      };
      const connector = await registerSourceConnector(db, {
        spaceId: parsed.data.spaceId,
        vaultId: parsed.data.vaultId,
        connectorKey: parsed.data.connectorKey,
        sourceSystem: parsed.data.provider,
        publicKeyPem: null,
        connectorMode: "PROVIDER_PULL",
        credentialRef: parsed.data.credentialRef,
        providerConfig,
        descriptor,
        createdByUserId: actor.id,
        createdByPrincipalId: actor.principalId,
      });
      await audit(
        db,
        request,
        "source_connector.provider.register",
        "source_connector",
        String(connector.id),
        {
          vaultId: parsed.data.vaultId,
          connectorKey: parsed.data.connectorKey,
          provider: parsed.data.provider,
          credentialRef: parsed.data.credentialRef,
          webhookEnabled: Boolean(parsed.data.webhookSecretRef),
          writeBack: "NONE",
        },
        parsed.data.spaceId,
      );
      return reply.code(201).send({
        id: connector.id,
        spaceId: connector.space_id,
        vaultId: connector.vault_id,
        connectorKey: connector.connector_key,
        sourceSystem: connector.source_system,
        connectorMode: connector.connector_mode,
        descriptor: connector.descriptor,
        state: connector.state,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/hooks/source-connectors/:id/provider-events",
    {
      bodyLimit: WEBHOOK_MAX_BYTES,
      preParsing: async (request, _reply, payload) =>
        captureProviderWebhookRawBody(request, payload),
    },
    async (request, reply) => {
      if (!UUID.safeParse(request.params.id).success) {
        return reply.code(404).send({ code: "SOURCE_CONNECTOR_NOT_FOUND" });
      }
      const rawBody = providerWebhookRawBodies.get(request);
      providerWebhookRawBodies.delete(request);
      if (!rawBody) {
        return reply.code(400).send({ code: "PROVIDER_WEBHOOK_BODY_REQUIRED" });
      }
      const connector = await db.pool.query<{
        id: string;
        source_system: string;
        connector_mode: string;
        credential_ref: string | null;
        provider_config: Record<string, unknown>;
        state: string;
      }>(
        `select id,source_system,connector_mode,credential_ref,provider_config,state
           from source_connector_registrations
          where id=$1`,
        [request.params.id],
      );
      const row = connector.rows[0];
      if (
        !row ||
        row.state !== "ACTIVE" ||
        row.connector_mode !== "PROVIDER_PULL" ||
        (row.source_system !== "jira" && row.source_system !== "linear")
      ) {
        return reply.code(404).send({ code: "SOURCE_CONNECTOR_NOT_FOUND" });
      }
      const provider = row.source_system as "jira" | "linear";
      const config =
        row.provider_config &&
        typeof row.provider_config === "object" &&
        !Array.isArray(row.provider_config)
          ? row.provider_config
          : {};
      const secretRef = textValue(config.webhookSecretRef);
      const secret = secretRef ? process.env[secretRef]?.trim() : undefined;
      if (!secret) {
        return reply
          .code(401)
          .send({ code: "PROVIDER_WEBHOOK_SECRET_UNAVAILABLE" });
      }
      const verification = verifyProviderWebhookSignature({
        provider,
        secret,
        rawBody,
        headers: request.headers,
        body: request.body,
      });
      if (!verification.accepted || !verification.eventId) {
        return reply.code(401).send({
          code: verification.reason ?? "PROVIDER_WEBHOOK_SIGNATURE_INVALID",
        });
      }

      let event: Omit<
        Parameters<typeof appendProviderSourceConnectorEvent>[1],
        "connectorId" | "payloadHash"
      >;
      try {
        event = providerWebhookEvent({
          provider,
          eventId: verification.eventId,
          body: request.body,
          ...(provider === "jira" && textValue(config.baseUrl)
            ? { baseUrl: textValue(config.baseUrl)! }
            : {}),
        });
      } catch (error) {
        return reply.code(400).send({
          code:
            error instanceof Error
              ? error.message
              : "PROVIDER_WEBHOOK_PAYLOAD_INVALID",
        });
      }

      const receipt = await appendProviderSourceConnectorEvent(db, {
        connectorId: row.id,
        ...event,
        payloadHash: createHash("sha256").update(rawBody).digest("hex"),
      });
      return reply.code(receipt.duplicate ? 200 : 202).send({
        ...receipt,
        connectorId: row.id,
        provider,
      });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/hooks/source-connectors/:id/events",
    async (request, reply) => {
      if (!UUID.safeParse(request.params.id).success) {
        return reply.code(404).send({ code: "SOURCE_CONNECTOR_NOT_FOUND" });
      }
      const parsed = WebhookBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({
          code: "INVALID_SOURCE_CONNECTOR_EVENT",
          issues: parsed.error.issues,
        });
      }
      const serialized = canonicalJson(parsed.data);
      if (Buffer.byteLength(serialized, "utf8") > WEBHOOK_MAX_BYTES) {
        return reply
          .code(413)
          .send({ code: "SOURCE_CONNECTOR_EVENT_TOO_LARGE" });
      }
      const connector = await db.pool.query<{
        id: string;
        public_key_pem: string;
        state: string;
      }>(
        `select id,public_key_pem,state
           from source_connector_registrations
          where id=$1`,
        [request.params.id],
      );
      const row = connector.rows[0];
      if (!row || row.state !== "ACTIVE") {
        return reply.code(404).send({ code: "SOURCE_CONNECTOR_NOT_FOUND" });
      }
      const timestamp = headerValue(request, "x-akp-timestamp");
      const signature = headerValue(request, "x-akp-signature");
      if (
        !timestamp ||
        !signature ||
        !verifySourceConnectorWebhookSignature({
          connectorId: row.id,
          timestamp,
          signature,
          publicKeyPem: row.public_key_pem,
          body: parsed.data,
        })
      ) {
        return reply
          .code(401)
          .send({ code: "SOURCE_CONNECTOR_SIGNATURE_INVALID" });
      }

      const receipt = await appendSourceConnectorEvent(db, {
        connectorId: row.id,
        eventId: parsed.data.eventId,
        sequence: parsed.data.sequence,
        occurredAt: parsed.data.occurredAt,
        operation: parsed.data.operation,
        objectId: parsed.data.object.id,
        objectType: parsed.data.object.type,
        sourceVersion: parsed.data.object.sourceVersion,
        title: parsed.data.object.title ?? null,
        content:
          parsed.data.operation === "DELETE"
            ? null
            : (parsed.data.object.content ?? null),
        contentType: parsed.data.object.contentType ?? null,
        permissionFidelity: parsed.data.object.permissions.fidelity,
        permissionUncertain: parsed.data.object.permissions.uncertain,
        aclFingerprint: parsed.data.object.permissions.aclFingerprint ?? null,
        metadata: parsed.data.object.metadata,
        payloadHash: createHash("sha256").update(serialized).digest("hex"),
      });
      return reply.code(receipt.duplicate ? 200 : 202).send({
        ...receipt,
        connectorId: row.id,
      });
    },
  );
}
