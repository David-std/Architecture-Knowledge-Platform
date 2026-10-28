import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ObjectStore } from "@akp/object-store";
import type { Postgres } from "@akp/postgres";
import { registerS2ReviewedPropositionRoutes } from "../src/routes/s2-reviewed-propositions.js";

const authState = vi.hoisted(() => ({
  id: "11111111-1111-4111-8111-111111111111",
  scope: true,
}));
vi.mock("../src/auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/auth.js")>();
  return {
    ...actual,
    actorOf: vi.fn(() => ({ id: authState.id, principalKind: "HUMAN" })),
    hasSpaceAccess: vi.fn(() => authState.scope),
    requirePermission: vi.fn(() => async () => {}),
  };
});
vi.mock("@akp/postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@akp/postgres")>();
  return {
    ...actual,
    resolveAuthorizedVaultScope: vi.fn(async () => {
      if (!authState.scope) throw new Error("VAULT_DENIED");
      return {
        accessByVault: {
          "22222222-2222-4222-8222-222222222222": { pathPrefix: null },
        },
      };
    }),
  };
});
const sha = (x: string | Buffer) =>
  createHash("sha256").update(x).digest("hex");
const excerpt = "Lira approved the index after inspection.";
const bytes = Buffer.from("HEAD\n" + excerpt + "\nEND");
const sourceSha = sha(bytes);
const s = {
  path: "public/current.md",
  current_revision: "rev-now",
  source_sha256: sourceSha,
  object_key: `sha256/${sourceSha.slice(0, 2)}/${sourceSha}`,
  byte_size: String(bytes.length),
  media_type: "text/markdown",
};
const id = "33333333-3333-4333-8333-333333333333";
const proposal = () => ({
  spaceId: "66666666-6666-4666-8666-666666666666",
  vaultId: "22222222-2222-4222-8222-222222222222",
  documentId: "77777777-7777-4777-8777-777777777777",
  unitId: null,
  sourceId: "88888888-8888-4888-8888-888888888888",
  question: "Who approved the index after inspection?",
  excerpt,
  queryProposition: {
    subject: "",
    predicate: "approved",
    object: "the index",
    conditions: ["after inspection"],
    requestedAnswerRole: "SUBJECT",
  },
  sourceProposition: {
    subject: "Lira",
    predicate: "approved",
    object: "the index",
    conditions: ["after inspection"],
    quote: { startOffset: 0, endOffset: excerpt.length },
  },
});
function harness() {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("insert into s2_reviewed_source_propositions"))
      return { rows: [{ id }], rowCount: 1 };
    if (sql.includes("set status='APPROVED'"))
      return { rows: [{ id }], rowCount: 1 };
    if (sql.includes("set status='REVOKED'")) return { rows: [], rowCount: 1 };
    if (sql.includes("select space_id,vault_id,document_path"))
      return {
        rows: [
          {
            space_id: proposal().spaceId,
            vault_id: proposal().vaultId,
            document_path: s.path,
          },
        ],
        rowCount: 1,
      };
    if (sql.includes("r.proposed_by<>$2"))
      return {
        rows:
          authState.id === "11111111-1111-4111-8111-111111111111"
            ? []
            : [
                {
                  ...s,
                  space_id: proposal().spaceId,
                  vault_id: proposal().vaultId,
                  proposed_by: "11111111-1111-4111-8111-111111111111",
                  excerpt,
                  question_text: proposal().question,
                  query_proposition: proposal().queryProposition,
                  source_proposition: proposal().sourceProposition,
                  start_offset: 0,
                  end_offset: excerpt.length,
                },
              ],
        rowCount: 1,
      };
    return { rows: [s], rowCount: 1 };
  });
  const db = { pool: { query } } as unknown as Postgres;
  const ref = {
    bucket: "b",
    key: s.object_key,
    sha256: sourceSha,
    bytes: bytes.length,
  };
  const store = {
    exists: vi.fn(async () => ref),
    get: vi.fn(async () => Readable.from([bytes])),
  } as unknown as ObjectStore;
  const app = Fastify();
  registerS2ReviewedPropositionRoutes(app, db, store);
  return { app, query };
}
describe("two-person governed S2 review and revocation", () => {
  beforeEach(() => {
    authState.id = "11111111-1111-4111-8111-111111111111";
    authState.scope = true;
  });
  it("accepts only a pinned source proposal, then a different reviewer and revocation", async () => {
    const { app, query } = harness();
    const proposed = await app.inject({
      method: "POST",
      url: "/v1/s2/proposition-reviews",
      payload: proposal(),
    });
    expect(proposed.statusCode).toBe(201);
    expect(proposed.json()).toMatchObject({
      id,
      status: "PROPOSED",
      productionAdmission: false,
    });
    const same = await app.inject({
      method: "POST",
      url: `/v1/s2/proposition-reviews/${id}/approve`,
    });
    expect(same.statusCode).toBe(409);
    authState.id = "99999999-9999-4999-8999-999999999999";
    const approved = await app.inject({
      method: "POST",
      url: `/v1/s2/proposition-reviews/${id}/approve`,
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      id,
      status: "APPROVED",
      productionAdmission: false,
    });
    expect(
      query.mock.calls.some(([sql]) => sql.includes("proposed_by<>$2")),
    ).toBe(true);
    const revoked = await app.inject({
      method: "POST",
      url: `/v1/s2/proposition-reviews/${id}/revoke`,
    });
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json()).toMatchObject({ status: "REVOKED" });
    await app.close();
  }, 20000);
  it("denies forged SOURCE snippet or missing source permissions", async () => {
    const { app } = harness();
    const forged = await app.inject({
      method: "POST",
      url: "/v1/s2/proposition-reviews",
      payload: { ...proposal(), excerpt: "Source does not contain this." },
    });
    expect(forged.statusCode).toBe(409);
    authState.scope = false;
    const denied = await app.inject({
      method: "POST",
      url: "/v1/s2/proposition-reviews",
      payload: proposal(),
    });
    expect(denied.statusCode).toBe(403);
    await app.close();
  }, 20000);
});
