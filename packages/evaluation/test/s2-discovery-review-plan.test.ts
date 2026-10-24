import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { discoverS2PreAdmissionOriginalCandidates } from "../src/s2-pre-admission-source-discovery.js";
import { freezeS2DiscoveryReviewPlan } from "../src/s2-discovery-review-plan.js";
import type { FrozenRetrievedOriginal } from "../src/s2-retrieved-writer-bridge.js";
const sha = (x: string | Uint8Array) =>
  createHash("sha256").update(x).digest("hex");
const vault = "e79e6d12-79f3-422a-960f-62133c4884bc";
const space = "798ba84d-bc52-4185-a056-686fa8dc53db";
const source =
  "Original header.\n\nThe publishing key defines permissions of a scoped token.\n\nOther statement confirms the token is configured in a workflow.";
const q1 = "The publishing key defines permissions of a scoped token.";
const q2 = "Other statement confirms the token is configured in a workflow.";
function fixture() {
  const bytes = Buffer.from(source);
  const file: FrozenRetrievedOriginal = {
    vaultId: vault,
    documentId: "document-123",
    revision: "rev-abc",
    path: "official/source.md",
    fileSha256: sha(bytes),
    fileBytes: bytes,
    bodyStartUtf16: 0,
    bodyEndUtf16: source.length,
  };
  const hit = (quote: string) => ({
    documentId: file.documentId,
    vaultId: vault,
    document: { path: file.path },
    revision: file.revision,
    lifecycle: "ACTIVE",
    refreshStatus: "CURRENT",
    retrievalTrace: {
      authorization: { decision: "ALLOW", spaceId: space, vaultId: vault },
    },
    citations: [file.path + "@" + file.revision],
    excerpt: quote,
  });
  const req = {
    spaceId: space,
    vaultId: vault,
    vaultIds: [],
    types: [],
    mode: "SOURCE_BACKED",
    federated: false,
    query: "Which key defines permissions?",
  };
  const resp = {
    mode: "SOURCE_BACKED",
    scope: { spaceId: space, vaultIds: [vault], federated: false },
    retrievalOutcome: "SUPPORTED",
    hits: [hit(q1)],
    exploratoryHits: [hit(q2)],
  };
  const request = Buffer.from(JSON.stringify(req)),
    response = Buffer.from(JSON.stringify(resp));
  const discovery = discoverS2PreAdmissionOriginalCandidates({
    expectedQuestion: req.query,
    expectedSpaceId: space,
    expectedVaultId: vault,
    rawHttpRequestBytes: request,
    rawHttpResponseBytes: response,
    pinnedHttpRequestSha256: sha(request),
    pinnedHttpResponseSha256: sha(response),
    responseStatus: 200,
    authenticatedTransportReportedByCaller: true,
    originals: [file],
    pathAuthorizer: (path, id) => path === file.path && id === vault,
  });
  return {
    file,
    discovery,
    input: {
      discovery,
      originals: [file],
      currentPathAuthorizer: (path: string, id: string) =>
        path === file.path && id === vault,
    },
  };
}
describe("bounded pre-admission source portfolio planning, never answer certification", () => {
  it("binds both admitted and exploratory candidates without authorizing either for writer citation", () => {
    const f = fixture(),
      result = freezeS2DiscoveryReviewPlan(f.input);
    expect(result).toMatchObject({
      status: "SHADOW_REVIEW_INPUTS_ONLY",
      modelCalled: false,
      canBuildAdmittedWriterRequest: false,
      sourcePropositionsVerified: false,
      completeAnswerVerified: false,
      productionAdmission: false,
      releaseGateAccepted: false,
      liveAccessControlCryptographicallyVerified: false,
    });
    expect(result.windows.map((x) => x.candidateOrigin)).toEqual([
      "ADMITTED_HIT",
      "EXPLORATORY_HIT",
    ]);
    for (const w of result.windows) {
      expect(source.slice(w.startUtf16, w.endUtf16)).toBe(w.exactText);
      expect(w.productionAdmission).toBe(false);
    }
    expect(result.originalRefs[0]).toMatchObject({
      assignedSourceId: "SRC1",
      authorizedForAnswerCitation: false,
    });
  });
  it("does not silently widen a one-window budget into full-source proof", () => {
    const f = fixture(),
      r = freezeS2DiscoveryReviewPlan({ ...f.input, maxWindows: 1 });
    expect(r.status).toBe("SHADOW_REVIEW_INPUTS_ONLY");
    expect(r.windows).toHaveLength(1);
    expect(r.candidatesOutsideBudget).toBe(1);
    expect(r.windows[0].candidateOrigin).toBe("ADMITTED_HIT");
  });
  it("fails closed if an original is removed or its frozen SHA or revision differs", () => {
    const f = fixture();
    expect(
      freezeS2DiscoveryReviewPlan({ ...f.input, originals: [] }).status,
    ).toBe("REJECTED");
    expect(
      freezeS2DiscoveryReviewPlan({
        ...f.input,
        originals: [{ ...f.file, fileSha256: sha("not-source") }],
      }).status,
    ).toBe("REJECTED");
    expect(
      freezeS2DiscoveryReviewPlan({
        ...f.input,
        originals: [{ ...f.file, revision: "different" }],
      }).status,
    ).toBe("REJECTED");
  });
  it("performs current path authorization and never treats historical ALLOW as sufficient", () => {
    const f = fixture();
    expect(
      freezeS2DiscoveryReviewPlan({
        ...f.input,
        currentPathAuthorizer: () => false,
      }).status,
    ).toBe("REJECTED");
  });
  it("checks all candidates for tampering even those beyond requested output budget", () => {
    const f = fixture(),
      c = [...f.discovery.candidates];
    c[1] = { ...c[1], excerptSha256: sha("tampered") } as never;
    expect(
      freezeS2DiscoveryReviewPlan({
        ...f.input,
        discovery: { ...f.discovery, candidates: c },
        maxWindows: 1,
      }).status,
    ).toBe("REJECTED");
  });
  it("does not allow a discovery candidate to claim admission or semantic sufficiency", () => {
    const f = fixture(),
      c = [...f.discovery.candidates];
    c[0] = { ...c[0], productionAdmission: true } as never;
    expect(
      freezeS2DiscoveryReviewPlan({
        ...f.input,
        discovery: { ...f.discovery, candidates: c },
      }).status,
    ).toBe("REJECTED");
  });
  it("cannot claim a different scope or a changed original offset", () => {
    const f = fixture();
    expect(
      freezeS2DiscoveryReviewPlan({
        ...f.input,
        discovery: { ...f.discovery, scopeVaultIdSha256: sha(space) },
      }).status,
    ).toBe("REJECTED");
    const c = [...f.discovery.candidates];
    c[0] = { ...c[0], startUtf16: c[0].startUtf16 + 1 };
    expect(
      freezeS2DiscoveryReviewPlan({
        ...f.input,
        discovery: { ...f.discovery, candidates: c },
      }).status,
    ).toBe("REJECTED");
  });
  it("returns a no-window result on a genuinely empty retrieval, not an admitted answer", () => {
    const f = fixture();
    expect(
      freezeS2DiscoveryReviewPlan({
        ...f.input,
        discovery: {
          ...f.discovery,
          status: "NO_SOURCE_CANDIDATES",
          originalLiteralMatches: 0,
          candidates: [],
        },
      }),
    ).toMatchObject({
      status: "NO_BOUND_WINDOWS",
      productionAdmission: false,
      modelCalled: false,
    });
  });
});
