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

/**
 * Scores every question against every unit of its domain once, with and
 * without the unit title/headings, so admission policies can be compared
 * offline. Scores are diagnostics; the admission decision is evaluated by
 * the generalization benchmark.
 */
const verifier = new ContextualCrossEncoderEvidenceVerifier({
  minimumSupportScore: 0.5,
  maxTokens: CROSS_ENCODER_RECORDING_CONFIGURATION.maxTokens,
  batchSize: CROSS_ENCODER_RECORDING_CONFIGURATION.batchSize,
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
  ...(process.env.AKP_MODEL_CACHE_DIR
    ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
    : {}),
});
const { cases } = await loadEvidenceAdmissionPack();
const rows: unknown[] = [];
const started = performance.now();
try {
  for (const [index, entry] of cases.entries()) {
    const inputs: QueryConditionedEvidenceVerifierInput[] = entry.hits.map(
      (hit) => ({
        query: entry.question.query,
        candidateKey: retrievalAnswerabilityCandidateKey(hit),
        title: hit.title,
        ...(hit.headingPath ? { headingPath: hit.headingPath } : {}),
        passage: hit.excerpt,
        unitType: hit.unitType ?? null,
        parentUnitType: null,
        documentType: hit.type,
      }),
    );
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
    if ((index + 1) % 20 === 0) {
      console.error(
        `${index + 1}/${cases.length} questions in ${((performance.now() - started) / 1000).toFixed(0)}s`,
      );
    }
  }
} finally {
  await verifier.dispose();
}
const outputPath = path.resolve(
  process.env.AKP_CONTEXTUAL_EVIDENCE_SCORES ??
    "reports/ci/contextual-evidence-pack-scores.json",
);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(
  outputPath,
  JSON.stringify({
    schemaVersion: 2,
    verifier: verifier.id,
    configuration: CROSS_ENCODER_RECORDING_CONFIGURATION,
    rows,
  }),
);
console.error(
  `scored ${rows.length} pairs in ${((performance.now() - started) / 1000).toFixed(0)}s`,
);
