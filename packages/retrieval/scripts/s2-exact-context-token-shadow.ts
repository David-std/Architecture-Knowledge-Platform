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
    tokenizer: tokenizerPort,
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
  };
});
if (new Set(rows.map((row) => row.caseId)).size !== 48) {
  throw new Error("S2_TOKEN_DUPLICATE_OBSERVATIONS");
}
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
  productionDefaultsChanged: false,
  gateAccepted: false,
  interpretation:
    "Token counts describe pre-admission synthetic source transport and test-only ContextPacket projections. Top-k is not sufficient evidence; no admitted citation precision, task success, Obsidian comparison, or production latency has been measured.",
  distributions,
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
    output: outputFile,
    gateAccepted: false,
  }),
);
