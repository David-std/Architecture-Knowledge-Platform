/**
 * S2.8 pre-admission source/context token comparison on the actual authorized
 * E5 ranks recorded by the disposable PostgreSQL integration workflow.
 *
 * This is NOT a production context assembly, independently judged precision,
 * end-user answer evaluation, or evidence-admission result.
 * Source labels are used only for integrity; never for candidate selection.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AutoTokenizer } from "@huggingface/transformers";
import {
  buildContextPacketPair,
  type ContextContinuationPayload,
  type PacketCandidate,
  type Tokenizer,
} from "../src/index.js";

const root = path.resolve(import.meta.dirname, "../../..");
const reportFile = path.resolve(
  root,
  process.env.AKP_S2_MULTILINGUAL_REPORT ??
    "reports/ci/s2-multilingual-shadow-baseline.json",
);
const fixtureFile = path.join(
  root,
  "evals/registered/s2-source-span-holdout.json",
);
const outputFile = path.resolve(
  root,
  process.env.AKP_S2_TOKEN_CONTEXT_REPORT ??
    "reports/ci/s2-exact-context-token-shadow.json",
);
const model = "onnx-community/SmolLM2-135M-Instruct-ONNX";
const revision = "b8a5c0f183b78c55955a5364f610c36668b5e681";
const frozenBlob = "a61a24df46c0351115cd09e079ae0d8383033082";
const sha256 = (value: string | Buffer): string =>
  createHash("sha256").update(value).digest("hex");
const uuid = (key: string): string => {
  const h = sha256(key).slice(0, 32);
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    "4" + h.slice(13, 16),
    "8" + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
};

interface SourceUnit {
  id: string;
  text: string;
}
interface SourceDocument {
  id: string;
  units: SourceUnit[];
}
interface Question {
  id: string;
  sourceId: string;
  query: string;
  language: "en" | "es";
  answerable: boolean;
  gold: { unitId: string; quote: string }[];
}
interface Fixture {
  sourceDocuments: SourceDocument[];
  cases: Question[];
}
interface Diagnostic {
  caseId: string;
  sourceId: string;
  language: "en" | "es";
  rankedUnitIds: string[];
  candidateCount: number;
}
interface Report {
  frozenGitBlobSha1: string;
  branchHeadSha: string;
  sourceSha256: Record<string, string>;
  admissionMeasured: boolean;
  gateAccepted: boolean;
  arms: { configuration: string; diagnostics: Diagnostic[] }[];
}
const [fixtureBytes, reportBytes] = await Promise.all([
  readFile(fixtureFile),
  readFile(reportFile),
]);
const computedBlob = createHash("sha1")
  .update("blob " + fixtureBytes.length + "\0")
  .update(fixtureBytes)
  .digest("hex");
if (computedBlob !== frozenBlob)
  throw new Error("S2_TOKEN_SOURCE_FREEZE_MISMATCH");
const fixture = JSON.parse(fixtureBytes.toString("utf8")) as Fixture;
const recorded = JSON.parse(reportBytes.toString("utf8")) as Report;
if (
  recorded.frozenGitBlobSha1 !== frozenBlob ||
  recorded.admissionMeasured !== false ||
  recorded.gateAccepted !== false ||
  recorded.branchHeadSha !== process.env.AKP_S2_BRANCH_HEAD_SHA
)
  throw new Error("S2_TOKEN_RECORDING_NOT_CURRENT_SHADOW");
const sourceById = new Map(fixture.sourceDocuments.map((s) => [s.id, s]));
const caseById = new Map(fixture.cases.map((c) => [c.id, c]));
if (sourceById.size !== 4 || caseById.size !== 48) {
  throw new Error("S2_TOKEN_FIXTURE_INVALID");
}
for (const source of fixture.sourceDocuments) {
  const digest = sha256(
    source.units.map((u) => u.id + "\n" + u.text).join("\n\n"),
  );
  if (recorded.sourceSha256[source.id] !== digest) {
    throw new Error("S2_TOKEN_SOURCE_HASH_MISMATCH");
  }
}
const hybrid = recorded.arms.find(
  (arm) => arm.configuration === "EXISTING_E5_MULTILINGUAL_HYBRID",
);
if (!hybrid || hybrid.diagnostics.length !== fixture.cases.length) {
  throw new Error("S2_TOKEN_E5_DIAGNOSTICS_INCOMPLETE");
}

const tokenizer = await AutoTokenizer.from_pretrained(model, { revision });
const tokens = (text: string): number => tokenizer.encode(text).length;
const tokenizerPort: Tokenizer = {
  id: `huggingface:${model}@${revision}`,
  label: `${model} tokenizer at ${revision}`,
  quality: "EXACT",
  approximate: false,
  count: tokens,
};
const rows = hybrid.diagnostics.map((diagnostic) => {
  const question = caseById.get(diagnostic.caseId);
  if (
    !question ||
    diagnostic.sourceId !== question.sourceId ||
    diagnostic.language !== question.language
  )
    throw new Error("S2_TOKEN_CASE_IDENTITY_MISMATCH");
  const source = sourceById.get(question.sourceId);
  if (!source) throw new Error("S2_TOKEN_SOURCE_UNKNOWN");
  const byId = new Map(source.units.map((u) => [u.id, u]));
  if (
    byId.size !== 6 ||
    diagnostic.candidateCount !== 6 ||
    diagnostic.rankedUnitIds.length !== 6 ||
    new Set(diagnostic.rankedUnitIds).size !== 6 ||
    diagnostic.rankedUnitIds.some((id) => !byId.has(id))
  )
    throw new Error("S2_TOKEN_AUTHORIZED_RANKS_INVALID");
  // Gold is used exclusively after ranking for literal transport auditing.
  // It never changes the candidate order, projection budget or source content.
  if (
    typeof question.answerable !== "boolean" ||
    question.gold.length !== (question.answerable ? 1 : 0) ||
    question.gold.some(
      (gold) => !byId.get(gold.unitId)?.text.includes(gold.quote),
    )
  )
    throw new Error("S2_TOKEN_ORACLE_NOT_SOURCE_BOUND");
  const units = diagnostic.rankedUnitIds.map((id) => byId.get(id)!);
  const fullSourceText = source.units.map((u) => u.text).join("\n\n");
  const rankedSourceText = units.map((u) => u.text).join("\n\n");
  const candidates: PacketCandidate[] = units.map((unit, index) => ({
    kind: "source",
    content: unit.text,
    hit: {
      documentId: uuid("document:" + source.id),
      unitId: uuid("unit:" + unit.id),
      vaultId: uuid("vault:" + source.id),
      revision: frozenBlob,
      title: "S2 synthetic source " + source.id,
      type: "concept",
      document: {
        externalId: source.id,
        path: "s2/" + source.id + ".md",
        title: "S2 synthetic source " + source.id,
      },
      trust: "HUMAN_REVIEWED",
      lifecycle: "ACTIVE",
      score: 1 - index / 100,
      reasons: ["authorized-e5-shadow-candidate"],
      excerpt: unit.text,
      citations: ["s2-test-only:" + unit.id],
    },
  }));
  const continuationPayloads: ContextContinuationPayload[] = [];
  const packetPair = buildContextPacketPair({
    request: {
      query: question.query,
      spaceId: uuid("space:s2-synthetic"),
      vaultId: uuid("vault:" + source.id),
      vaultIds: [],
      federated: false,
      types: [],
      minimumTrust: "MACHINE_SUPPORTED",
      mode: "SOURCE_BACKED",
      limit: 10,
    },
    intent: "CONCEPTUAL",
    corpusRevision: frozenBlob,
    maxTokens: 2048,
    maxSectionsPerDocument: 6,
    candidates,
    // This synthetic transport benchmark intentionally bypasses the
    // query-conditioned semantic reader. Fail closed on packet status so
    // source transport cannot be mistaken for answer admission.
    retrievalConfiguration: {
      version: "s2-pre-admission-shadow",
      channels: ["exact", "lexical", "vector"],
      vectorEnabled: true,
      warnings: ["QUERY_CONDITIONED_ADMISSION_NOT_EVALUATED"],
    },
    candidates,
    tokenizer: tokenizerPort,
    continuationSink: (payload) => continuationPayloads.push(payload),
  });
  const fullPacketTokens = tokens(JSON.stringify(packetPair.full));
  const compactPacketTokens = tokens(JSON.stringify(packetPair.compact));
  if (
    packetPair.full.budget.tokenizer.quality !== "EXACT" ||
    packetPair.compact.budget.tokenizer.quality !== "EXACT" ||
    packetPair.full.budget.serializedTokens !== fullPacketTokens ||
    packetPair.compact.budget.serializedTokens !== compactPacketTokens ||
    fullPacketTokens > 32_000 ||
    compactPacketTokens > 2048
  )
    throw new Error("S2_TOKEN_PACKET_NOT_EXACT_OR_OUT_OF_BUDGET");

  const gold = question.gold[0];
  const goldIdentity = gold ? uuid("unit:" + gold.unitId) : null;
  const goldCitation = gold ? "s2-test-only:" + gold.unitId : null;
  const fullGoldQuotePresent = gold
    ? packetPair.full.sections.some(
        (section) =>
          section.unitId === goldIdentity &&
          section.content.includes(gold.quote),
      )
    : null;
  const compactGoldUnitPresent = gold
    ? packetPair.compact.content.some(
        (section) => section.identity.unitId === goldIdentity,
      )
    : null;
  const compactGoldQuotePresent = gold
    ? packetPair.compact.content.some(
        (section) =>
          section.identity.unitId === goldIdentity &&
          section.content.includes(gold.quote),
      )
    : null;
  const compactGoldCitationListed = goldCitation
    ? packetPair.compact.citations.includes(goldCitation)
    : null;
  const publishedContinuationHandles = new Set(
    packetPair.compact.continuations.map((continuation) => continuation.handle),
  );
  const linkedPayloads = continuationPayloads.filter((payload) =>
    publishedContinuationHandles.has(payload.continuation.handle),
  );
  if (
    new Set(linkedPayloads.map((payload) => payload.continuation.handle))
      .size !== publishedContinuationHandles.size
  ) {
    throw new Error("S2_TOKEN_PUBLISHED_CONTINUATION_UNRESOLVED");
  }
  // Every full source section must survive either intact in compact content
  // or byte-exact in an addressable continuation. This tests all 288 units,
  // including negative questions without a gold span.
  const compactUnitIds = new Set(
    packetPair.compact.content.map((section) => section.identity.unitId),
  );
  if (
    compactUnitIds.size !== packetPair.compact.content.length ||
    packetPair.compact.content.some((section) => {
      const full = packetPair.full.sections.find(
        (candidate) => candidate.unitId === section.identity.unitId,
      );
      return !full || !full.content.includes(section.content);
    })
  )
    throw new Error("S2_TOKEN_COMPACT_UNIT_ID_OR_CONTENT_UNBOUND");
  let exactFullUnitsInCompact = 0;
  let exactFullUnitsOnContinuation = 0;
  for (const fullSection of packetPair.full.sections) {
    if (
      packetPair.compact.content.some(
        (section) =>
          section.identity.unitId === fullSection.unitId &&
          section.content === fullSection.content,
      )
    ) {
      exactFullUnitsInCompact += 1;
    } else if (
      linkedPayloads.some((payload) =>
        payload.sections.some(
          (section) =>
            section.unitId === fullSection.unitId &&
            section.content === fullSection.content,
        ),
      )
    ) {
      exactFullUnitsOnContinuation += 1;
    } else {
      throw new Error("S2_TOKEN_SOURCE_UNIT_LOST_WITHOUT_CONTINUATION");
    }
  }
  const goldQuoteInContinuation = gold
    ? linkedPayloads.some((payload) =>
        payload.sections.some(
          (section) =>
            section.unitId === goldIdentity &&
            section.content.includes(gold.quote),
        ),
      )
    : null;
  if (gold && fullGoldQuotePresent !== true) {
    throw new Error("S2_TOKEN_FULL_PACKET_GOLD_SOURCE_LOST");
  }
  // Test the continuation ledger; a lost literal quote cannot be silently
  // counted as transport success simply because packet-level citations exist.
  if (
    gold &&
    compactGoldQuotePresent !== true &&
    goldQuoteInContinuation !== true
  )
    throw new Error("S2_TOKEN_GOLD_QUOTE_LOST_WITHOUT_CONTINUATION");
  const visibleCompactCitations = new Set(
    packetPair.compact.content.flatMap((section) => section.citations),
  );
  const metadataOnlyCitations = packetPair.compact.citations.filter(
    (citation) => !visibleCompactCitations.has(citation),
  ).length;
  return {
    caseId: diagnostic.caseId,
    language: diagnostic.language,
    sourceId: diagnostic.sourceId,
    candidateCount: units.length,
    fullSourceTokens: tokens(fullSourceText),
    rankedSixSourceTokens: tokens(rankedSourceText),
    topThreeSourceTokens: tokens(
      units
        .slice(0, 3)
        .map((u) => u.text)
        .join("\n\n"),
    ),
    topOneSourceTokens: tokens(units[0]!.text),
    fullContextPacketWireTokens: fullPacketTokens,
    compactContextPacketWireTokens: compactPacketTokens,
    fullPacketSectionCount: packetPair.full.sections.length,
    compactPacketSectionCount: packetPair.compact.content.length,
    fullPacketStatus: packetPair.full.status,
    compactPacketStatus: packetPair.compact.identity.status,
    compactHasContinuations: packetPair.compact.continuations.length > 0,
    sourceAnswerable: question.answerable,
    // Scope these counts to the compact payload; global citation metadata
    // from the full packet must never imply a passage was delivered.
    compactPacketCitationCount: packetPair.compact.citations.length,
    fullPacketCitationCount: packetPair.full.citations.length,
    preAdmissionStatusExplicitlyDegraded:
      packetPair.full.status === "DEGRADED" &&
      packetPair.compact.identity.status === "DEGRADED",
    // Author-constructed oracle audit, NEVER independently adjudicated.
    goldUnitRetrievalRank: gold
      ? diagnostic.rankedUnitIds.indexOf(gold.unitId) + 1
      : null,
    fullGoldQuotePresent,
    compactGoldUnitPresent,
    compactGoldQuotePresent,
    compactGoldCitationListed,
    goldQuoteInContinuation,
    metadataOnlyCitations,
    continuationPayloadCount: linkedPayloads.length,
    exactFullUnitsInCompact,
    exactFullUnitsOnContinuation,
    sourceUnitTransportLossCount:
      packetPair.full.sections.length -
      exactFullUnitsInCompact -
      exactFullUnitsOnContinuation,
  };
});
if (new Set(rows.map((row) => row.caseId)).size !== 48) {
  throw new Error("S2_TOKEN_DUPLICATE_OBSERVATIONS");
}
if (
  rows.some(
    (row) =>
      !row.preAdmissionStatusExplicitlyDegraded ||
      row.metadataOnlyCitations !== 0 ||
      row.compactPacketCitationCount > row.fullPacketCitationCount,
  )
)
  throw new Error("S2_PRE_ADMISSION_PACKET_MISREPRESENTS_EVIDENCE");
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    mean: values.reduce((s, n) => s + n, 0) / values.length,
    median: (sorted[23]! + sorted[24]!) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    minimum: sorted[0]!,
    maximum: sorted.at(-1)!,
  };
}
const metrics = [
  "fullSourceTokens",
  "rankedSixSourceTokens",
  "topThreeSourceTokens",
  "topOneSourceTokens",
  "fullContextPacketWireTokens",
  "compactContextPacketWireTokens",
] as const;
const distributions = Object.fromEntries(
  metrics.map((field) => [field, distribution(rows.map((r) => r[field]))]),
);
const sourceUnitTransport = {
  status: "EXACT_SOURCE_UNIT_OR_PUBLISHED_CONTINUATION",
  sourceUnitCount: rows.reduce(
    (sum, row) => sum + row.fullPacketSectionCount,
    0,
  ),
  carriedExactInCompact: rows.reduce(
    (sum, row) => sum + row.exactFullUnitsInCompact,
    0,
  ),
  recoverableOnContinuation: rows.reduce(
    (sum, row) => sum + row.exactFullUnitsOnContinuation,
    0,
  ),
  lostWithoutContinuation: rows.reduce(
    (sum, row) => sum + row.sourceUnitTransportLossCount,
    0,
  ),
};
const quoteTransportRows = rows.filter((row) => row.sourceAnswerable);
if (quoteTransportRows.length !== 24)
  throw new Error("S2_QUOTE_TRANSPORT_POSITIVE_COUNT_INVALID");
const quoteTransport = {
  status: "AUTHOR_ORACLE_LITERAL_TRANSPORT_NOT_SEMANTIC_ADMISSION",
  positiveCases: quoteTransportRows.length,
  fullQuoteVisible: quoteTransportRows.filter(
    (row) => row.fullGoldQuotePresent === true,
  ).length,
  compactQuoteVisible: quoteTransportRows.filter(
    (row) => row.compactGoldQuotePresent === true,
  ).length,
  compactUnitVisible: quoteTransportRows.filter(
    (row) => row.compactGoldUnitPresent === true,
  ).length,
  compactCitationMetadataOnly: quoteTransportRows.filter(
    (row) =>
      row.compactGoldCitationListed === true &&
      row.compactGoldQuotePresent !== true,
  ).length,
  quoteOnPublishedContinuation: quoteTransportRows.filter(
    (row) => row.goldQuoteInContinuation === true,
  ).length,
  lostWithoutContinuation: quoteTransportRows.filter(
    (row) =>
      row.compactGoldQuotePresent !== true &&
      row.goldQuoteInContinuation !== true,
  ).length,
  byLanguage: Object.fromEntries(
    (["en", "es"] as const).map((language) => {
      const subset = quoteTransportRows.filter(
        (row) => row.language === language,
      );
      return [
        language,
        {
          positives: subset.length,
          compactLiteralQuoteVisible: subset.filter(
            (row) => row.compactGoldQuotePresent === true,
          ).length,
          continuationLiteralQuoteVisible: subset.filter(
            (row) => row.goldQuoteInContinuation === true,
          ).length,
        },
      ];
    }),
  ),
};
const report = {
  schemaVersion: "akp.s2.pre-admission-context-tokens.v1",
  evidenceLevel: "PINNED_TARGET_TOKENIZER_AUTHORIZED_E5_SYNTHETIC_SHADOW",
  assessment: "PRE_ADMISSION_CONTEXT_FOOTPRINT_ONLY",
  executedCommitSha: recorded.branchHeadSha,
  sourceGitBlobSha1: frozenBlob,
  retrievedEvidenceSha256: sha256(reportBytes),
  targetModelTokenizer: { model, revision, quality: "EXACT" },
  queryCount: rows.length,
  pairedAgainstSameQuestions: true,
  selectedWithoutGoldLabels: true,
  modelChatTemplateApplied: false,
  realUserAnswerMeasured: false,
  evidenceAdmissionMeasured: false,
  independentAdjudication: false,
  preAdmissionStatusesExplicitlyDegraded: true,
  compactCitationsRestrictedToVisibleContent: true,
  productionDefaultsChanged: false,
  gateAccepted: false,
  interpretation:
    "Token counts describe pre-admission synthetic source transport and test-only ContextPacket projections. Top-k is not sufficient evidence; no admitted citation precision, task success, Obsidian comparison, or production latency has been measured.",
  distributions,
  quoteTransport,
  sourceUnitTransport,
  rows,
};
await mkdir(path.dirname(outputFile), { recursive: true });
await writeFile(outputFile, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(
  JSON.stringify({
    status: "MEASURED_PRE_ADMISSION_ONLY",
    observations: rows.length,
    fullMedian: distributions.fullContextPacketWireTokens?.median,
    compactMedian: distributions.compactContextPacketWireTokens?.median,
    compactLiteralQuoteVisible: quoteTransport.compactQuoteVisible,
    output: outputFile,
    gateAccepted: false,
  }),
);
