import { createHash, randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { freezeWriterFromAuthenticatedSearchResponse } from "../src/s2-authenticated-http-writer-bridge.js";
const sha = (v: string | Uint8Array) =>
  createHash("sha256").update(v).digest("hex");
const spaceId = randomUUID(),
  vaultId = randomUUID(),
  docId = randomUUID(),
  unitId = randomUUID();
const question = "What is the synthetic clock color?";
const docText = "# Synthetic clock\nThe synthetic clock is ultraviolet.\n";
const fileBytes = Buffer.from(docText);
const original = {
  vaultId,
  documentId: docId,
  path: "synthetic/clock.md",
  revision: "synthetic-r1",
  fileSha256: sha(fileBytes),
  fileBytes,
  bodyStartUtf16: 0,
  bodyEndUtf16: docText.length,
};
const hit = {
  vaultId,
  documentId: docId,
  unitId,
  document: { path: original.path, title: "Synthetic clock", externalId: null },
  revision: original.revision,
  lifecycle: "ACTIVE",
  refreshStatus: "CURRENT",
  excerpt: "The synthetic clock is ultraviolet.",
  citations: [],
};
const scope = {
  question,
  caseKeySha256: sha("en\0" + question),
  caseManifestSha256: sha("synthetic-cases"),
  sourceManifestSha256: sha("synthetic-sources"),
  sourceFamilySha256: sha("fiction"),
  executedCommitSha: "f".repeat(40),
  language: "en" as const,
  model: "synthetic-model",
  modelDigestSha256: sha("synthetic-digest"),
  systemPrompt: "Cite only source.",
  seed: 1317,
  contextTokens: 4096 as const,
  maxOutputTokens: 512,
  vaultId,
  maxRetrievedDocuments: 2,
};
const request = {
  query: question,
  spaceId,
  vaultId,
  vaultIds: [],
  federated: false,
  types: [],
  minimumTrust: "MACHINE_SUPPORTED",
  mode: "SOURCE_BACKED",
  limit: 10,
};
const response = {
  mode: "SOURCE_BACKED",
  scope: { spaceId, vaultIds: [vaultId], federated: false },
  retrievalOutcome: "SUPPORTED",
  hits: [hit],
  exploratoryHits: [],
  noAnswer: null,
};
const build = (
  customResponse: unknown = response,
  customRequest: unknown = request,
  status = 200,
  authorize = true,
) =>
  freezeWriterFromAuthenticatedSearchResponse({
    expectedSpaceId: spaceId,
    expectedVaultId: vaultId,
    expectedQuestion: question,
    requestBytes: Buffer.from(JSON.stringify(customRequest)),
    responseBytes: Buffer.from(JSON.stringify(customResponse)),
    responseStatus: status,
    authorizationReportedByCaller: true,
    bridgeScope: scope,
    originals: [original],
    pathAuthorizer: (path, vault) =>
      authorize && path === original.path && vault === vaultId,
  });
describe("S2 authenticated HTTP bridge, pure fail-closed", () => {
  it("freezes only HTTP-admitted source with exact request/response SHA", () => {
    const out = build();
    expect(out.status).toBe("HTTP_ADMITTED_WRITER_READY");
    expect(out.selectedSourceCount).toBe(1);
    expect(
      out.bridge.exactProviderRequest?.freeze.sourcePassages,
    ).toMatchObject([{ id: "SRC1", source: "ORIGINAL_LITERAL_MATCH" }]);
    expect(out.requestSha256).toBe(sha(JSON.stringify(request)));
    expect(out.responseSha256).toBe(sha(JSON.stringify(response)));
    expect(out).toMatchObject({
      ownerGoldLoaded: false,
      authenticatedPrincipalVerifiedByOfflineBridge: false,
      fullAnswerHttpRouteMeasured: false,
      gateAccepted: false,
    });
  });
  it("does not pass exploratory hits to model when no admission", () => {
    const out = build({
      ...response,
      retrievalOutcome: "EXPLORATORY_ONLY",
      hits: [],
      exploratoryHits: [hit],
      noAnswer: { status: "INSUFFICIENT_KNOWLEDGE" },
    });
    expect(out.status).toBe("HTTP_NO_ADMITTED_EVIDENCE");
    expect(out.bridge.exactProviderRequest).toBeNull();
    expect(out.exploratoryHitCount).toBe(1);
  });
  it("refuses a forbidden HTTP response and mismatched scope", () => {
    expect(() => build(response, request, 403)).toThrow(
      "RESPONSE_UNTRUSTED_SCOPE",
    );
    expect(() =>
      build({
        ...response,
        scope: { ...response.scope, spaceId: randomUUID() },
      }),
    ).toThrow("RESPONSE_UNTRUSTED_SCOPE");
    expect(() =>
      build(response, { ...request, vaultId: randomUUID() }),
    ).toThrow("ORIGINAL_HTTP_REQUEST_SCOPE");
  });
  it("rejects support claims with zero hits and exploratory noAnswer omissions", () => {
    expect(() => build({ ...response, hits: [] })).toThrow(
      "INCONSISTENT_HTTP_ADMISSION",
    );
    expect(() =>
      build({
        ...response,
        retrievalOutcome: "NO_CANDIDATES",
        hits: [],
        noAnswer: null,
      }),
    ).toThrow("INCONSISTENT_HTTP_ADMISSION");
  });
  it("denied path does not send a request even if API admitted a hit", () => {
    const out = build(response, request, 200, false);
    expect(out.status).toBe("HTTP_NO_ADMITTED_EVIDENCE");
    expect(out.selectedSourceCount).toBe(0);
  });
  it("rejects tampered and incomplete HTTP hits", () => {
    expect(() =>
      build({ ...response, hits: [{ ...hit, unitId: null }] }),
    ).toThrow("UNSAFE_ADMITTED_HTTP_HIT_SHAPE");
    expect(
      build({ ...response, hits: [{ ...hit, revision: "stale" }] }).status,
    ).toBe("HTTP_NO_ADMITTED_EVIDENCE");
  });
});
