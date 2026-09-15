import "dotenv/config";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { AutoTokenizer } from "@huggingface/transformers";
import {
  buildContextPacket,
  type PacketCandidate,
  type Tokenizer,
} from "../src/index.js";

type TokenizationRegressionCase = {
  id: string;
  kind: "TOKENIZATION_AND_EXACT_IDENTIFIER";
  samples: {
    english: string;
    spanish: string;
    code: string;
  };
  identifiers: string[];
};

type RegressionPack = {
  schemaVersion: number;
  evidenceLevel: string;
  productionDefaultsChanged: boolean;
  cases: Array<Record<string, unknown>>;
};

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const model =
  process.env.AKP_CONTEXT_TOKENIZER_MODEL ??
  process.env.AKP_LOCAL_AGENT_MODEL ??
  "onnx-community/Qwen2.5-0.5B-Instruct";
const revision =
  process.env.AKP_CONTEXT_TOKENIZER_REVISION ??
  process.env.AKP_LOCAL_AGENT_MODEL_REVISION ??
  "cc5cc01a65cc3ff17bdb73a7de33d879f62599b0";
const fixturePath = path.join(
  repositoryRoot,
  "evals",
  "registered",
  "context-correctness-regressions.json",
);
const outputPath = path.resolve(
  repositoryRoot,
  process.env.AKP_CONTEXT_TOKENIZER_REPORT ??
    "reports/ci/context-tokenizer-baseline.json",
);

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function loadTokenizationCase(): Promise<{
  raw: string;
  file: RegressionPack;
  testCase: TokenizationRegressionCase;
}> {
  const raw = await readFile(fixturePath, "utf8");
  const file = JSON.parse(raw) as RegressionPack;
  const candidate = file.cases.find(
    (item) => item.kind === "TOKENIZATION_AND_EXACT_IDENTIFIER",
  );
  if (!candidate) {
    throw new Error(
      "Missing TOKENIZATION_AND_EXACT_IDENTIFIER regression case.",
    );
  }
  const testCase = candidate as unknown as TokenizationRegressionCase;
  if (
    !testCase.samples?.english ||
    !testCase.samples.spanish ||
    !testCase.samples.code ||
    !Array.isArray(testCase.identifiers) ||
    testCase.identifiers.length === 0
  ) {
    throw new Error("Tokenization regression case is incomplete.");
  }
  return { raw, file, testCase };
}

function packetCandidate(content: string, suffix: string): PacketCandidate {
  return {
    hit: {
      documentId: `11111111-1111-4111-8111-11111111111${suffix}`,
      vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      revision: "p0-baseline",
      title: `Tokenizer baseline ${suffix}`,
      type: "benchmark",
      document: {
        externalId: `p0-tokenizer-${suffix}`,
        path: `benchmarks/tokenizer-${suffix}.md`,
        title: `Tokenizer baseline ${suffix}`,
      },
      trust: "HUMAN_REVIEWED",
      lifecycle: "ACTIVE",
      score: 1,
      reasons: ["p0-tokenizer-baseline"],
      excerpt: content,
      citations: [`p0-tokenizer-source-${suffix}`],
    },
    content,
    kind: "concept",
  };
}

function buildPacket(
  content: string,
  suffix: string,
  tokenizer?: Tokenizer,
) {
  return buildContextPacket({
    request: {
      query: `measure ${suffix} context tokenization`,
      spaceId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      vaultId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      vaultIds: [],
      federated: false,
      types: [],
      minimumTrust: "MACHINE_SUPPORTED",
      mode: "SOURCE_BACKED",
      limit: 10,
    },
    intent: "CONCEPTUAL",
    corpusRevision: "p0-context-tokenizer-baseline",
    maxTokens: 32_000,
    candidates: [packetCandidate(content, suffix)],
    ...(tokenizer ? { tokenizer } : {}),
  });
}

const loaded = await loadTokenizationCase();
if (loaded.file.productionDefaultsChanged !== false) {
  throw new Error("P0 tokenizer baseline must not change production defaults.");
}

const tokenizer = await AutoTokenizer.from_pretrained(model, { revision });
const countExact = (text: string): number => tokenizer.encode(text).length;
const tokenizerPort: Tokenizer = {
  id: `huggingface:${model}@${revision}`,
  label: `${model} tokenizer at ${revision}`,
  approximate: false,
  count: countExact,
};

const languageEntries = Object.entries(loaded.testCase.samples) as Array<
  [keyof TokenizationRegressionCase["samples"], string]
>;
const samples = languageEntries.map(([language, text], index) => {
  const suffix = String(index + 1);
  const exactPacket = buildPacket(text, suffix, tokenizerPort);
  const fallbackPacket = buildPacket(text, suffix);
  const exactWireTokens = countExact(JSON.stringify(exactPacket));

  if (exactPacket.budget.tokenizer.approximate) {
    throw new Error(`${language} packet did not use the exact model tokenizer.`);
  }
  if (exactPacket.budget.serializedTokens !== exactWireTokens) {
    throw new Error(
      `${language} packet serialized token count does not match the actual wire JSON.`,
    );
  }
  if (!fallbackPacket.budget.tokenizer.approximate) {
    throw new Error(
      `${language} fallback tokenizer was not labelled approximate.`,
    );
  }

  const exactContentTokens = countExact(text);
  const fallbackContentTokens = Math.ceil(text.length / 4);
  return {
    language,
    exactContentTokens,
    fallbackContentTokens,
    contentTokenDelta: fallbackContentTokens - exactContentTokens,
    exactSerializedPacketTokens: exactPacket.budget.serializedTokens,
    fallbackSerializedPacketTokens: fallbackPacket.budget.serializedTokens,
    serializedTokenDelta:
      fallbackPacket.budget.serializedTokens -
      exactPacket.budget.serializedTokens,
    tokenizer: exactPacket.budget.tokenizer,
    fallbackTokenizer: fallbackPacket.budget.tokenizer,
  };
});

const identifiers = loaded.testCase.identifiers.map((identifier) => ({
  identifier,
  exactTokens: countExact(identifier),
  fallbackTokens: Math.ceil(identifier.length / 4),
}));

const report = {
  schemaVersion: 1,
  evidenceLevel: "P0_BASELINE_MEASUREMENT",
  status: "PROVEN",
  productionDefaultsChanged: false,
  claimBoundary:
    "This proves only the v0.3 tokenization/context-packet baseline. It does not prove v0.4 tokenizer productization.",
  fixture: {
    path: path.relative(repositoryRoot, fixturePath),
    sha256: sha256(loaded.raw),
    regressionId: loaded.testCase.id,
  },
  targetModel: {
    model,
    revision,
    tokenizerId: tokenizerPort.id,
    exact: true,
  },
  samples,
  identifiers,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(
  JSON.stringify({ outputPath, status: report.status, samples }, null, 2),
);
