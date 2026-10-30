import type { ContextPacket, SearchHit } from "@akp/contracts";
import {
  auditGovernedWriterStatements,
  retrievalAnswerabilityCandidateKey,
  type GovernedLayeredPropositionPort,
  type GovernedWriterStatement,
  type LayeredEvidenceAdmissionEvaluator,
} from "@akp/retrieval";

export type ReviewedS2Statement = {
  text: string;
  startUtf16: number;
  endUtf16: number;
  citationId: string;
};
export type ReviewedS2AuditOutcome =
  | {
      status: "WITHHELD_WRITER_STATEMENT_REVIEW";
      productionAdmission: false;
      releaseGateAccepted: false;
      testedClaims: 0;
      totalClaims: number;
    }
  | Awaited<ReturnType<typeof auditGovernedWriterStatements>>;

/** Only ContextPacket sections are candidates: no shadow, generated parent or
 * externally submitted source ID may inject new evidence at the Writer gate.
 */
export function hitFromReviewedS2Section(
  section: ContextPacket["sections"][number],
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
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 0,
    reasons: ["s2:reviewed-original-source-writer"],
    excerpt: section.content,
    citations: [],
  };
}

/** Shared sole authority for both externally supplied and generated Writer
 * statements. The model NEVER submits its own structured propositions.
 * Human-review truth is not proved by two simulated identities.
 */
export async function auditReviewedS2Statements(input: {
  packet: ContextPacket;
  answerText: string;
  statements: readonly ReviewedS2Statement[];
  trustedPort: GovernedLayeredPropositionPort;
  admissionPipeline: LayeredEvidenceAdmissionEvaluator;
}): Promise<ReviewedS2AuditOutcome> {
  const sourceMap = new Map(
    input.packet.sections.map(
      (section, i) => ["SEC" + (i + 1), section] as const,
    ),
  );
  const statements: GovernedWriterStatement[] = [];
  for (const statement of input.statements) {
    const section = sourceMap.get(statement.citationId);
    if (!section) {
      return {
        status: "WITHHELD_WRITER_STATEMENT_REVIEW",
        productionAdmission: false,
        releaseGateAccepted: false,
        testedClaims: 0,
        totalClaims: input.statements.length,
      };
    }
    const hit = hitFromReviewedS2Section(section);
    let proof;
    try {
      proof = await input.trustedPort.resolve({
        originalQuestion: statement.text,
        hit,
      });
    } catch {
      proof = null;
    }
    if (
      !proof ||
      proof.queryProposition.requestedAnswerRole !== undefined ||
      !proof.queryProposition.subject.trim()
    ) {
      return {
        status: "WITHHELD_WRITER_STATEMENT_REVIEW",
        productionAdmission: false,
        releaseGateAccepted: false,
        testedClaims: 0,
        totalClaims: input.statements.length,
      };
    }
    statements.push({
      text: statement.text,
      startUtf16: statement.startUtf16,
      endUtf16: statement.endUtf16,
      citationId: statement.citationId,
      citedHit: hit,
      citedCandidateKey: retrievalAnswerabilityCandidateKey(hit),
      statementProposition: proof.queryProposition,
    });
  }
  return auditGovernedWriterStatements({
    originalQuestion: input.packet.query,
    answerText: input.answerText,
    statements,
    governedPropositionPort: input.trustedPort,
    admissionPipeline: input.admissionPipeline,
  });
}
