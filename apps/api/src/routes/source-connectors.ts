import { createHash, createPublicKey, verify } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  appendSourceConnectorEvent,
  registerSourceConnector,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import {
  actorOf,
  audit,
  requirePermission,
  type Permission,
} from "../auth.js";

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
    deletionPropagation: z.enum(["TOMBSTONE", "NONE"]),
    sourceVersioning: z.boolean(),
    freshnessSlaSeconds: z.number().int().positive().max(31_536_000).optional(),
    contentTrust: z.literal("UNTRUSTED_EXTERNAL"),
  })
  .strict();

const RegistrationBody = z
  .object({
    spaceId: UUID,
    vaultId: UUID,
    connectorKey: z.string().regex(CONNECTOR_KEY),
    publicKeyPem: z.string().min(32).max(8192),
    descriptor: Descriptor,
  })
  .strict();

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

function headerValue(
  request: FastifyRequest,
  name: string,
): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : null;
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
        aclFingerprint:
          parsed.data.object.permissions.aclFingerprint ?? null,
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
