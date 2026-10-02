import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
import { evidenceAdmissionReport, type QuestionResult } from "../../../scripts/evidence-admission-pack.js";

const root = path.join(repositoryRoot, "reports/ci/shards");
const files = (await readdir(root)).filter((name) => /^source-selection-shard-\d+\.json$/u.test(name)).sort();
if (files.length !== 4) throw new Error("Expected four source-selection shards.");
const reports = await Promise.all(files.map(async (name) => JSON.parse(await readFile(path.join(root, name), "utf8"))));
const protocols = ["quote-v4", "source-selection-v1"] as const;
const arms: Record<string, unknown> = {};
for (const protocol of protocols) {
  const rows = reports.flatMap((report) => report.arms[protocol].rows) as QuestionResult[];
  if (rows.length !== 133 || new Set(rows.map((row) => row.id)).size !== 133) throw new Error(protocol + " did not cover all 133 development questions exactly once.");
  const stats = reports.map((report) => report.arms[protocol].stats).reduce((sum, value) => ({
    calls: sum.calls + value.calls,
    timeMs: sum.timeMs + value.timeMs,
    providerErrors: sum.providerErrors + value.providerErrors,
    parseErrors: sum.parseErrors + value.parseErrors,
    invalidSelections: sum.invalidSelections + value.invalidSelections,
  }), { calls: 0, timeMs: 0, providerErrors: 0, parseErrors: 0, invalidSelections: 0 });
  arms[protocol] = { report: evidenceAdmissionReport(rows, protocol), stats };
}
const quote = (arms["quote-v4"] as any).report.development;
const selection = (arms["source-selection-v1"] as any).report.development;
const output = {
  schemaVersion: 1,
  benchmark: "EVIDENCE_SOURCE_SELECTION_AB",
  split: "development",
  questions: 133,
  claimPolicy: {
    heldoutInspected: false,
    winnerDeclared: false,
    purpose: "Compare exact quote generation with structural source-range selection before any product change.",
  },
  model: reports[0].model,
  arms,
  deltas: {
    answerableRecall: selection.answerableRecall - quote.answerableRecall,
    falseAcceptanceRate: selection.falseAcceptanceRate - quote.falseAcceptanceRate,
    admittedPrecision: selection.admittedPrecision - quote.admittedPrecision,
    strictAccuracy: selection.strictAccuracy - quote.strictAccuracy,
  },
};
const target = path.join(repositoryRoot, "reports/ci/source-selection-development-ab.json");
await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(output, null, 2));
console.log(JSON.stringify({ quote, selection, deltas: output.deltas, quoteStats: (arms["quote-v4"] as any).stats, selectionStats: (arms["source-selection-v1"] as any).stats }, null, 2));
