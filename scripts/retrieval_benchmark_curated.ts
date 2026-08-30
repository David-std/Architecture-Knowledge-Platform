/**
 * Execute the small Level B curated retrieval fixture without a database or
 * the private Architecture Knowledge Vault.  The report is executable
 * behavior evidence, not a production quality claim.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildCuratedBenchmarkReport,
  loadCuratedFixture,
  loadEvaluationPack,
} from "../packages/evaluation/src/index.js";

function argumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repositoryRoot = path.resolve(
    argumentValue(argv, "--repo-root") ?? process.cwd(),
  );
  const pack = argumentValue(argv, "--pack") ?? "curated-level-b";
  const output = path.resolve(
    repositoryRoot,
    argumentValue(argv, "--output") ??
      "reports/retrieval/curated-benchmark.json",
  );
  const stdoutOnly = argv.includes("--stdout");
  const generatedAt = argumentValue(argv, "--generated-at");
  if (generatedAt !== undefined && Number.isNaN(Date.parse(generatedAt))) {
    throw new Error(`Invalid --generated-at ISO timestamp: ${generatedAt}`);
  }
  const fixture = await loadCuratedFixture(repositoryRoot, pack);
  const cases = await loadEvaluationPack(repositoryRoot, pack);
  const report = buildCuratedBenchmarkReport(fixture, cases, {
    ...(generatedAt === undefined ? {} : { generatedAt }),
  });
  if (!stdoutOnly) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  process.stdout.write(
    `${JSON.stringify(
      stdoutOnly
        ? report
        : {
            status: report.status,
            evidenceLevel: report.evidenceLevel,
            pack: report.pack,
            cases: report.caseCount,
            matrixSize: report.matrixSize,
            output: path.relative(repositoryRoot, output),
            productionDefault: report.productionDefault.selected,
          },
    )}\n`,
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
