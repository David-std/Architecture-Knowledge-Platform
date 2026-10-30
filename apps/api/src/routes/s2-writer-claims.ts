import type { FastifyInstance } from "fastify";
import type { Postgres } from "@akp/postgres";
import {
  LayeredEvidenceAdmissionPipeline,
  type GovernedLayeredPropositionPort,
} from "@akp/retrieval";
import { z } from "zod";
import { actorOf, requirePermission } from "../auth.js";
import { resolveS2WriterContext } from "../s2-writer-context.js";
import { auditReviewedS2Statements } from "../s2-writer-audit-core.js";

const uuid = z.string().uuid();
const WriterStatement = z
  .object({
    text: z.string().min(1).max(4096),
    startUtf16: z.number().int().nonnegative().max(4096),
    endUtf16: z.number().int().positive().max(4096),
    citationId: z.string().regex(/^SEC(?:[1-9]|1[0-6])$/u),
  })
  .strict();
const WriterAuditRequest = z
  .object({
    packetId: uuid,
    packetHash: z.string().min(1).max(256),
    answerText: z.string().min(1).max(4096),
    statements: z.array(WriterStatement).min(1).max(16),
  })
  .strict();

const semanticReaderDisabled = {
  id: "s2:reviewed-structured-only",
  async read() {
    return {
      layer: "SEMANTIC_READER" as const,
      verdict: { kind: "INSUFFICIENT" as const },
      reason: "S2_UNREVIEWED_SEMANTIC_READER_NOT_TRUTH_AUTHORITY",
      readerId: "s2:reviewed-structured-only",
    };
  },
};

/**
 * Inspect an existing HTTP Writer output against a persisted ContextPacket.
 * This endpoint neither generates Writer prose nor authorizes publication.
 * Every cited source is frozen server-side, rescoped to the current caller,
 * and verified against original SHA-pinned SOURCE+two-person projections.
 */
export function registerS2ReviewedWriterAuditRoutes(
  app: FastifyInstance,
  db: Postgres,
  trustedPort: GovernedLayeredPropositionPort,
): void {
  const pipeline = new LayeredEvidenceAdmissionPipeline({
    semanticReader: semanticReaderDisabled,
    structuredMismatchPolicy: "ABSTAIN",
  });
  app.post(
    "/v1/s2/writer-claims/audit",
    {
      preHandler: requirePermission("eval:run"),
    },
    async (request, reply) => {
      const parsed = WriterAuditRequest.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send({ code: "S2_WRITER_AUDIT_INVALID" });
      const actor = actorOf(request);
      if (!actor) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const input = parsed.data;
      const authorized = await resolveS2WriterContext({
        db,
        principal: actor,
        packetId: input.packetId,
        packetHash: input.packetHash,
        trustedPort,
      });
      if (!authorized.ok)
        return reply.code(authorized.status).send({ code: authorized.code });
      const { packet, port } = authorized;
      const sourceMap = new Map<string, (typeof packet.sections)[number]>(
        packet.sections.map(
          (section, index) => [`SEC${index + 1}`, section] as const,
        ),
      );
      if (input.statements.some((s) => !sourceMap.has(s.citationId)))
        return reply
          .code(400)
          .send({ code: "S2_WRITER_CITATION_NOT_IN_CONTEXT" });
      // Resolve the actual Writer statement text using a distinct reviewed
      // projection. Client statement projections are not accepted as input.
      const audit = await auditReviewedS2Statements({
        packet,
        answerText: input.answerText,
        statements: input.statements,
        trustedPort: port,
        admissionPipeline: pipeline,
      });
      // Raw source, question, Writer text, reviewer identities, and gold labels
      // never cross the evaluation API. It reports an audit CANDIDATE only.
      reply.header("Cache-Control", "no-store");
      return {
        ...audit,
        packetId: packet.packetId,
        status: audit.status,
        fullAuthenticatedWriterRoundTripIndependentlyVerified: false,
      };
    },
  );
}
