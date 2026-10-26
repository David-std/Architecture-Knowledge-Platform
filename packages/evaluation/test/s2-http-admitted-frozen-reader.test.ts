import { createHash, randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { freezeWriterFromAuthenticatedSearchResponse } from "../src/s2-authenticated-http-writer-bridge.js";
import {
  freezeS2HttpAdmittedReaderPlan,
  assessS2HttpAdmittedReader,
} from "../src/s2-http-admitted-frozen-reader.js";
import type { S2SemanticEvidenceConfig } from "../src/s2-semantic-evidence.js";

const sha = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");
const identifiers = {
  space: randomUUID(),
  vault: randomUUID(),
  document: randomUUID(),
  unit: randomUUID(),
};
const originalText =
  "# Relé de despliegues\nEl relé Boreal únicamente permite publicar después de dos revisiones.\n" +
  "No ejecuta despliegues si una revisión continúa pendiente.\n";
const literal =
  "El relé Boreal únicamente permite publicar después de dos revisiones.";
const question = "¿Cuándo permite publicar el relé Boreal?";
const original = {
  vaultId: identifiers.vault,
  documentId: identifiers.document,
  path: "engineering/relay.md",
  revision: "rev-new-source-01",
  fileSha256: sha(Buffer.from(originalText, "utf8")),
  fileBytes: Buffer.from(originalText, "utf8"),
  bodyStartUtf16: 0,
  bodyEndUtf16: originalText.length,
};
const hit = {
  vaultId: original.vaultId,
  documentId: original.documentId,
  unitId: identifiers.unit,
  document: { path: original.path },
  revision: original.revision,
  lifecycle: "ACTIVE",
  refreshStatus: "CURRENT",
  excerpt: literal,
  citations: [original.path + "@" + original.revision],
};
const request = {
  query: question,
  spaceId: identifiers.space,
  vaultId: identifiers.vault,
  vaultIds: [],
  federated: false,
  types: [],
  mode: "SOURCE_BACKED",
};
const scope = {
  question,
  caseKeySha256: sha("es\0" + question),
  caseManifestSha256: sha("new-synthetic-cases"),
  sourceManifestSha256: sha("new-synthetic-sources"),
  sourceFamilySha256: sha("new-relay-family"),
  executedCommitSha: "f".repeat(40),
  language: "es" as const,
  model: "mock",
  modelDigestSha256: sha("mock-model"),
  systemPrompt: "Cite original sources only.",
  seed: 99,
  contextTokens: 4096 as const,
  maxOutputTokens: 512,
  vaultId: identifiers.vault,
  maxRetrievedDocuments: 1,
};
const response = (admit: boolean) => ({
  mode: "SOURCE_BACKED",
  scope: {
    spaceId: identifiers.space,
    vaultIds: [identifiers.vault],
    federated: false,
  },
  retrievalOutcome: admit ? "SUPPORTED" : "EXPLORATORY_ONLY",
  hits: admit ? [hit] : [],
  exploratoryHits: admit ? [] : [hit],
  noAnswer: admit ? null : { status: "INSUFFICIENT_KNOWLEDGE" },
});
const capture = (
  admit = true,
  options?: {
    revision?: string;
    windowStart?: number;
    windowEnd?: number;
  },
) =>
  freezeWriterFromAuthenticatedSearchResponse({
    expectedSpaceId: identifiers.space,
    expectedVaultId: identifiers.vault,
    expectedQuestion: question,
    requestBytes: Buffer.from(JSON.stringify(request)),
    responseBytes: Buffer.from(
      JSON.stringify({
        ...response(admit),
        hits: admit
          ? [{ ...hit, revision: options?.revision ?? hit.revision }]
          : [],
      }),
    ),
    responseStatus: 200,
    authorizationReportedByCaller: true,
    bridgeScope: scope,
    originals: [original],
    ...(options?.windowStart === undefined
      ? {}
      : {
          sourceWindows: [
            {
              vaultId: original.vaultId,
              documentId: original.documentId,
              path: original.path,
              revision: original.revision,
              startUtf16: options.windowStart,
              endUtf16: options.windowEnd!,
            },
          ],
        }),
    pathAuthorizer: (path, vault) =>
      path === original.path && vault === original.vaultId,
  });
const input = (admit = true) => ({
  http: capture(admit),
  rawHttpRequestBytes: Buffer.from(JSON.stringify(request)),
  rawHttpResponseBytes: Buffer.from(JSON.stringify(response(admit))),
  original,
  passageId: "SRC1",
  originalQuestion: question,
  proposedClaim: "Boreal permite publicar únicamente tras dos revisiones.",
  exactSourceQuote: literal,
});
const probes = (sufficient = true) => {
  const relevance = vi.fn(async (x: { exactQuote: string }) => ({
    decision: "SUPPORTS" as const,
    reason: "QUESTION_RELEVANCE_PROPOSAL",
    evidenceSpan: { startUtf16: 0, endUtf16: x.exactQuote.length },
  }));
  const claim = vi.fn(async (x: { exactQuote: string }) =>
    sufficient
      ? {
          decision: "SUPPORTS" as const,
          reason: "CLAIM_SUPPORT_PROPOSAL",
          evidenceSpan: { startUtf16: 0, endUtf16: x.exactQuote.length },
        }
      : {
          decision: "INSUFFICIENT" as const,
          reason: "MODALITY_NOT_ESTABLISHED",
        },
  );
  const config: S2SemanticEvidenceConfig = {
    questionRelevanceProbe: {
      id: "question@mock",
      verify: relevance,
    },
    claimEntailmentProbe: {
      id: "claim@mock",
      verify: claim,
    },
  };
  return { config, relevance, claim };
};
const tokens = {
  questionToken: "SUPPORTS@Q1",
  claimToken: "SUPPORTS@Q1",
};
describe("S2 actual HTTP-admitted source-bound evaluation composer (mock HTTP capture)", () => {
  it("binds the exact admitted original, revision and frozen tokens before model invocation", async () => {
    const data = input();
    const plan = freezeS2HttpAdmittedReaderPlan(data);
    expect(plan.httpRequestSha256).toBe(data.http.requestSha256);
    expect(plan.httpResponseSha256).toBe(data.http.responseSha256);
    expect(plan.selectedSourceRevisionSha256).toBe(sha(original.revision));
    expect(plan.selection.frozen.options[0]?.text).toBe(literal);
    const judged = probes();
    const result = await assessS2HttpAdmittedReader(
      data,
      plan,
      tokens,
      judged.config,
    );
    expect(result).toMatchObject({
      status: "SOURCE_BOUND_SEMANTIC_CANDIDATE_ONLY",
      originalQuoteStartUtf16: originalText.indexOf(literal),
      productionAdmission: false,
      releaseGateAccepted: false,
      semanticRelationIndependentlyVerified: false,
    });
    expect(judged.relevance).toHaveBeenCalledOnce();
    expect(judged.claim).toHaveBeenCalledOnce();
  });

  it("accepts Fastify's empty inline citations while preserving missing-marker provenance", () => {
    const actualShape = {
      ...response(true),
      hits: [{ ...hit, citations: [] }],
    };
    const raw = Buffer.from(JSON.stringify(actualShape));
    const http = freezeWriterFromAuthenticatedSearchResponse({
      expectedSpaceId: identifiers.space,
      expectedVaultId: identifiers.vault,
      expectedQuestion: question,
      requestBytes: Buffer.from(JSON.stringify(request)),
      responseBytes: raw,
      responseStatus: 200,
      authorizationReportedByCaller: true,
      bridgeScope: scope,
      originals: [original],
      pathAuthorizer: (path, vault) =>
        path === original.path && vault === identifiers.vault,
    });
    const plan = freezeS2HttpAdmittedReaderPlan({
      ...input(),
      http,
      rawHttpResponseBytes: raw,
    });
    expect(plan).toMatchObject({
      originalHttpQuoteReplay: "REPLAY_VERIFIED",
      inlineCitationMarkers: "SOME_ABSENT",
      releaseGateAccepted: false,
    });
  });

  it("cannot promote an exploratory HTTP hit into evaluator evidence", async () => {
    const data = input(false);
    expect(data.http.status).toBe("HTTP_NO_ADMITTED_EVIDENCE");
    expect(data.http.exploratoryHitCount).toBe(1);
    expect(() => freezeS2HttpAdmittedReaderPlan(data)).toThrow(
      "S2_HTTP_FROZEN_NO_ADMITTED_PROVENANCE",
    );
  });

  it("fails closed when authenticated response already carries different document revision", () => {
    const data = {
      ...input(),
      http: capture(true, { revision: "stale-revision" }),
    };
    expect(data.http.status).toBe("HTTP_NO_ADMITTED_EVIDENCE");
    expect(() => freezeS2HttpAdmittedReaderPlan(data)).toThrow();
  });

  it("refuses to choose a quote that exists in the original but was NOT in the admitted window", () => {
    const start = originalText.indexOf("No ejecuta");
    const data = {
      ...input(),
      http: capture(true, {
        windowStart: start,
        windowEnd: originalText.length,
      }),
    };
    expect(data.http.status).toBe("HTTP_ADMITTED_WRITER_READY");
    expect(() => freezeS2HttpAdmittedReaderPlan(data)).toThrow(
      "S2_HTTP_FROZEN_QUOTE_OUTSIDE_ADMITTED_PASSAGE",
    );
  });

  it("requires the admitted HTTP excerpt itself to contain the selected quote", () => {
    const alteredResponse = {
      ...response(true),
      hits: [
        {
          ...hit,
          excerpt: "No ejecuta despliegues si una revisión continúa pendiente.",
        },
      ],
    };
    // A full-document writer freeze is possible when the *hit excerpt*
    // misses the needed quote. The raw HTTP replay forbids this promotion.
    const bytes = Buffer.from(JSON.stringify(alteredResponse));
    const admitted = freezeWriterFromAuthenticatedSearchResponse({
      expectedSpaceId: identifiers.space,
      expectedVaultId: identifiers.vault,
      expectedQuestion: question,
      requestBytes: Buffer.from(JSON.stringify(request)),
      responseBytes: bytes,
      responseStatus: 200,
      authorizationReportedByCaller: true,
      bridgeScope: scope,
      originals: [original],
      pathAuthorizer: (path, vault) =>
        path === original.path && vault === identifiers.vault,
    });
    expect(admitted.status).toBe("HTTP_ADMITTED_WRITER_READY");
    expect(() =>
      freezeS2HttpAdmittedReaderPlan({
        ...input(),
        http: admitted,
        rawHttpResponseBytes: bytes,
      }),
    ).toThrow("S2_HTTP_FROZEN_RAW_HTTP_OR_EXCERPT_REPLAY_FAILED");
  });

  it("rejects modified HTTP bytes even if preprocessed admission metadata is unchanged", () => {
    const data = input();
    const tampered = Buffer.from(
      JSON.stringify({
        ...response(true),
        hits: [{ ...hit, excerpt: "Fabricated claim." }],
      }),
    );
    expect(() =>
      freezeS2HttpAdmittedReaderPlan({
        ...data,
        rawHttpResponseBytes: tampered,
      }),
    ).toThrow("S2_HTTP_FROZEN_RAW_HTTP_OR_EXCERPT_REPLAY_FAILED");
  });

  it("rejects revision, path, question and selected passage drift after freezing", async () => {
    const data = input();
    const plan = freezeS2HttpAdmittedReaderPlan(data);
    for (const changed of [
      { ...data, originalQuestion: question + " inválida" },
      { ...data, original: { ...original, revision: "unexpected" } },
      { ...data, original: { ...original, path: "another/relay.md" } },
      { ...data, passageId: "SRC8" },
      { ...data, http: { ...data.http, responseSha256: sha("modified") } },
      { ...data, proposedClaim: "Boreal publica sin ninguna revisión." },
    ]) {
      const probesLocal = probes();
      const result = await assessS2HttpAdmittedReader(
        changed,
        plan,
        tokens,
        probesLocal.config,
      );
      expect(result.status).toBe("HELD");
      expect(probesLocal.relevance).not.toHaveBeenCalled();
      expect(probesLocal.claim).not.toHaveBeenCalled();
    }
  });

  it("retains an original-bound citation if the semantic relation is not proven", async () => {
    const data = input();
    const p = freezeS2HttpAdmittedReaderPlan(data);
    const judge = probes(false);
    const result = await assessS2HttpAdmittedReader(
      data,
      p,
      tokens,
      judge.config,
    );
    expect(result).toMatchObject({
      status: "HELD",
      reason: "SEMANTIC_OR_F3_PROOF_NOT_ESTABLISHED",
      assessment: { status: "INSUFFICIENT", productionAdmission: false },
      releaseGateAccepted: false,
    });
  });
});
