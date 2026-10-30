import { createHash } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerS2ReviewedWriterAuditRoutes } from "../src/routes/s2-writer-claims.js";
import type { GovernedLayeredPropositionPort } from "@akp/retrieval";
import type { Postgres } from "@akp/postgres";

const actor = { id: "55555555-5555-4555-8555-555555555555" };
vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth.js")>();
  return {
    ...actual,
    actorOf: vi.fn(() => actor),
    hasSpaceAccess: vi.fn(() => true),
    requirePermission: vi.fn(() => async () => {}),
  };
});
vi.mock("@akp/postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@akp/postgres")>();
  return {
    ...actual,
    resolveAuthorizedVaultScope: vi.fn(async () => ({
      vaultIds: ["22222222-2222-4222-8222-222222222222"],
      accessByVault: {
        "22222222-2222-4222-8222-222222222222": { pathPrefix: null },
      },
    })),
  };
});

const sha = (t: string | Uint8Array) =>
  createHash("sha256").update(t).digest("hex");
const question = "Who approved the index after inspection?";
const passage = "Lira approved the index after inspection.";
const body = "HEAD\n" + passage + "\nEND";
const uuid = (i: number) =>
  `${String(i).padStart(8, "0")}-0000-4000-8000-000000000001`;
const spaceId = uuid(1),
  vaultId = "22222222-2222-4222-8222-222222222222";
const packetId = uuid(3),
  documentId = uuid(4),
  packetHash = sha("frozen packet");
const section = {
  kind: "evidence",
  contextLevel: "L2",
  title: "Recorded evidence",
  content: passage,
  documentId,
  vaultId,
  document: {
    path: "public/current.md",
    title: "Recorded evidence",
    externalId: "truth",
  },
  documentRevision: "rev-current",
  selectionReason: "reviewed",
  sourceOrEvidenceIds: [uuid(5)],
};
const packet = {
  packetMode: "FULL_CONTEXT_PACKET",
  packetId,
  query: question,
  intent: "FACT_LOOKUP",
  corpusRevision: "rev-current",
  status: "SUPPORTED",
  indexRevisions: {},
  retrievalConfiguration: {},
  scope: { spaceId, vaultIds: [vaultId], federated: false },
  generatedAt: "2026-10-28T10:00:00.000Z",
  budget: {
    maxTokens: 512,
    usedTokens: 30,
    contentTokens: 20,
    metadataTokens: 10,
    serializedTokens: 30,
    tokenizer: {
      id: "test",
      label: "test",
      quality: "EXACT",
      approximate: false,
      source: "injected",
    },
  },
  mode: "SOURCE_BACKED",
  requestedContextLevel: "L2",
  searchedChannels: ["lexical"],
  sections: [section],
  citations: ["SEC1"],
  gaps: [],
  conflicts: [],
  requiredActions: [],
  recommendedActions: [],
  continuations: [],
  packetHash,
};
function proof(
  query: string,
  hit: {
    documentId: string;
    vaultId: string;
    unitId?: string;
    revision: string;
    document: { path: string };
    excerpt: string;
  },
) {
  const raw = new TextEncoder().encode("HEAD\n" + hit.excerpt + "\nEND");
  return {
    originalQuestion: query,
    originalQuestionSha256: sha(query),
    candidateKey: hit.documentId + ":" + (hit.unitId ?? "document"),
    documentId: hit.documentId,
    unitId: hit.unitId ?? null,
    vaultId: hit.vaultId,
    revision: hit.revision,
    path: hit.document.path,
    originalSourceText: "HEAD\n" + hit.excerpt + "\nEND",
    originalSourceBytes: raw,
    originalSourceSha256: sha(raw),
    excerptStartUtf16: 5,
    excerptEndUtf16: 5 + hit.excerpt.length,
    queryProposition:
      query === question
        ? {
            subject: "",
            predicate: "approved",
            object: "the index",
            conditions: ["after inspection"],
            requestedAnswerRole: "SUBJECT" as const,
          }
        : {
            subject: "Lira",
            predicate: "approved",
            object: "the index",
            conditions: ["after inspection"],
          },
    candidateProposition: {
      subject: "Lira",
      predicate: "approved",
      object: "the index",
      conditions: ["after inspection"],
      quote: { startOffset: 0, endOffset: hit.excerpt.length },
    },
  };
}
function harness(port: GovernedLayeredPropositionPort) {
  const query = vi.fn(async (_sql: string, params: unknown[]) => {
    if (params[1] !== actor.id) return { rows: [], rowCount: 0 };
    return {
      rows: [
        { id: packetId, space_id: spaceId, packet_hash: packetHash, packet },
      ],
      rowCount: 1,
    };
  });
  const db = { pool: { query } } as unknown as Postgres;
  const app = Fastify();
  registerS2ReviewedWriterAuditRoutes(app, db, port);
  return { app, query };
}
const bodyPayload = () => ({
  packetId,
  packetHash,
  answerText: passage,
  statements: [
    {
      text: passage,
      startUtf16: 0,
      endUtf16: passage.length,
      citationId: "SEC1",
    },
  ],
});
describe("S2 HTTP Writer candidate custody from a frozen ContextPacket", () => {
  it("rejects forged citation labels, packets, and user-supplied source projections", async () => {
    const resolve = vi.fn(async () => null);
    const { app } = harness({ resolve });
    const forged = await app.inject({
      method: "POST",
      url: "/v1/s2/writer-claims/audit",
      payload: {
        ...bodyPayload(),
        statements: [{ ...bodyPayload().statements[0], citationId: "SEC2" }],
      },
    });
    expect(forged.statusCode).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
    const injected = await app.inject({
      method: "POST",
      url: "/v1/s2/writer-claims/audit",
      payload: {
        ...bodyPayload(),
        statements: [
          {
            ...bodyPayload().statements[0],
            statementProposition: { subject: "fake", predicate: "fake" },
          },
        ],
      },
    });
    expect(injected.statusCode).toBe(400);
    const stale = await app.inject({
      method: "POST",
      url: "/v1/s2/writer-claims/audit",
      payload: { ...bodyPayload(), packetHash: "not-the-stored-packet" },
    });
    expect(stale.statusCode).toBe(404);
    await app.close();
  });
  it("withholds a Writer statement with no separately reviewed statement relation", async () => {
    const { app } = harness({ resolve: vi.fn(async () => null) });
    const response = await app.inject({
      method: "POST",
      url: "/v1/s2/writer-claims/audit",
      payload: bodyPayload(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "WITHHELD_WRITER_STATEMENT_REVIEW",
      productionAdmission: false,
    });
    await app.close();
  });
  it("checks both the original question and every Writer statement through R5 with raw SOURCE", async () => {
    const resolve = vi.fn(async ({ originalQuestion, hit }: any) =>
      proof(originalQuestion, hit),
    );
    const { app } = harness({ resolve });
    const response = await app.inject({
      method: "POST",
      url: "/v1/s2/writer-claims/audit",
      payload: bodyPayload(),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "SOURCE_BOUND_CLAIMS_CANDIDATE",
      testedClaims: 1,
      productionAdmission: false,
      releaseGateAccepted: false,
      fullAuthenticatedWriterRoundTripIndependentlyVerified: false,
      packetId,
    });
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(resolve.mock.calls[0]?.[0]).toMatchObject({
      originalQuestion: passage,
      principalId: actor.id,
      spaceId,
    });
    await app.close();
  });
});
