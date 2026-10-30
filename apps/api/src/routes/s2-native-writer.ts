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
import { findS2ReviewedSourceAnchor } from "../s2-reviewed-source-proposition-service.js";

const sha = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const Request = z
  .object({
    packetId: z.string().uuid(),
    packetHash: z.string().min(1).max(256),
    language: z.enum(["en", "es"]),
    mode: z
      .enum(["REVIEWED_CUSTODY", "SOURCE_ANCHORED_SHADOW"])
      .default("REVIEWED_CUSTODY"),
  })
  .strict();

/** Private evaluator-only, injected by the trusted server owner.
 * The SOURCE and Writer prose MUST NEVER be returned by HTTP or logged.
 * Review fields are deliberately blank; this is NOT human gold.
 */
export interface S2PrivateShadowReviewSample {
  schemaVersion: "akp.s2.private-shadow-review-sample.v1";
  caseSha256: string;
  packetSha256: string;
  language: "en" | "es";
  question: string;
  passages: {
    citationId: string;
    sourceText: string;
    originalSourceSha256: string;
    originalSourceText: string;
    startUtf16: number;
    endUtf16: number;
  }[];
  writer: {
    answerText: string;
    abstained: boolean;
    statements: { text: string; citationId: string }[];
    requestSha256: string;
    responseSha256: string;
    modelDigestSha256: string;
    providerMs: number;
  };
  review: {
    sourceAnswerability: null;
    claimFaithfulness: null;
    abstentionJustified: null;
    independentReviewerIdentityVerified: false;
    semanticGoldVerified: false;
    releaseGateAccepted: false;
  };
}
export type S2PrivateShadowReviewSink = (
  sample: Readonly<S2PrivateShadowReviewSample>,
) => Promise<void> | void;

/** Experimental *existing* governed Writer custody pipeline, not a new judge.
 * Provider never receives unchecked or out-of-scope ContextPacket bytes.
 * Only the same source/claim admission owner can return a CANDIDATE.
 */
export function registerS2NativeReviewedWriterRoutes(
  app: FastifyInstance,
  db: Postgres,
  trustedPort: GovernedLayeredPropositionPort,
  provider: S2AtomicWriterProvider,
  privateReviewSink?: S2PrivateShadowReviewSink,
): void {
  const privateReviewCaptureEnabled =
    process.env.AKP_S2_PRIVATE_SHADOW_REVIEW_CAPTURE_ENABLED === "true";
  if (privateReviewCaptureEnabled && !privateReviewSink)
    throw new Error("S2_PRIVATE_SHADOW_REVIEW_SINK_REQUIRED");
  const sourceAnchoredShadowEnabled =
    process.env.AKP_S2_SOURCE_ANCHORED_SHADOW_ENABLED === "true";
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
      if (
        input.data.mode === "SOURCE_ANCHORED_SHADOW" &&
        !sourceAnchoredShadowEnabled
      )
        return reply
          .code(403)
          .send({ code: "S2_UNSEEN_QUESTION_SHADOW_DISABLED" });
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
      const sourceAnchors: string[] = [];
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
        if (input.data.mode === "SOURCE_ANCHORED_SHADOW") {
          // Only an already approved SOURCE anchor may be used. Its
          // projections are NEVER treated as review of packet.query.
          const anchor = await findS2ReviewedSourceAnchor({
            db,
            port: trustedPort,
            principalId: principal.id,
            spaceId: packet.scope.spaceId,
            hit,
            excludedQuestion: packet.query,
          });
          if (!anchor)
            return {
              status: "WITHHELD_UNREVIEWED_SOURCE_ANCHOR",
              productionAdmission: false,
              releaseGateAccepted: false,
              modelInvoked: false,
            };
          sourceProof = anchor.proof;
          sourceAnchors.push(anchor.anchorQuestionSha256);
        } else if (
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
      // No model result, INCLUDING an abstention or malformed output, may
      // bypass the second ACL/SOURCE check after inference.
      const second = await resolveS2WriterContext({
        db,
        principal,
        packetId: packet.packetId,
        packetHash: packet.packetHash,
        trustedPort,
      });
      if (!second.ok)
        return reply.code(second.status).send({ code: second.code });
      if (input.data.mode === "SOURCE_ANCHORED_SHADOW") {
        if (
          second.packet.query !== packet.query ||
          second.packet.sections.length !== sourceAnchors.length
        )
          return reply.code(409).send({ code: "S2_SHADOW_PACKET_CHANGED" });
        for (const [index, section] of second.packet.sections.entries()) {
          const anchor = await findS2ReviewedSourceAnchor({
            db,
            port: second.port,
            principalId: principal.id,
            spaceId: second.packet.scope.spaceId,
            hit: hitFromReviewedS2Section(section),
            excludedQuestion: second.packet.query,
          });
          // The original review/source may have been revoked or changed
          // during inference; no shadow receipt is produced in that case.
          if (!anchor || anchor.anchorQuestionSha256 !== sourceAnchors[index])
            return {
              status: "WITHHELD_SOURCE_ANCHOR_CHANGED_AFTER_INFERENCE",
              modelInvoked: true,
              productionAdmission: false,
              releaseGateAccepted: false,
            };
        }
      } else {
        // Even if the model abstains or violates the response schema, the
        // original reviewed question and literal SOURCE must still be valid.
        for (const section of second.packet.sections) {
          const hit = hitFromReviewedS2Section(section);
          let proof = null;
          try {
            proof = await second.port.resolve({
              originalQuestion: second.packet.query,
              hit,
            });
          } catch {
            proof = null;
          }
          if (
            !bindGovernedLayeredPropositionInput(
              second.packet.query,
              hit,
              proof,
            )
          )
            return {
              status: "WITHHELD_REVIEWED_SOURCE_CHANGED_AFTER_INFERENCE",
              modelInvoked: true,
              productionAdmission: false,
              releaseGateAccepted: false,
            };
        }
      }
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
      // Model outputs are still untrusted. This private, injected hook only
      // lets an authorized evaluator assemble blind-review material after
      // current ACL and original-SOURCE checks; it supplies NO admission.
      if (
        input.data.mode === "SOURCE_ANCHORED_SHADOW" &&
        privateReviewCaptureEnabled &&
        privateReviewSink
      ) {
        try {
          const sample: S2PrivateShadowReviewSample = {
            schemaVersion: "akp.s2.private-shadow-review-sample.v1",
            caseSha256: caseData.caseKeySha256,
            packetSha256: sha(packet.packetHash),
            language: input.data.language,
            question: packet.query,
            passages: passages.map((passage, index) => ({
              citationId: passage.id,
              sourceText: passage.text,
              originalSourceSha256: originals[index]!.fileSha256,
              originalSourceText: new TextDecoder("utf-8", {
                fatal: true,
              }).decode(originals[index]!.fileBytes),
              startUtf16: passage.original!.startUtf16,
              endUtf16: passage.original!.endUtf16,
            })),
            writer: {
              answerText: observed.answerText ?? "",
              abstained: observed.abstained === true,
              statements: observed.statements.map((statement) => ({
                text: statement.text,
                citationId: statement.citationId,
              })),
              requestSha256: observed.requestSha256,
              responseSha256: observed.responseSha256,
              modelDigestSha256: provider.modelDigestSha256,
              providerMs,
            },
            review: {
              sourceAnswerability: null,
              claimFaithfulness: null,
              abstentionJustified: null,
              independentReviewerIdentityVerified: false,
              semanticGoldVerified: false,
              releaseGateAccepted: false,
            },
          };
          await privateReviewSink(sample);
        } catch {
          // No query, SOURCE, model output or private sink error in HTTP.
          return {
            status: "WITHHELD_PRIVATE_REVIEW_CAPTURE_FAILED",
            modelInvoked: true,
            productionAdmission: false,
            releaseGateAccepted: false,
          };
        }
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
      if (input.data.mode === "SOURCE_ANCHORED_SHADOW") {
        return {
          status: "UNSEEN_QUESTION_SOURCE_ANCHORED_SHADOW",
          evaluationOnly: true,
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
          reviewedQuestion: false,
          individualClaimReviewPerformed: false,
          originalSourceCustodyRevalidated: true,
          semanticQuestionAndClaimAuthority: false,
          originalSourceAuthorizationIndependentlyVerified: false,
          productionAdmission: false,
          releaseGateAccepted: false,
          fullAuthenticatedWriterRoundTripIndependentlyVerified: false,
        };
      }
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
