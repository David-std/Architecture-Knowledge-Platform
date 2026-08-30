import { readFile } from "node:fs/promises";
import path from "node:path";
import type { GoldCase } from "./dataset.js";
import type {
  BenchmarkConfiguration,
  BenchmarkObservation,
  BenchmarkRunMetrics,
} from "./benchmark.js";
import {
  aggregateBenchmarkRun,
  RETRIEVAL_BENCHMARK_MATRIX,
  selectBenchmarkDefault,
} from "./benchmark.js";

export interface CuratedFixtureDocument {
  id: string;
  vault: string;
  title: string;
  aliases: string[];
  body: string;
  related: string[];
  evidence: string[];
  citations: string[];
}

export interface CuratedFixturePack {
  schemaVersion: 1;
  evidenceLevel: "CURATED_FIXTURE";
  name: string;
  documents: CuratedFixtureDocument[];
}

export interface CuratedFixtureManifest {
  schemaVersion: 1;
  evidenceLevel: "CURATED_FIXTURE";
  name: string;
  vaults: Array<{
    id: string;
    kind: string;
    documents: Array<Omit<CuratedFixtureDocument, "vault">>;
  }>;
}

export interface CuratedBenchmarkReport {
  schemaVersion: "akp.retrieval.curated-benchmark.v1";
  status: "IMPLEMENTED_AND_EXECUTED";
  evidenceLevel: "CURATED_FIXTURE";
  qualityClaim: "NONE";
  provider: {
    mode: "curated-local";
    readsPrivateVault: false;
    readsDatabase: false;
  };
  generatedAt: string;
  pack: string;
  vaults: string[];
  caseCount: number;
  matrixSize: number;
  vectorDisabled: {
    requestedChannels: readonly ["exact", "lexical", "vector"];
    effectiveChannels: readonly ["exact", "lexical"];
    vectorInvoked: false;
  };
  runs: BenchmarkRunMetrics[];
  measuredSelection: ReturnType<typeof selectBenchmarkDefault>;
  productionDefault: { selected: null; reason: string };
  limitations: string[];
}

const safePackName = /^[a-z0-9][a-z0-9-]{1,62}$/;
const stopWords = new Set([
  "a",
  "an",
  "and",
  "are",
  "after",
  "by",
  "como",
  "de",
  "el",
  "en",
  "for",
  "from",
  "how",
  "is",
  "la",
  "of",
  "on",
  "the",
  "to",
  "una",
  "which",
  "with",
]);

function tokens(value: string): string[] {
  return [
    ...new Set(
      value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLocaleLowerCase()
        .match(/[\p{Letter}\p{Number}]+/gu)
        ?.filter((token) => token.length > 1 && !stopWords.has(token)) ?? [],
    ),
  ];
}

function asStringArray(
  value: unknown,
  field: string,
  source: string,
): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry) => typeof entry === "string")
  ) {
    throw new Error(`Invalid ${field} in curated fixture ${source}.`);
  }
  return [...new Set(value)];
}

function parseDocument(
  value: unknown,
  vault: string,
  source: string,
): CuratedFixtureDocument {
  if (!value || typeof value !== "object")
    throw new Error(`Invalid curated document in ${source}.`);
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.id !== "string" ||
    typeof candidate.title !== "string" ||
    typeof candidate.body !== "string"
  ) {
    throw new Error(`Invalid curated document identity in ${source}.`);
  }
  return {
    id: candidate.id,
    vault,
    title: candidate.title,
    aliases: asStringArray(candidate.aliases ?? [], "aliases", source),
    body: candidate.body,
    related: asStringArray(candidate.related ?? [], "related", source),
    evidence: asStringArray(candidate.evidence ?? [], "evidence", source),
    citations: asStringArray(candidate.citations ?? [], "citations", source),
  };
}

/** Load only a checked-in, small curated manifest; no private vault is read. */
export async function loadCuratedFixture(
  repositoryRoot: string,
  packName = "curated-level-b",
): Promise<CuratedFixturePack> {
  if (!safePackName.test(packName))
    throw new Error(`Invalid curated fixture pack name: ${packName}`);
  const nestedRelativePath = path.join(
    "evals",
    "fixtures",
    packName,
    "manifest.json",
  );
  const flatRelativePath = path.join(
    "evals",
    "fixtures",
    `${packName}-manifest.json`,
  );
  let relativePath = nestedRelativePath;
  let source = path.join(repositoryRoot, relativePath);
  let serialized: string;
  try {
    serialized = await readFile(source, "utf8");
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
    relativePath = flatRelativePath;
    source = path.join(repositoryRoot, relativePath);
    serialized = await readFile(source, "utf8");
  }
  const value = JSON.parse(serialized) as unknown;
  if (!value || typeof value !== "object")
    throw new Error(`Invalid curated fixture manifest: ${relativePath}`);
  const manifest = value as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.evidenceLevel !== "CURATED_FIXTURE" ||
    typeof manifest.name !== "string" ||
    manifest.name !== packName ||
    !Array.isArray(manifest.vaults)
  ) {
    throw new Error(`Invalid curated fixture manifest: ${relativePath}`);
  }
  const documents: CuratedFixtureDocument[] = [];
  const ids = new Set<string>();
  for (const [index, rawVault] of manifest.vaults.entries()) {
    if (!rawVault || typeof rawVault !== "object")
      throw new Error(`Invalid curated vault ${index} in ${relativePath}.`);
    const vault = rawVault as Record<string, unknown>;
    if (
      typeof vault.id !== "string" ||
      typeof vault.kind !== "string" ||
      !Array.isArray(vault.documents)
    ) {
      throw new Error(`Invalid curated vault ${index} in ${relativePath}.`);
    }
    for (const [documentIndex, rawDocument] of vault.documents.entries()) {
      const document = parseDocument(
        rawDocument,
        vault.id,
        `${relativePath}:vault[${index}].documents[${documentIndex}]`,
      );
      if (ids.has(document.id))
        throw new Error(`Duplicate curated document id: ${document.id}`);
      ids.add(document.id);
      documents.push(document);
    }
  }
  const documentIds = new Set(documents.map((document) => document.id));
  for (const document of documents) {
    for (const related of document.related) {
      if (!documentIds.has(related)) {
        throw new Error(
          `Curated relation ${document.id} -> ${related} has no target.`,
        );
      }
    }
  }
  return {
    schemaVersion: 1,
    evidenceLevel: "CURATED_FIXTURE",
    name: manifest.name,
    documents,
  };
}

function includesPhrase(query: string, phrase: string): boolean {
  const queryTokens = tokens(query);
  const phraseTokens = tokens(phrase);
  if (phraseTokens.length === 0 || phraseTokens.length > queryTokens.length)
    return false;
  return queryTokens.some((_, start) =>
    phraseTokens.every(
      (token, offset) => queryTokens[start + offset] === token,
    ),
  );
}

function lexicalScore(query: string, document: CuratedFixtureDocument): number {
  const queryTokens = new Set(tokens(query));
  if (queryTokens.size === 0) return 0;
  const documentTokens = new Set(
    tokens(
      [document.id, document.title, ...document.aliases, document.body].join(
        " ",
      ),
    ),
  );
  return [...queryTokens].filter((token) => documentTokens.has(token)).length;
}

/**
 * Execute a deterministic local retrieval probe over curated documents.
 * This is deliberately shallow (token overlap and explicit relations) and
 * must not be presented as production retrieval-quality evidence.
 */
export function rankCuratedCase(
  fixture: CuratedFixturePack,
  testCase: GoldCase,
  configuration: BenchmarkConfiguration,
  options: { vectorEnabled?: boolean } = {},
): BenchmarkObservation {
  const allowed = fixture.documents.filter(
    (document) => !testCase.vault || document.vault === testCase.vault,
  );
  const scores = new Map<string, number>();
  const seeds = new Set<string>();
  for (const document of allowed) {
    const query = testCase.query.toLocaleLowerCase();
    const idMatch = query.includes(document.id.toLocaleLowerCase());
    const titleMatch = includesPhrase(query, document.title);
    const aliasMatch = document.aliases.some((alias) =>
      includesPhrase(query, alias),
    );
    const lexical = lexicalScore(testCase.query, document);
    let score = 0;
    if (configuration.channels.includes("exact")) {
      if (idMatch) score += 100;
      else if (titleMatch) score += 80;
      else if (aliasMatch) score += 70;
    }
    if (
      configuration.channels.includes("lexical") ||
      configuration.channels.includes("context-pack")
    ) {
      score += lexical;
    }
    if (configuration.channels.includes("vector") && options.vectorEnabled) {
      // A tiny deterministic lexical proxy keeps this local probe honest: it
      // exercises channel gating but does not claim to be an embedding.
      score += lexical * 0.01;
    }
    // Graph retrieval still needs a lexical seed, mirroring the runtime
    // adapter's graph-only plan.  The seed itself gets a small score while
    // its explicitly related documents receive the graph contribution.
    if (score > 0 || (configuration.channels.includes("graph") && lexical > 0))
      seeds.add(document.id);
    if (
      score === 0 &&
      configuration.channels.includes("graph") &&
      lexical > 0
    ) {
      score = 0.5;
    }
    if (score > 0) scores.set(document.id, score);
  }
  if (configuration.channels.includes("graph") && seeds.size > 0) {
    for (const document of allowed) {
      if (document.related.some((related) => seeds.has(related))) {
        scores.set(document.id, Math.max(scores.get(document.id) ?? 0, 2));
      }
    }
  }
  const ranked = [...scores.entries()]
    .sort(
      ([leftId, leftScore], [rightId, rightScore]) =>
        rightScore - leftScore || leftId.localeCompare(rightId),
    )
    .map(([id]) => id)
    .slice(0, 10);
  const byId = new Map(allowed.map((document) => [document.id, document]));
  const retrievedEvidence = [
    ...new Set(ranked.flatMap((id) => byId.get(id)?.evidence ?? [])),
  ];
  const retrievedCitations = [
    ...new Set(ranked.flatMap((id) => byId.get(id)?.citations ?? [])),
  ];
  return {
    configurationName: configuration.name,
    caseId: testCase.id,
    slice: testCase.slice ?? testCase.category,
    rankedDocumentIds: ranked,
    goldDocumentIds: [...testCase.gold_documents],
    ...(testCase.must_not_include
      ? { mustNotInclude: [...testCase.must_not_include] }
      : {}),
    ...(testCase.expect_no_answer !== undefined
      ? { expectNoAnswer: testCase.expect_no_answer }
      : {}),
    ...(testCase.gold_evidence
      ? {
          goldEvidenceIds: [...testCase.gold_evidence],
          retrievedEvidenceIds: retrievedEvidence,
        }
      : {}),
    ...(testCase.gold_citations
      ? {
          goldCitationIds: [...testCase.gold_citations],
          retrievedCitationIds: retrievedCitations,
        }
      : {}),
    returnedAnswer: ranked.length > 0,
    estimatedTokens: ranked.reduce(
      (sum, id) => sum + Math.ceil((byId.get(id)?.body.length ?? 0) / 4),
      0,
    ),
    latencyMs: 1 + configuration.channels.length,
    ...(testCase.critical === undefined ? {} : { critical: testCase.critical }),
  };
}

export function buildCuratedBenchmarkReport(
  fixture: CuratedFixturePack,
  cases: readonly GoldCase[],
  input: { generatedAt?: string } = {},
): CuratedBenchmarkReport {
  const runs = RETRIEVAL_BENCHMARK_MATRIX.map((configuration) =>
    aggregateBenchmarkRun(
      configuration,
      cases.map((testCase) =>
        rankCuratedCase(fixture, testCase, configuration, {
          vectorEnabled: Boolean(configuration.allowVectorForBenchmark),
        }),
      ),
    ),
  );
  return {
    schemaVersion: "akp.retrieval.curated-benchmark.v1",
    status: "IMPLEMENTED_AND_EXECUTED",
    evidenceLevel: "CURATED_FIXTURE",
    qualityClaim: "NONE",
    provider: {
      mode: "curated-local",
      readsPrivateVault: false,
      readsDatabase: false,
    },
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    pack: fixture.name,
    vaults: [
      ...new Set(fixture.documents.map((document) => document.vault)),
    ].sort(),
    caseCount: cases.length,
    matrixSize: RETRIEVAL_BENCHMARK_MATRIX.length,
    vectorDisabled: {
      requestedChannels: ["exact", "lexical", "vector"],
      effectiveChannels: ["exact", "lexical"],
      vectorInvoked: false,
    },
    runs,
    measuredSelection: selectBenchmarkDefault(runs),
    productionDefault: {
      selected: null,
      reason:
        "Curated local fixtures exercise retrieval behavior but do not justify a production default; require a captured or real indexed benchmark.",
    },
    limitations: [
      "This is a small checked-in Level B fixture and makes no production retrieval-quality claim.",
      "No private vault, PostgreSQL index or external embedding provider was read.",
      "Vector-enabled rows use a deterministic lexical proxy only; vector-disabled behavior is separately asserted.",
    ],
  };
}
