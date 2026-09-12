import { once } from "node:events";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  KnowledgeCompilerInput,
  createConfiguredKnowledgeCompiler,
} from "../src/index.js";

const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const ARTIFACT_ID = "22222222-2222-4222-8222-222222222222";
const EVIDENCE_ID = "33333333-3333-4333-8333-333333333333";
const SPACE_ID = "55555555-5555-4555-8555-555555555555";
const VAULT_ID = "66666666-6666-4666-8666-666666666666";
const SOURCE_HASH = "a".repeat(64);
const EXCERPT_HASH = "b".repeat(64);
let server: Server | undefined;

function locator() {
  return {
    kind: "paragraph",
    source_hash: SOURCE_HASH,
    path: `source:${SOURCE_ID}`,
    paragraph: 1,
    heading_path: ["Guidance"],
  };
}

function input() {
  return KnowledgeCompilerInput.parse({
    source: {
      sourceId: SOURCE_ID,
      sourceArtifactId: ARTIFACT_ID,
      sha256: SOURCE_HASH,
      title: "Revision-aware cache guidance",
      mediaType: "text/markdown",
    },
    documentArtifact: {
      source_id: SOURCE_ID,
      source_hash: SOURCE_HASH,
      media_type: "text/markdown",
      extractor: "fixture",
      extractor_version: "1",
      paragraphs: [
        {
          id: "p1",
          kind: "paragraph",
          text: "Invalidate cached material when the authoritative revision changes.",
          locator: locator(),
        },
      ],
      reading_order: ["p1"],
      locators: [locator()],
    },
    evidence: [
      {
        id: EVIDENCE_ID,
        sourceArtifactId: ARTIFACT_ID,
        locator: locator(),
        excerpt:
          "Invalidate cached material when the authoritative revision changes.",
        excerptHash: EXCERPT_HASH,
      },
    ],
    existingCandidates: [],
    schemaProfile: {},
    policy: {},
    budget: {
      maxInputCharacters: 48_000,
      maxEvidence: 4,
      maxExistingCandidates: 4,
      maxProposedChanges: 4,
      maxProbes: 4,
    },
    corpusRevision: "managed:fixture",
    spaceId: SPACE_ID,
    vaultId: VAULT_ID,
  });
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function closeServer(): Promise<void> {
  if (!server) return;
  const active = server;
  server = undefined;
  await new Promise<void>((resolve, reject) => {
    active.close((error) => (error ? reject(error) : resolve()));
  });
}

afterEach(async () => {
  await closeServer();
});

describe("OpenAI-compatible compiler HTTP integration", () => {
  it("round-trips a grounded compiler result through a deterministic local server", async () => {
    let requests = 0;
    server = createServer(async (request, response) => {
      requests += 1;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBeUndefined();

      const body = JSON.parse(await requestBody(request)) as {
        model: string;
        response_format: { type: string };
        messages: Array<{ role: string; content: string }>;
      };
      expect(body.model).toBe("deterministic-compiler");
      expect(body.response_format).toEqual({ type: "json_object" });
      const userPrompt = body.messages.find((message) => message.role === "user")?.content;
      if (!userPrompt) throw new Error("Missing compiler user prompt");
      const serializedInput = userPrompt.slice(userPrompt.indexOf("\n") + 1);
      const boundedInput = KnowledgeCompilerInput.parse(JSON.parse(serializedInput));
      const evidence = boundedInput.evidence[0];
      if (!evidence) throw new Error("Missing bounded evidence");

      const result = {
        identity: {
          classification: "DISTINCT",
          candidates: [],
          reason: "The supplied source adds one bounded rule.",
        },
        evidenceCandidates: [
          {
            sourceArtifactId: evidence.sourceArtifactId,
            locator: evidence.locator,
            excerptHash: evidence.excerptHash,
          },
        ],
        knowledgeCandidates: [
          {
            candidateId: "cache-rule-1",
            kind: "rule",
            statement:
              "Invalidate cached material when the authoritative revision changes.",
            scope: "Revision-addressed cached knowledge.",
            evidenceIds: [evidence.id],
            confidence: 0.95,
            proposedAction: "CREATE",
          },
        ],
        contradictions: [],
        proposedFileChanges: [
          {
            path: "20-knowledge/generated/rule/cache-invalidation.md",
            operation: "CREATE",
            content:
              "---\nid: CACHE-RULE-1\ntype: rule\nstatus: draft\n---\n\n# Cache invalidation\n\nInvalidate cached material when the authoritative revision changes.\n",
            reasons: ["Grounded in the supplied evidence fragment."],
            evidenceIds: [evidence.id],
          },
        ],
        impactedDocumentIds: [],
        probes: [
          {
            question: "Is the cache invalidation rule supported by evidence?",
            criticality: "CRITICAL",
            evidenceIds: [evidence.id],
          },
        ],
        warnings: [],
        summary: "One evidence-backed rule is proposed for human review.",
      };

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(result) } }],
        }),
      );
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Deterministic compiler server did not bind a TCP port");
    }

    const configured = createConfiguredKnowledgeCompiler({
      AKP_LLM_PROVIDER: "openai-compatible",
      AKP_LLM_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
      AKP_LLM_MODEL: "deterministic-compiler",
      AKP_LLM_TIMEOUT_MS: "5000",
      AKP_LLM_MAX_RETRIES: "0",
    });
    if (!configured) throw new Error("Compiler configuration unexpectedly disabled");

    const result = await configured.compiler.compile(input());

    expect(requests).toBe(1);
    expect(configured.descriptor).toMatchObject({
      provider: "openai-compatible",
      model: "deterministic-compiler",
    });
    expect(result.knowledgeCandidates[0]).toMatchObject({
      candidateId: "cache-rule-1",
      evidenceIds: [EVIDENCE_ID],
      proposedAction: "CREATE",
    });
    expect(result.proposedFileChanges[0]?.evidenceIds).toEqual([EVIDENCE_ID]);
  });
});
