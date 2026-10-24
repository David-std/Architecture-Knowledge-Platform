import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { discoverS2PreAdmissionOriginalCandidates } from "../src/s2-pre-admission-source-discovery.js";
import type { FrozenRetrievedOriginal } from "../src/s2-retrieved-writer-bridge.js";
const sha = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const vault = "00000000-0000-4000-8000-000000000201",
  space = "00000000-0000-4000-8000-000000000202";
const text =
  "## Trace section\n\nThe tracing API configuration is held by a provider.\n\nThe proof of Tracers is a different source statement.";
const admitted = "The tracing API configuration is held by a provider.";
const exploratory = "The proof of Tracers is a different source statement.";
function fixture() {
  const bytes = Buffer.from(text);
  const file: FrozenRetrievedOriginal = {
    vaultId: vault,
    documentId: "doc1",
    path: "original/api.md",
    revision: "r1",
    fileSha256: sha(bytes),
    fileBytes: bytes,
    bodyStartUtf16: 0,
    bodyEndUtf16: text.length,
  };
  const hit = (excerpt: string) => ({
    vaultId: vault,
    documentId: "doc1",
    unitId: "unit1",
    document: { path: "original/api.md" },
    retrievalTrace: {
      authorization: {
        decision: "ALLOW",
        spaceId: space,
        vaultId: vault,
        pathRestricted: true,
      },
    },
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    revision: "r1",
    citations: ["original/api.md@r1"],
    excerpt,
  });
  const req = {
    query: "Which tracing API has a provider?",
    spaceId: space,
    vaultId: vault,
    mode: "SOURCE_BACKED",
    federated: false,
    vaultIds: [],
    types: [],
    limit: 10,
  };
  const resp = {
    mode: "SOURCE_BACKED",
    scope: { spaceId: space, vaultIds: [vault], federated: false },
    retrievalOutcome: "SUPPORTED",
    hits: [hit(admitted)],
    exploratoryHits: [hit(exploratory)],
  };
  const assemble = () => {
    const rawHttpRequestBytes = Buffer.from(JSON.stringify(req)),
      rawHttpResponseBytes = Buffer.from(JSON.stringify(resp));
    return {
      expectedQuestion: req.query,
      expectedSpaceId: space,
      expectedVaultId: vault,
      rawHttpRequestBytes,
      pinnedHttpRequestSha256: sha(rawHttpRequestBytes),
      rawHttpResponseBytes,
      pinnedHttpResponseSha256: sha(rawHttpResponseBytes),
      responseStatus: 200,
      authenticatedTransportReportedByCaller: true as const,
      originals: [file],
      pathAuthorizer: (path: string, id: string) =>
        path === "original/api.md" && id === vault,
    };
  };
  return { file, req, resp, hit, assemble };
}
describe("Pre-admission discovery is NOT semantic evidence admission", () => {
  it("separates admitted and exploratory quotes while binding every original byte", () => {
    const x = fixture();
    const result = discoverS2PreAdmissionOriginalCandidates(x.assemble());
    expect(result).toMatchObject({
      status: "SOURCE_DISCOVERY_ONLY",
      admittedHitsReported: 1,
      exploratoryHitsReported: 1,
      originalLiteralMatches: 2,
      writerRequestIssued: false,
      modelDecisionMade: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    });
    expect(result.candidates.map((x) => x.origin)).toEqual([
      "ADMITTED_HIT",
      "EXPLORATORY_HIT",
    ]);
    for (const c of result.candidates) {
      expect(text.slice(c.startUtf16, c.endUtf16)).toBe(c.exactQuote);
      expect(c.excerptSha256).toBe(sha(c.exactQuote));
      expect(c.authorizedForAnswerCitation).toBe(false);
    }
  });
  it("does not turn exploratory-only retrieved hits into authorized writer evidence", () => {
    const f = fixture();
    f.resp.hits = [];
    f.resp.retrievalOutcome = "EXPLORATORY_ONLY";
    const v = discoverS2PreAdmissionOriginalCandidates(f.assemble());
    expect(v).toMatchObject({
      status: "SOURCE_DISCOVERY_ONLY",
      admittedHitsReported: 0,
      exploratoryHitsReported: 1,
      releaseGateAccepted: false,
    });
    expect(v.candidates[0].origin).toBe("EXPLORATORY_HIT");
  });
  it("cannot reuse an HTTP receipt for another question, vault or space", () => {
    const f = fixture();
    const input = f.assemble();
    for (const mutate of [
      { expectedQuestion: "Other question" },
      { expectedVaultId: space },
      { expectedSpaceId: vault },
    ]) {
      expect(() =>
        discoverS2PreAdmissionOriginalCandidates({ ...input, ...mutate }),
      ).toThrow();
    }
  });
  it("cannot accept changed HTTP bytes with unchanged pinned hash", () => {
    const f = fixture();
    const input = f.assemble();
    const changed = Buffer.from(input.rawHttpResponseBytes);
    changed[changed.length - 3] ^= 1;
    expect(() =>
      discoverS2PreAdmissionOriginalCandidates({
        ...input,
        rawHttpResponseBytes: changed,
      }),
    ).toThrow();
  });
  it("rejects unauthorized paths, foreign vaults, stale revisions and missing frozen originals", () => {
    const f = fixture(),
      input = f.assemble();
    expect(() =>
      discoverS2PreAdmissionOriginalCandidates({
        ...input,
        pathAuthorizer: () => false,
      }),
    ).toThrow(/CURRENT_PATH/);
    for (const modify of [
      (h: any) => {
        h.vaultId = space;
      },
      (h: any) => {
        h.revision = "r2";
      },
      (h: any) => {
        h.lifecycle = "SUPERSEDED";
      },
      (h: any) => {
        h.refreshStatus = "STALE";
      },
    ]) {
      const v = fixture();
      modify(v.resp.exploratoryHits[0]);
      expect(() =>
        discoverS2PreAdmissionOriginalCandidates(v.assemble()),
      ).toThrow();
    }
    expect(() =>
      discoverS2PreAdmissionOriginalCandidates({ ...input, originals: [] }),
    ).toThrow();
  });
  it("rejects hits with missing, denied, foreign-space or foreign-vault authorization traces", () => {
    for (const tamper of [
      (hit: ReturnType<ReturnType<typeof fixture>["hit"]>) => {
        hit.retrievalTrace.authorization.decision = "DENY";
      },
      (hit: ReturnType<ReturnType<typeof fixture>["hit"]>) => {
        hit.retrievalTrace.authorization.spaceId = vault;
      },
      (hit: ReturnType<ReturnType<typeof fixture>["hit"]>) => {
        hit.retrievalTrace.authorization.vaultId = space;
      },
    ]) {
      const f = fixture();
      tamper(f.resp.exploratoryHits[0]);
      expect(() =>
        discoverS2PreAdmissionOriginalCandidates(f.assemble()),
      ).toThrow(/HTTP_HIT_NOT_TRUSTWORTHY/);
    }
  });
  it("cannot let forged outcome claim support without admitted hit", () => {
    const v = fixture();
    v.resp.hits = [];
    const req = v.assemble();
    expect(() => discoverS2PreAdmissionOriginalCandidates(req)).toThrow(
      /HTTP_SCOPE/,
    );
  });
  it("rejects mismatched source hashes and invalid original frames", () => {
    const v = fixture();
    const input = v.assemble();
    expect(() =>
      discoverS2PreAdmissionOriginalCandidates({
        ...input,
        originals: [{ ...v.file, fileSha256: sha("wrong") }],
      }),
    ).toThrow();
    // A valid but much narrower original body frame does not authorize
    // evidence outside that frame: it is omitted rather than repaired.
    expect(
      discoverS2PreAdmissionOriginalCandidates({
        ...input,
        originals: [{ ...v.file, bodyStartUtf16: 20, bodyEndUtf16: 21 }],
      }),
    ).toMatchObject({
      status: "NO_SOURCE_CANDIDATES",
      originalLiteralMatches: 0,
    });
  });
  it("omits unmatched or ambiguous quotes rather than repairing fuzzy source text", () => {
    const f = fixture();
    f.resp.hits = [];
    f.resp.retrievalOutcome = "EXPLORATORY_ONLY";
    f.resp.exploratoryHits[0].excerpt =
      "The  proof of Tracers is a different source statement.";
    const r = discoverS2PreAdmissionOriginalCandidates(f.assemble());
    expect(r).toMatchObject({
      status: "NO_SOURCE_CANDIDATES",
      unmatchedOrRepeatedExcerpts: 1,
      originalLiteralMatches: 0,
    });
  });
  it("handles UTF-16 offsets without splitting surrogate pairs", () => {
    const v = fixture();
    const prefix = "😀" + text;
    const bytes = Buffer.from(prefix);
    const file = {
      ...v.file,
      fileBytes: bytes,
      fileSha256: sha(bytes),
      bodyEndUtf16: prefix.length,
    };
    const r = discoverS2PreAdmissionOriginalCandidates({
      ...v.assemble(),
      originals: [file],
    });
    expect(r.candidates[0].startUtf16).toBe(text.indexOf(admitted) + 2);
  });
  it("does not leak later data by processing only requested bounded ranked entries", () => {
    const v = fixture();
    const r = discoverS2PreAdmissionOriginalCandidates({
      ...v.assemble(),
      maxCandidates: 1,
    });
    expect(r.candidates.length).toBe(1);
    expect(r.candidates[0].origin).toBe("ADMITTED_HIT");
  });
});
