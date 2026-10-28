import type { FastifyInstance } from "fastify";
import {
  ContextPacket as ContextPacketSchema,
  type SearchHit,
} from "@akp/contracts";
import {
  pathMatchesVaultPrefix,
  resolveAuthorizedVaultScope,
  type Postgres,
} from "@akp/postgres";
import {
  LayeredEvidenceAdmissionPipeline,
  auditGovernedWriterStatements,
  retrievalAnswerabilityCandidateKey,
  type GovernedLayeredPropositionPort,
  type GovernedWriterStatement,
} from "@akp/retrieval";
import { z } from "zod";
import { actorOf, hasSpaceAccess, requirePermission } from "../auth.js";

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

interface StoredPacket {
  id: string;
  space_id: string;
  packet_hash: string;
  packet: unknown;
}
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

function hitFromFrozenSection(
  section: z.infer<typeof ContextPacketSchema>["sections"][number],
): SearchHit {
  return {
    documentId: section.documentId,
    vaultId: section.vaultId,
    ...(section.unitId ? { unitId: section.unitId } : {}),
    ...(section.unitType
      ? { unitType: section.unitType as SearchHit["unitType"] }
      : {}),
    document: section.document,
    revision: section.documentRevision,
    title: section.title,
    type: section.kind,
    // These are never evidence authority. The reviewed port independently
    // verifies the actual document lifecycle and current raw SOURCE revision.
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 0,
    reasons: ["s2:reviewed-http-writer-audit"],
    excerpt: section.content,
    citations: [],
  };
}

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
      const result = await db.pool.query<StoredPacket>(
        `select id,space_id,packet_hash,packet
         from context_packets
        where id=$1 and actor_id=$2
          and (expires_at is null or expires_at>now())
        limit 1`,
        [input.packetId, actor.id],
      );
      const row = result.rows[0];
      if (!row || row.packet_hash !== input.packetHash)
        return reply.code(404).send({ code: "S2_FROZEN_CONTEXT_NOT_FOUND" });
      const packetParsed = ContextPacketSchema.safeParse(row.packet);
      if (!packetParsed.success)
        return reply.code(409).send({ code: "S2_CONTEXT_PACKET_INVALID" });
      const packet = packetParsed.data;
      if (
        packet.packetId !== row.id ||
        packet.packetHash !== row.packet_hash ||
        packet.scope.spaceId !== row.space_id ||
        packet.sections.length > 16 ||
        packet.query.length < 1 ||
        packet.query.length > 4096 ||
        !hasSpaceAccess(actor, row.space_id, "eval:run") ||
        !hasSpaceAccess(actor, row.space_id, "source:read")
      )
        return reply.code(403).send({ code: "S2_WRITER_SCOPE_DENIED" });
      // The Writer may cite only sections from the exact persisted packet.
      const sourceMap = new Map<string, (typeof packet.sections)[number]>(
        packet.sections.map(
          (section, index) => [`SEC${index + 1}`, section] as const,
        ),
      );
      if (input.statements.some((s) => !sourceMap.has(s.citationId)))
        return reply
          .code(400)
          .send({ code: "S2_WRITER_CITATION_NOT_IN_CONTEXT" });
      let scope;
      try {
        scope = await resolveAuthorizedVaultScope(db, {
          userId: actor.id,
          spaceId: row.space_id,
          permission: "source:read",
          vaultIds: packet.scope.vaultIds,
          federated: packet.scope.federated,
        });
      } catch {
        return reply.code(403).send({ code: "S2_WRITER_SCOPE_DENIED" });
      }
      for (const section of packet.sections) {
        const prefix = scope.accessByVault[section.vaultId]?.pathPrefix;
        if (
          prefix === undefined ||
          !pathMatchesVaultPrefix(section.document.path, prefix)
        )
          return reply.code(403).send({ code: "S2_WRITER_SCOPE_DENIED" });
      }
      const port: GovernedLayeredPropositionPort = {
        resolve: ({ originalQuestion, hit }) =>
          trustedPort.resolve({
            originalQuestion,
            hit,
            principalId: actor.id,
            spaceId: row.space_id,
          }),
      };
      // Resolve the actual Writer statement text using a distinct reviewed
      // projection. Client statement projections are not accepted as input.
      const statements: GovernedWriterStatement[] = [];
      for (const s of input.statements) {
        const section = sourceMap.get(s.citationId)!;
        const hit = hitFromFrozenSection(section);
        let statementProof;
        try {
          statementProof = await port.resolve({
            originalQuestion: s.text,
            hit,
          });
        } catch {
          statementProof = null;
        }
        if (
          !statementProof ||
          statementProof.queryProposition.requestedAnswerRole !== undefined ||
          !statementProof.queryProposition.subject.trim()
        ) {
          // Writer output must be a complete assertion; an unknown question
          // slot cannot masquerade as an independently reviewed claim.
          return {
            status: "WITHHELD_WRITER_STATEMENT_REVIEW",
            productionAdmission: false,
            releaseGateAccepted: false,
            testedClaims: 0,
            totalClaims: input.statements.length,
          };
        }
        statements.push({
          text: s.text,
          startUtf16: s.startUtf16,
          endUtf16: s.endUtf16,
          citationId: s.citationId,
          citedHit: hit,
          citedCandidateKey: retrievalAnswerabilityCandidateKey(hit),
          statementProposition: statementProof.queryProposition,
        });
      }
      const audit = await auditGovernedWriterStatements({
        originalQuestion: packet.query,
        answerText: input.answerText,
        statements,
        governedPropositionPort: port,
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
