/**
 * S2 evidence report runner: consumes recorded executions only. It never
 * fabricates a baseline, reruns a question, changes ranking or promotes policy.
 *
 * pnpm exec tsx scripts/s2-score-observations.ts \
 *   --observations /path/to/real-measurements.json \
 *   --output reports/ci/s2-span-observations.json
 */
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  scoreS2SpanObservations,
  type S2SpanFixture,
  type S2SpanObservation,
} from "../packages/evaluation/src/s2-source-span.js";

interface RecordedRun {
  schemaVersion: "akp.s2.recorded-source-span-run.v1";
  corpusGitBlobSha1: string;
  sourceSha256: Record<string, string>;
  executedCommitSha: string;
  scopedRetrievalConfiguration: string;
  method: "AKP_CURRENT" | "PAIRED_MANUAL_SEARCH" | "FIXED_READER_COMPARATOR";
  observations: S2SpanObservation[];
}

const frozenBlobSha1 = "a61a24df46c0351115cd09e079ae0d8383033082";
const root = path.resolve(import.meta.dirname, "..");
const flag = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const source = flag("--observations");
if (!source) {
  throw new Error("S2_EXPLICIT_OBSERVATIONS_FILE_REQUIRED");
}
const target = path.resolve(
  root,
  flag("--output") ?? "reports/ci/s2-span-observations.json",
);
const datasetPath = path.join(
  root,
  "evals/registered/s2-source-span-holdout.json",
);
const rawDataset = await readFile(datasetPath);
const gitBlob = createHash("sha1")
  .update("blob " + rawDataset.byteLength + "\0")
  .update(rawDataset)
  .digest("hex");
if (gitBlob !== frozenBlobSha1) {
  throw new Error("S2_FROZEN_DATASET_CHANGED");
}
const fixture = JSON.parse(rawDataset.toString("utf8")) as S2SpanFixture;
const recorded = JSON.parse(
  await readFile(path.resolve(source), "utf8"),
) as RecordedRun;
if (
  recorded.schemaVersion !== "akp.s2.recorded-source-span-run.v1" ||
  recorded.corpusGitBlobSha1 !== frozenBlobSha1 ||
  !/^[a-f0-9]{40}$/.test(recorded.executedCommitSha ?? "") ||
  typeof recorded.scopedRetrievalConfiguration !== "string" ||
  recorded.scopedRetrievalConfiguration.trim().length < 8 ||
  ![
    "AKP_CURRENT",
    "PAIRED_MANUAL_SEARCH",
    "FIXED_READER_COMPARATOR",
  ].includes(recorded.method) ||
  !Array.isArray(recorded.observations)
) {
  throw new Error("S2_RECORDED_RUN_IDENTITY_INCOMPLETE");
}
const sourceSha256 = Object.fromEntries(
  fixture.sourceDocuments.map((doc) => [
    doc.id,
    createHash("sha256")
      .update(
        doc.units.map((unit) => unit.id + "\n" + unit.text).join("\n\n"),
      )
      .digest("hex"),
  ]),
);
if (
  JSON.stringify(
    Object.entries(sourceSha256).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  ) !==
  JSON.stringify(
    Object.entries(recorded.sourceSha256 ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  )
) {
  throw new Error("S2_RECORDED_SOURCE_DIGESTS_NOT_FROZEN");
}
if (recorded.observations.length === 0) {
  throw new Error("S2_EMPTY_RUN_IS_NOT_A_MEASUREMENT");
}
const metrics = scoreS2SpanObservations(fixture, recorded.observations);
if (
  metrics.status === "PARTIAL_NOT_GATEABLE" &&
  !process.argv.includes("--allow-partial")
) {
  throw new Error(
    "S2_PARTIAL_RUN_REQUIRES_EXPLICIT_ALLOW_PARTIAL_AND_CANNOT_PASS_GATE",
  );
}
const report = {
  schemaVersion: "akp.s2.span-metrics.v1",
  measurementStatus: metrics.status,
  gateAccepted: false,
  independentAdjudication: false,
  methodologicalWarning:
    "Exact-gold-quote coverage is an intentionally strict oracle proxy, not adjudicated semantic evidence precision; no release gate can be passed by this report alone.",
  frozenGitBlobSha1: frozenBlobSha1,
  corpusSha256: createHash("sha256").update(rawDataset).digest("hex"),
  recordedRunSha256: createHash("sha256")
    .update(await readFile(path.resolve(source)))
    .digest("hex"),
  executedCommitSha: recorded.executedCommitSha,
  scopedRetrievalConfiguration: recorded.scopedRetrievalConfiguration,
  method: recorded.method,
  metrics,
};
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(
  JSON.stringify({
    status: metrics.status,
    report: target,
    observed: metrics.observedCases,
    total: metrics.totalCases,
    gateAccepted: false,
  }) + "\n",
);
