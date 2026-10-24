import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  evidenceAdmissionReport,
  loadEvidenceAdmissionPack,
} from "../../../scripts/evidence-admission-pack.js";
import {
  SOURCE_SELECTION_PROTOCOLS,
  validateSourceSelectionShards,
  sourceSelectionMeasurement,
  type SourceSelectionShard,
  type SourceSelectionStats,
} from "./evidence-source-selection-contract.js";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const root = path.join(repositoryRoot, "reports/ci/shards");
const files = (await readdir(root))
  .filter((name) => /^source-selection-shard-\d+\.json$/u.test(name))
  .sort();
const reports = await Promise.all(
  files.map(
    async (name) =>
      JSON.parse(
        await readFile(path.join(root, name), "utf8"),
      ) as SourceSelectionShard,
  ),
);
const { cases } = await loadEvidenceAdmissionPack(["development"]);
validateSourceSelectionShards(reports, cases);
const currentMeasurement = await sourceSelectionMeasurement(cases, {});
if (reports[0]!.measurement.runtimeHash !== currentMeasurement.runtimeHash)
  throw new Error("SOURCE_SELECTION_RUNTIME_MISMATCH");
const arms = Object.fromEntries(
  SOURCE_SELECTION_PROTOCOLS.map((protocol) => {
    const rows = reports.flatMap((report) => report.arms[protocol].rows);
    const stats = reports
      .map((report) => report.arms[protocol].stats)
      .reduce(
        (sum, value): SourceSelectionStats => ({
          calls: sum.calls + value.calls,
          timeMs: sum.timeMs + value.timeMs,
          providerErrors: sum.providerErrors + value.providerErrors,
          parseErrors: sum.parseErrors + value.parseErrors,
          invalidSelections: sum.invalidSelections + value.invalidSelections,
        }),
        {
          calls: 0,
          timeMs: 0,
          providerErrors: 0,
          parseErrors: 0,
          invalidSelections: 0,
        },
      );
    return [
      protocol,
      { report: evidenceAdmissionReport(rows, protocol), stats },
    ];
  }),
) as Record<
  (typeof SOURCE_SELECTION_PROTOCOLS)[number],
  {
    report: ReturnType<typeof evidenceAdmissionReport>;
    stats: SourceSelectionStats;
  }
>;
const quote = arms["quote-v4"].report.development;
const selection = arms["source-selection-v1"].report.development;
function delta(left: number | null, right: number | null): number | null {
  return left === null || right === null ? null : left - right;
}
const output = {
  schemaVersion: 2,
  benchmark: "EVIDENCE_SOURCE_SELECTION_AB",
  split: "development",
  questions: cases.length,
  claimPolicy: {
    heldoutInspected: false,
    questionFamilyDisjoint: false,
    candidatesProvided: true,
    winnerDeclared: false,
    purpose:
      "Development-only paired admission comparison; source coordinates do not establish answer meaning.",
  },
  model: reports[0]!.model,
  measurement: reports[0]!.measurement,
  arms,
  deltas: {
    answerableRecall: delta(selection.answerableRecall, quote.answerableRecall),
    falseAcceptanceRate: delta(
      selection.falseAcceptanceRate,
      quote.falseAcceptanceRate,
    ),
    admittedPrecision: delta(
      selection.admittedPrecision,
      quote.admittedPrecision,
    ),
    strictAccuracy: delta(selection.strictAccuracy, quote.strictAccuracy),
  },
};
const target = path.join(
  repositoryRoot,
  "reports/ci/source-selection-development-ab.json",
);
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(output, null, 2));
console.log(
  JSON.stringify(
    {
      quote,
      selection,
      deltas: output.deltas,
      quoteStats: arms["quote-v4"].stats,
      selectionStats: arms["source-selection-v1"].stats,
    },
    null,
    2,
  ),
);
