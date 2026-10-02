import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadEvidenceAdmissionPack } from "../../../scripts/evidence-admission-pack.js";
import {
  ContextualCrossEncoderEvidenceVerifier,
  contextualEvidenceText,
  retrievalAnswerabilityCandidateKey,
  type QueryConditionedEvidenceVerifierInput,
} from "../src/index.js";
import {
  CROSS_ENCODER_RECORDING_CONFIGURATION,
  evidenceScoreInputHash,
} from "../../../scripts/evidence-admission-recordings.js";

const verifier = new ContextualCrossEncoderEvidenceVerifier({
  minimumSupportScore: 0.5,
  maxTokens: CROSS_ENCODER_RECORDING_CONFIGURATION.maxTokens,
  batchSize: CROSS_ENCODER_RECORDING_CONFIGURATION.batchSize,
});
const { cases } = await loadEvidenceAdmissionPack(["development"]);
const rows: unknown[] = [];
const started = performance.now();
try {
  for (const [index, entry] of cases.entries()) {
    const inputs: QueryConditionedEvidenceVerifierInput[] = entry.hits.map((hit) => ({
      query: entry.question.query,
      candidateKey: retrievalAnswerabilityCandidateKey(hit),
      title: hit.title,
      ...(hit.headingPath ? { headingPath: hit.headingPath } : {}),
      passage: hit.excerpt,
      unitType: hit.unitType ?? null,
      parentUnitType: null,
      documentType: hit.type,
    }));
    const contextual = await verifier.scoreBatch(inputs);
    const plain = await verifier.scoreBatch(
      inputs.map((input) => ({ ...input, title: "", headingPath: [] })),
    );
    entry.hits.forEach((hit, position) => {
      rows.push({
        questionId: entry.question.id,
        split: entry.domain.split,
        unitId: hit.document.externalId,
        contextualInputHash: evidenceScoreInputHash(
          entry.question.query,
          contextualEvidenceText({
            title: hit.title,
            headingPath: hit.headingPath ?? null,
            passage: hit.excerpt,
          }).text,
        ),
        plainInputHash: evidenceScoreInputHash(
          entry.question.query,
          contextualEvidenceText({
            title: "",
            headingPath: [],
            passage: hit.excerpt,
          }).text,
        ),
        contextual: contextual[position],
        plain: plain[position],
      });
    });
    if ((index + 1) % 20 === 0) console.error(String(index + 1) + "/" + String(cases.length));
  }
} finally {
  await verifier.dispose();
}
const output = path.resolve("reports/ci/source-selection-scores.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({
  schemaVersion: 2,
  verifier: verifier.id,
  configuration: CROSS_ENCODER_RECORDING_CONFIGURATION,
  rows,
  split: "development",
  questions: cases.length,
  elapsedMs: performance.now() - started,
}));
