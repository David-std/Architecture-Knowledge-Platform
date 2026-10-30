import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SearchHit } from "@akp/contracts";
import type { ObjectStore } from "@akp/object-store";
import type { Postgres } from "@akp/postgres";
import {
  LayeredEvidenceAdmissionPipeline,
  assessRetrievalAnswerabilityWithLayeredAdmission,
  retrievalAnswerabilityCandidateKey,
} from "@akp/retrieval";
import { createS2ReviewedSourcePropositionPort } from "../src/s2-reviewed-source-proposition-service.js";

const scope = vi.hoisted(() => ({ allowed: true, restricted: false }));
vi.mock("@akp/postgres", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@akp/postgres")>();
  return {
    ...actual,
    resolveAuthorizedVaultScope: vi.fn(async () => {
      if (!scope.allowed) throw new Error("VAULT_ACCESS_DENIED");
      return {
        vaultIds: ["22222222-2222-4222-8222-222222222222"],
        accessByVault: {
          "22222222-2222-4222-8222-222222222222": {
            pathPrefix: scope.restricted ? "restricted/" : null,
          },
        },
      };
    }),
  };
});

const sha = (x: string | Buffer) =>
  createHash("sha256").update(x).digest("hex");
const question = "Who calibrated the telescope after sunrise?";
const passage = "Vela calibrated the telescope after sunrise.";
const original = "HEADER\n" + passage + "\nFOOTER";
const bytes = Buffer.from(original, "utf8");
const digest = sha(bytes);
const path = "authorized/observatory.md";
function hit(): SearchHit {
  return {
    documentId: "11111111-1111-4111-8111-111111111111",
    vaultId: "22222222-2222-4222-8222-222222222222",
    unitId: "33333333-3333-4333-8333-333333333333",
    unitType: "PARAGRAPH",
    document: { externalId: "obs", path, title: "Observatory" },
    revision: "rev-current",
    title: "Observatory",
    type: "claim",
    trust: "HUMAN_REVIEWED",
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    score: 1,
    reasons: ["fixture"],
    excerpt: passage,
    citations: [],
  };
}
function row() {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    question_text: question,
    question_sha256: sha(question),
    source_sha256: digest,
    source_object_key: `sha256/${digest.slice(0, 2)}/${digest}`,
    source_byte_size: String(bytes.length),
    source_media_type: "text/markdown",
    excerpt: passage,
    excerpt_sha256: sha(passage),
    query_proposition: {
      subject: "",
      predicate: "calibrated",
      object: "the telescope",
      requestedAnswerRole: "SUBJECT",
      temporalScope: "after sunrise",
    },
    source_proposition: {
      subject: "Vela",
      predicate: "calibrated",
      object: "the telescope",
      temporalScope: "after sunrise",
      quote: { startOffset: 0, endOffset: passage.length },
    },
  };
}
function fixture(rows: unknown[] = [row()], sourceBytes = bytes) {
  const query = vi.fn(async () => ({ rows, rowCount: rows.length }));
  const db = { pool: { query } } as unknown as Postgres;
  const ref = {
    sha256: digest,
    bucket: "test",
    key: row().source_object_key,
    bytes: bytes.length,
    mediaType: "text/markdown",
  };
  const exists = vi.fn(async () => ref);
  const get = vi.fn(async () => Readable.from([sourceBytes]));
  const store = { exists, get } as unknown as ObjectStore;
  return {
    query,
    exists,
    get,
    port: createS2ReviewedSourcePropositionPort(db, store),
  };
}
const input = () => ({
  originalQuestion: question,
  hit: hit(),
  principalId: "55555555-5555-4555-8555-555555555555",
  spaceId: "66666666-6666-4666-8666-666666666666",
});

describe("opt-in reviewed SOURCE resolution over immutable bytes", () => {
  beforeEach(() => {
    scope.allowed = true;
    scope.restricted = false;
  });

  it("rebinds a human-reviewed EN unknown-subject question to one current raw SOURCE", async () => {
    const f = fixture();
    const result = await f.port.resolve(input());
    expect(result).toMatchObject({
      originalQuestion: question,
      originalQuestionSha256: sha(question),
      candidateKey: retrievalAnswerabilityCandidateKey(hit()),
      revision: "rev-current",
      originalSourceSha256: digest,
      excerptStartUtf16: 7,
      excerptEndUtf16: 7 + passage.length,
      queryProposition: {
        requestedAnswerRole: "SUBJECT",
        object: "the telescope",
      },
      candidateProposition: { subject: "Vela" },
    });
    expect(f.query).toHaveBeenCalledTimes(1);
    const [sql, params] = f.query.mock.calls[0]!;
    expect(sql).toContain("r.status='APPROVED'");
    expect(sql).toContain("document_evidence");
    expect(sql).toContain("r.approved_by<>r.proposed_by");
    expect(params).toContain("rev-current");
    expect(params).toContain(sha(passage));
    expect(f.get).toHaveBeenCalledTimes(1);
  });

  it("feeds the same R5 admission owner rather than letting an LLM invent the subject", async () => {
    const f = fixture();
    const read = vi.fn(async () => {
      throw new Error("semantic LLM must not arbitrate a reviewed role");
    });
    const pipeline = new LayeredEvidenceAdmissionPipeline({
      semanticReader: { id: "forbidden", read },
    });
    const result = await assessRetrievalAnswerabilityWithLayeredAdmission(
      [hit()],
      question,
      pipeline,
      { governedPropositionPort: f.port },
    );
    // The route's scoped closure supplies principal+space. An unscoped test
    // port has no credentials and MUST withhold, even with a valid fixture.
    expect(result.supported).toBe(false);
    expect(f.get).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    const scoped = {
      resolve: ({
        originalQuestion,
        hit: candidate,
      }: {
        originalQuestion: string;
        hit: SearchHit;
      }) =>
        f.port.resolve({
          originalQuestion,
          hit: candidate,
          principalId: input().principalId,
          spaceId: input().spaceId,
        }),
    };
    const admitted = await assessRetrievalAnswerabilityWithLayeredAdmission(
      [hit()],
      question,
      pipeline,
      { governedPropositionPort: scoped },
    );
    expect(admitted.supported).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("fails closed without identity, vault rights or authorized path", async () => {
    const f = fixture();
    expect(
      await f.port.resolve({ originalQuestion: question, hit: hit() }),
    ).toBeNull();
    scope.allowed = false;
    expect(await f.port.resolve(input())).toBeNull();
    scope.allowed = true;
    scope.restricted = true;
    expect(await f.port.resolve(input())).toBeNull();
    expect(f.query).not.toHaveBeenCalled();
    expect(f.get).not.toHaveBeenCalled();
  });

  it("never picks one of two competing approved projections", async () => {
    const f = fixture([row(), row()]);
    expect(await f.port.resolve(input())).toBeNull();
    expect(f.get).not.toHaveBeenCalled();
  });

  it.each([
    ["no current review", []],
    ["source hash changed", [{ ...row(), source_sha256: sha("different") }]],
    [
      "wrong original question",
      [{ ...row(), question_text: "Who denied the telescope?" }],
    ],
    [
      "excerpt substitution",
      [{ ...row(), excerpt: "Vela denied the telescope." }],
    ],
    [
      "untrusted wildcard",
      [
        {
          ...row(),
          query_proposition: { subject: "", predicate: "calibrated" },
        },
      ],
    ],
    [
      "missing source subject",
      [
        {
          ...row(),
          source_proposition: { ...row().source_proposition, subject: "" },
        },
      ],
    ],
    [
      "bad quote",
      [
        {
          ...row(),
          source_proposition: {
            ...row().source_proposition,
            quote: { startOffset: 0, endOffset: 999 },
          },
        },
      ],
    ],
    ["nontext source", [{ ...row(), source_media_type: "application/pdf" }]],
  ])("rejects %s", async (_, rows) => {
    const f = fixture(rows);
    expect(await f.port.resolve(input())).toBeNull();
  });

  it("rejects raw-source tampering, even when DB approval and excerpt metadata match", async () => {
    const f = fixture([row()], Buffer.from(original + " tampered"));
    expect(await f.port.resolve(input())).toBeNull();
  });
  it("rejects duplicated excerpt with ambiguous source coordinates", async () => {
    const double = Buffer.from(passage + "\n" + passage);
    const record = {
      ...row(),
      source_sha256: sha(double),
      source_object_key: `sha256/${sha(double).slice(0, 2)}/${sha(double)}`,
      source_byte_size: String(double.length),
    };
    const f = fixture([record], double);
    // Metadata ref is still pinned to the prior source SHA: no fallback.
    expect(await f.port.resolve(input())).toBeNull();
  });
});
