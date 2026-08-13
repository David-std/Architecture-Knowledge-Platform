/**
 * Run the retrieval scorer and ten-configuration selection logic without a
 * database or the private Architecture Knowledge Vault.
 *
 * This is intentionally a synthetic logic harness.  It validates fixture
 * loading, slice coverage, metric arithmetic, vector-disabled policy and
 * default guardrails; it must never be interpreted as retrieval-quality
 * evidence for a real corpus.
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildOfflineBenchmarkReport,
  loadEvaluationPack,
} from "../packages/evaluation/src/index.js";

interface Arguments {
  repositoryRoot: string;
  outputPath: string;
  generatedAt?: string;
}

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseArguments(argv: string[]): Arguments {
  const repositoryRoot = path.resolve(
    argumentValue(argv, "--repo-root") ?? process.cwd(),
  );
  const outputPath = path.resolve(
    repositoryRoot,
    argumentValue(argv, "--output") ??
      "reports/retrieval/offline-benchmark.json",
  );
  const generatedAt = argumentValue(argv, "--generated-at");
  if (generatedAt !== undefined && Number.isNaN(Date.parse(generatedAt))) {
    throw new Error(`Invalid --generated-at ISO timestamp: ${generatedAt}`);
  }
  return {
    repositoryRoot,
    outputPath,
    ...(generatedAt === undefined ? {} : { generatedAt }),
  };
}

async function jsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.endsWith(".jsonl"))
        files.push(absolute);
    }
  };
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function hashDataset(root: string): Promise<{
  datasetHash: string;
  files: Record<string, string>;
}> {
  const files = await jsonlFiles(root);
  const entries: Array<{ relativePath: string; hash: string }> = [];
  for (const file of files) {
    const bytes = await readFile(file);
    entries.push({
      relativePath: path
        .relative(path.dirname(root), file)
        .split(path.sep)
        .join("/"),
      hash: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const aggregate = createHash("sha256");
  const hashes: Record<string, string> = {};
  for (const entry of entries) {
    aggregate.update(entry.relativePath, "utf8");
    aggregate.update("\u0000", "utf8");
    aggregate.update(entry.hash, "utf8");
    aggregate.update("\n", "utf8");
    hashes[entry.relativePath] = entry.hash;
  }
  return { datasetHash: aggregate.digest("hex"), files: hashes };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const datasetRoot = path.join(options.repositoryRoot, "evals", "generic");
  const cases = await loadEvaluationPack(options.repositoryRoot, "generic");
  const dataset = await hashDataset(datasetRoot);
  const runnerPath = fileURLToPath(import.meta.url);
  const runnerHash = createHash("sha256")
    .update(await readFile(runnerPath))
    .digest("hex");
  const report = buildOfflineBenchmarkReport(cases, {
    datasetRoot: "evals/generic",
    datasetHash: dataset.datasetHash,
    datasetFiles: dataset.files,
    runnerHash,
    ...(options.generatedAt === undefined
      ? {}
      : { generatedAt: options.generatedAt }),
  });
  await mkdir(path.dirname(options.outputPath), { recursive: true });
  await writeFile(
    options.outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({
      status: report.status,
      evidenceLevel: report.evidenceLevel,
      output: path.relative(options.repositoryRoot, options.outputPath),
      datasetHash: report.input.datasetHash,
      cases: report.input.caseCount,
      matrixSize: report.matrix.size,
      selectedSyntheticDefault: report.measuredSelection.selectedDefault,
      productionDefault: report.productionDefault.selected,
      vectorActivatedByDefault:
        report.measuredSelection.vectorActivatedByDefault,
    })}\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
}
