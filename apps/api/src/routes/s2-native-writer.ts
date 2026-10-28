import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Postgres } from "@akp/postgres";
import {
  bindGovernedLayeredPropositionInput,
  LayeredEvidenceAdmissionPipeline,
  type GovernedLayeredPropositionPort,
} from "@akp/retrieval";
import {
  freezeS2AtomicNativeWriter,
  observeS2AtomicNativeWriter,
  type FrozenOriginalReference,
  type WriterProbeInput,
} from "@akp/evaluation";
import { actorOf, requirePermission } from "../auth.js";
import { resolveS2WriterContext } from "../s2-writer-context.js";
import {
  auditReviewedS2Statements,
  hitFromReviewedS2Section,
} from "../s2-writer-audit-core.js";
import type { S2AtomicWriterProvider } from "../s2-local-atomic-provider.js";

const sha = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const Request = z
  .object({
    packetId: z.string().uuid(),
    packetHash: z.string().min(1).max(256),
    language: z.enum(["en", "es"]),
  })
  .strict();

/** Experimental *existing* governed Writer custody pipeline, not a new judge.
 * Provider never receives unchecked or out-of-scope ContextPacket bytes.
 * Only the same source/claim admission owner can return a CANDIDATE.
 */
export function registerS2NativeReviewedWriterRoutes(
  app: FastifyInstance,
  db: Postgres,
  trustedPort: GovernedLayeredPropositionPort,
  provider: S2AtomicWriterProvider,
): void {
  const pipeline = new LayeredEvidenceAdmissionPipeline({
    semanticReader: {
      id: "s2:native-reviewed-source-only",
      async read() {
        return {
          layer: "SEMANTIC_READER" as const,
          verdict: { kind: "INSUFFICIENT" as const },
          reason: "S2_ONLY_REVIEWED_PROPOSITIONS_MAY_ADMIT",
          readerId: "s2:native-reviewed-source-only",
        };
      },
    },
    structuredMismatchPolicy: "ABSTAIN",
  });
  app.post(
    "/v1/s2/writer-claims/generate-audit",
    {
      preHandler: requirePermission("eval:run"),
    },
    async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      const input = Request.safeParse(request.body);
      if (!input.success)
        return reply
          .code(400)
          .send({ code: "S2_NATIVE_WRITER_REQUEST_INVALID" });
      const principal = actorOf(request);
      if (!principal) return reply.code(401).send({ code: "AUTH_REQUIRED" });
      const scoped = await resolveS2WriterContext({
        db,
        principal,
        packetId: input.data.packetId,
        packetHash: input.data.packetHash,
        trustedPort,
      });
      if (!scoped.ok)
        return reply.code(scoped.status).send({ code: scoped.code });
      const { packet, port } = scoped;
      if (packet.sections.length === 0 || packet.sections.length > 4)
        return {
          status: "WITHHELD_SOURCE_BUDGET",
          productionAdmission: false,
          releaseGateAccepted: false,
          modelInvoked: false,
        };
      const originals: FrozenOriginalReference[] = [];
      const passages: WriterProbeInput["passages"] = [];
      for (const [index, section] of packet.sections.entries()) {
        const hit = hitFromReviewedS2Section(section);
        let sourceProof = null;
        try {
          sourceProof = await port.resolve({
            originalQuestion: packet.query,
            hit,
          });
        } catch {
          sourceProof = null;
        }
        if (
          !bindGovernedLayeredPropositionInput(packet.query, hit, sourceProof)
        ) {
          return {
            status: "WITHHELD_UNREVIEWED_QUESTION_OR_SOURCE",
            productionAdmission: false,
            releaseGateAccepted: false,
            modelInvoked: false,
          };
        }
        const proof = sourceProof!;
        const documentKeySha256 = sha(
          JSON.stringify([
            hit.vaultId,
            hit.documentId,
            hit.unitId ?? null,
            hit.revision,
            hit.document.path,
            index,
          ]),
        );
        originals.push({
          documentKeySha256,
          fileSha256: proof.originalSourceSha256,
          fileBytes: proof.originalSourceBytes,
          bodyStartUtf16: 0,
          bodyEndUtf16: proof.originalSourceText.length,
        });
        passages.push({
          id: "SECTION" + (index + 1),
          text: section.content,
          original: {
            documentKeySha256,
            fileSha256: proof.originalSourceSha256,
            startUtf16: proof.excerptStartUtf16,
            endUtf16: proof.excerptEndUtf16,
          },
        });
      }
      const caseData: WriterProbeInput = {
        caseKeySha256: sha(input.data.language + "\0" + packet.query),
        caseManifestSha256: sha(
          JSON.stringify([packet.packetId, packet.packetHash]),
        ),
        sourceManifestSha256: sha(
          JSON.stringify(passages.map((p) => p.original)),
        ),
        executedCommitSha: provider.codeCommitSha,
        sourceFamilySha256: sha(
          JSON.stringify(
            packet.sections.map((s) => [
              s.vaultId,
              s.documentId,
              s.documentRevision,
            ]),
          ),
        ),
        language: input.data.language,
        question: packet.query,
        model: provider.model,
        modelDigestSha256: provider.modelDigestSha256,
        systemPrompt:
          "You are an evidence-only source-bound Writer. " +
          "Answer precisely the requested actor, relation, amount, time and conditions " +
          "in the question language. Never turn a related topic into factual support. " +
          "No citation or partial evidence means abstain.",
        temperature: 0,
        seed: 62028,
        maxTokens: 384,
        passages,
      };
      let frozen: ReturnType<typeof freezeS2AtomicNativeWriter>;
      try {
        frozen = freezeS2AtomicNativeWriter({
          case: caseData,
          originals,
          contextTokens: 8192,
          maxOutputTokens: 384,
          disableThinking: true,
        });
      } catch {
        return {
          status: "WITHHELD_FROZEN_SOURCE_OR_CONTEXT_BUDGET",
          productionAdmission: false,
          releaseGateAccepted: false,
          modelInvoked: false,
        };
      }
      let bytes: Uint8Array;
      const providerStarted = performance.now();
      try {
        bytes = await provider.generate(frozen.requestBytes);
      } catch {
        return reply.code(503).send({
          code: "S2_NATIVE_WRITER_PROVIDER_UNAVAILABLE",
          productionAdmission: false,
          releaseGateAccepted: false,
          modelInvoked: true,
          requestSha256: frozen.freeze.exactRequestSha256,
        });
      }
      const providerMs =
        Math.round((performance.now() - providerStarted) * 100) / 100;
      let observed: ReturnType<typeof observeS2AtomicNativeWriter>;
      try {
        observed = observeS2AtomicNativeWriter(
          frozen.freeze,
          frozen.requestBytes,
          bytes,
        );
      } catch {
        return {
          status: "WITHHELD_PROVIDER_CUSTODY_FAILURE",
          productionAdmission: false,
          releaseGateAccepted: false,
          modelInvoked: true,
          providerMs,
        };
      }
      if (observed.status !== "STRUCTURALLY_VALID") {
        return {
          status: "WITHHELD_PROVIDER_OUTPUT",
          reason: observed.reason,
          requestSha256: observed.requestSha256,
          responseSha256: observed.responseSha256,
          promptTokens: observed.promptTokens,
          completionTokens: observed.completionTokens,
          providerMs,
          productionAdmission: false,
          releaseGateAccepted: false,
          modelInvoked: true,
        };
      }
      if (observed.abstained) {
        return {
          status: "WRITER_ABSTAINED_NO_ANSWER",
          requestSha256: observed.requestSha256,
          responseSha256: observed.responseSha256,
          promptTokens: observed.promptTokens,
          completionTokens: observed.completionTokens,
          providerMs,
          modelInvoked: true,
          productionAdmission: false,
          releaseGateAccepted: false,
        };
      }
      const statements = observed.statements.map((s) => ({
        ...s,
        citationId: s.citationId.replace(/^SECTION/u, "SEC"),
      }));
      // Recheck current permissions/packet/revision AFTER provider latency.
      const second = await resolveS2WriterContext({
        db,
        principal,
        packetId: packet.packetId,
        packetHash: packet.packetHash,
        trustedPort,
      });
      if (!second.ok)
        return reply.code(second.status).send({ code: second.code });
      const audit = await auditReviewedS2Statements({
        packet: second.packet,
        answerText: observed.answerText!,
        statements,
        trustedPort: second.port,
        admissionPipeline: pipeline,
      });
      return {
        modelInvoked: true,
        model: provider.model,
        modelDigestSha256: provider.modelDigestSha256,
        requestSha256: observed.requestSha256,
        responseSha256: observed.responseSha256,
        answerSha256: sha(observed.answerText!),
        promptTokens: observed.promptTokens,
        completionTokens: observed.completionTokens,
        providerMs,
        claimCount: statements.length,
        ...audit,
        productionAdmission: false,
        releaseGateAccepted: false,
        originalSourceAuthorizationIndependentlyVerified: false,
        fullAuthenticatedWriterRoundTripIndependentlyVerified: false,
      };
    },
  );
}
