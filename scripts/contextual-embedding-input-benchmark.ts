import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  LocalSemanticEmbeddingAdapter,
  embeddingPassageText,
  withEmbeddingPassageContext,
} from "../packages/retrieval/src/index.js";
import {
  loadEvidenceAdmissionPack,
  type Split,
} from "./evidence-admission-pack.js";

// Fresh model inference over an authorized synthetic corpus; no gold label,
// query expansion or support decision enters vector scoring.
const { cases } = await loadEvidenceAdmissionPack();
const units = [
  ...new Map(
    cases.flatMap((entry) =>
      entry.domain.units.map(
        (unit) =>
          [
            `${entry.domain.id}/${unit.id}`,
            { key: `${entry.domain.id}/${unit.id}`, unit },
          ] as const,
      ),
    ),
  ).values(),
];
const provider = new LocalSemanticEmbeddingAdapter({
  ...(process.env.AKP_MODEL_CACHE_DIR
    ? { cacheDir: process.env.AKP_MODEL_CACHE_DIR }
    : {}),
  localFilesOnly: process.env.AKP_LOCAL_FILES_ONLY === "1",
  maxBatchSize: 8,
});
const contextual = withEmbeddingPassageContext(provider, "title-heading-v1");
const corpusHash = createHash("sha256")
  .update(
    JSON.stringify(
      cases.map((entry) => ({
        domain: entry.domain.id,
        split: entry.domain.split,
        units: entry.domain.units,
        question: entry.question,
      })),
    ),
  )
  .digest("hex");
const windows = [1, 5, 10, 20, 64] as const;
try {
  const raw = await provider.embed(
    units.map(({ unit }) => unit.text),
    "passage",
  );
  const context = await contextual.embed(
    units.map(({ unit }) =>
      embeddingPassageText(
        {
          body: unit.text,
          title: unit.title,
          headingPath: unit.headingPath,
        },
        contextual.descriptor.inputStrategy,
      ),
    ),
    "passage",
  );
  const queries = await provider.embed(
    cases.map((entry) => entry.question.query),
    "query",
  );
  function summarize(vectors: number[][], split: Split) {
    const selected = cases.flatMap((entry, index) =>
      entry.domain.split === split && entry.question.gold.length > 0
        ? [{ entry, index }]
        : [],
    );
    const found = Object.fromEntries(windows.map((k) => [k, 0]));
    let reciprocalRanks = 0;
    for (const { entry, index } of selected) {
      const gold = new Set(
        entry.question.gold.map((id) => `${entry.domain.id}/${id}`),
      );
      const ranked = units
        .map((unit, i) => ({
          key: unit.key,
          score: vectors[i]!.reduce(
            (sum, value, j) => sum + value * queries[index]![j]!,
            0,
          ),
        }))
        .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key));
      const rank = ranked.findIndex((unit) => gold.has(unit.key)) + 1;
      if (rank > 0) {
        reciprocalRanks += 1 / rank;
        for (const k of windows) if (rank <= k) found[k]!++;
      }
    }
    return {
      split,
      positiveQuestions: selected.length,
      goldUnitRecallCounts: found,
      goldUnitRecall: Object.fromEntries(
        windows.map((k) => [
          k,
          selected.length ? found[k]! / selected.length : null,
        ]),
      ),
      meanReciprocalRank: selected.length
        ? reciprocalRanks / selected.length
        : null,
    };
  }
  const report = {
    schemaVersion: 1,
    scope: "RETRIEVAL_ONLY",
    productionDefaultsChanged: false,
    inference: "FRESH",
    corpusHash,
    corpusUnits: units.length,
    splitIndependence: "DOMAIN_SOURCE_DISJOINT_NOT_QUESTION_FAMILY_DISJOINT",
    arms: [
      {
        descriptor: provider.descriptor,
        results: [summarize(raw, "development"), summarize(raw, "heldout")],
      },
      {
        descriptor: contextual.descriptor,
        results: [
          summarize(context, "development"),
          summarize(context, "heldout"),
        ],
      },
    ],
    limitation:
      "Recall does not establish answer support or citation precision; corpus is synthetic and small.",
  };
  const output = path.resolve(
    process.env.AKP_EMBEDDING_CONTEXT_REPORT ??
      "reports/ci/contextual-embedding-input.json",
  );
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(report, null, 2));
} finally {
  await provider.dispose();
}
