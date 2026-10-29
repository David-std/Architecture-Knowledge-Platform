import { createHash, createHmac } from "node:crypto";
import {
  parseS2ExternalIntakeCsv,
  preflightS2IndependentIntake,
  type ExternalSourceFile,
} from "./s2-independent-intake.js";

/**
 * PRE-INFERENCE blind reviewer packets from independently supplied original
 * sources; never construct truth labels, model answers, or acceptance.
 * The caller must independently establish rights, custodian identity,
 * real-source universe completeness and control access to each private file.
 */
const sha = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
const h = (salt: string, s: string) =>
  createHmac("sha256", Buffer.from(salt, "hex"))
    .update(s, "utf8")
    .digest("hex");
const fail = (s: string): never => {
  throw Error("S2_PREINFERENCE_BLIND_" + s);
};
type ReviewerCase = {
  reviewCaseKey: string;
  language: "en" | "es";
  question: string;
  sourceKeySha256: string;
  sourceAnswerability: null;
  reviewerAnswer: null;
  supportingQuoteSpans: [];
  wholeAuthorizedCorpusAbsenceChecked: null;
  reviewerNotes: null;
};
export function prepareS2PreInferenceBlindReview(input: {
  templateBytes: Uint8Array;
  templateSha256: string;
  filledBytes: Uint8Array;
  filledSha256: string;
  sourceFiles: readonly ExternalSourceFile[];
  excludedDevelopmentPublisherFamilies: readonly string[];
  /** 256-bit secret retained solely by trusted coordinator, not reviewers. */
  reviewerShuffleSalt: string;
}) {
  if (!/^[a-f0-9]{64}$/u.test(input.reviewerShuffleSalt))
    fail("PRIVATE_SALT_REQUIRED");
  const preflight = preflightS2IndependentIntake(input);
  const rows = parseS2ExternalIntakeCsv(input.filledBytes);
  const original = new Map(
    input.sourceFiles.map((f) => [
      f.familySeat + "/" + f.relativePath,
      f.rawBytes,
    ]),
  );
  const sources = new Map<
    string,
    {
      sourceKeySha256: string;
      originalSha256: string;
      originalText: string;
      upstreamRepository: string;
      revision40Hex: string;
      relativePath: string;
      authorizedVaultScope: string;
    }
  >();
  const mapping: Record<string, unknown>[] = [];
  const questions: ReviewerCase[] = [];
  for (const row of rows) {
    const sourceBytes = original.get(
      row.publisherFamilySeat + "/" + row.sourceRelativePath,
    );
    if (!sourceBytes) fail("SOURCE_MISSING_AFTER_PREFLIGHT");
    const sourceKeySha256 = sha(
      row.publisherFamilySeat +
        "\0" +
        row.sourceRelativePath +
        "\0" +
        row.originalSha256 +
        "\0" +
        row.authorizedVaultScope,
    );
    if (!sources.has(sourceKeySha256)) {
      sources.set(sourceKeySha256, {
        sourceKeySha256,
        originalSha256: row.originalSha256,
        originalText: new TextDecoder("utf8", { fatal: true }).decode(
          sourceBytes,
        ),
        upstreamRepository: row.upstreamRepository,
        revision40Hex: row.sourceRevision40Hex,
        relativePath: row.sourceRelativePath,
        authorizedVaultScope: row.authorizedVaultScope,
      });
    }
    const reviewCaseKey = h(input.reviewerShuffleSalt, "CASE\0" + row.caseSeat);
    questions.push({
      reviewCaseKey,
      language: row.language as "en" | "es",
      question: row.question,
      sourceKeySha256,
      sourceAnswerability: null,
      reviewerAnswer: null,
      supportingQuoteSpans: [],
      wholeAuthorizedCorpusAbsenceChecked: null,
      reviewerNotes: null,
    });
    mapping.push({
      reviewCaseKey,
      caseSeat: row.caseSeat,
      publisherFamilySeat: row.publisherFamilySeat,
      language: row.language,
      targetStratum: row.targetStratum,
      sourceKeySha256,
      originalSha256: row.originalSha256,
      sourceLocatorUtf16Start: Number(row.sourceLocatorUtf16Start),
      sourceLocatorUtf16End: Number(row.sourceLocatorUtf16End),
      ownerSuggestedGoldKeepPrivate: row.ownerSuggestedGoldKeepPrivate,
      externalCustodianSourceSelectionReason:
        row.externalCustodianSourceSelectionReason,
      externalCustodianCaseAuthor: row.externalCustodianCaseAuthor,
    });
  }
  const sourceDocs = [...sources.values()].sort((a, b) =>
    a.sourceKeySha256.localeCompare(b.sourceKeySha256),
  );
  const packet = (reviewer: "X" | "Y") => ({
    schemaVersion: "akp.s2.preinference-original-source-review.v1" as const,
    reviewer,
    frozenIntakeSha256: input.filledSha256,
    sourceDocs,
    cases: [...questions].sort((a, b) =>
      h(
        input.reviewerShuffleSalt,
        reviewer + "\0" + a.reviewCaseKey,
      ).localeCompare(
        h(input.reviewerShuffleSalt, reviewer + "\0" + b.reviewCaseKey),
      ),
    ),
    expectedGoldIncluded: false as const,
    modelOutputsIncluded: false as const,
    reviewerIdentityAuthenticated: false as const,
    wholeAuthorizedCorpusAbsenceProven: false as const,
    independentGoldAdjudicated: false as const,
    releaseGateAccepted: false as const,
  });
  const coordinatorOnly = {
    schemaVersion: "akp.s2.preinference-private-coordinator-map.v1" as const,
    frozenIntakeSha256: input.filledSha256,
    reviewerShuffleSalt: input.reviewerShuffleSalt,
    cases: mapping,
    externalSourceRightsAttested: false as const,
    reviewerAssignmentsExternallyAuthenticated: false as const,
    independentGoldAdjudicated: false as const,
    releaseGateAccepted: false as const,
  };
  const x = packet("X"),
    y = packet("Y");
  if (
    x.cases.length !== 240 ||
    y.cases.length !== 240 ||
    new Set(x.cases.map((c) => c.reviewCaseKey)).size !== 240 ||
    x.cases.some((c) => c.sourceAnswerability !== null)
  )
    fail("PACKET_INTEGRITY");
  return {
    status: "PREINFERENCE_BLIND_PACKETS_UNREVIEWED" as const,
    preflight,
    packets: { X: x, Y: y },
    coordinatorOnly,
    privateSourceCount: sourceDocs.length,
    releaseGateAccepted: false as const,
  };
}
