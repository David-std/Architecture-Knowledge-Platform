import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  replayS2RawHttpEvidence,
  type S2RawHttpEvidenceInput,
} from "../src/s2-http-evidence-replay.js";

const sourceText =
  "# Source\n\n🚀 The Atlas relay keeps a 37-minute recovery target.\n";
const excerpt = "The Atlas relay keeps a 37-minute recovery target.";
const encode = (value: string) => Buffer.from(value, "utf8");
const sha = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
const vaultId = "authorized-vault";
const documentId = "source-37";
const revision = "revision-1";
const path = "reviewed/atlas.md";
const start = sourceText.indexOf(excerpt);
const base = (): S2RawHttpEvidenceInput => {
  const req = encode(
    JSON.stringify({
      vaultId,
      query: "What is the Atlas recovery target?",
    }),
  );
  const res = encode(
    JSON.stringify({
      scope: { vaultIds: [vaultId] },
      hits: [
        {
          documentId,
          vaultId,
          revision,
          excerpt,
          citations: [path + "@" + revision],
          document: { path },
        },
      ],
    }),
  );
  const original = encode(sourceText);
  return {
    rawRequestBytes: req,
    externallyPinnedRequestSha256: sha(req),
    rawResponseBytes: res,
    externallyPinnedResponseSha256: sha(res),
    httpStatus: 200,
    expectedVaultId: vaultId,
    originals: [
      {
        documentId,
        vaultId,
        path,
        revision,
        originalSha256: sha(original),
        bytes: original,
        bodyStartUtf16: 0,
        bodyEndUtf16: sourceText.length,
      },
    ],
    quotes: [
      {
        hitIndex: 0,
        documentId,
        quote: excerpt,
        startUtf16: start,
        endUtf16: start + excerpt.length,
      },
    ],
  };
};
const responseChanged = (
  input: S2RawHttpEvidenceInput,
  replacement: (res: Record<string, unknown>) => void,
): S2RawHttpEvidenceInput => {
  const res = JSON.parse(
    new TextDecoder().decode(input.rawResponseBytes),
  ) as Record<string, unknown>;
  replacement(res);
  const bytes = encode(JSON.stringify(res));
  return {
    ...input,
    rawResponseBytes: bytes,
    externallyPinnedResponseSha256: sha(bytes),
  };
};
describe("raw HTTP and original citation replay", () => {
  it("replays literal citation through exact pinned HTTP response and UTF-16 original", () => {
    const result = replayS2RawHttpEvidence(base());
    expect(result.status).toBe("REPLAY_VERIFIED");
    expect(result.inlineCitationMarkers).toBe("ALL_PRESENT");
    expect(result.literalQuotesVerified).toBe(1);
    expect(result.requestResponseBytesReplayed).toBe(true);
    expect(result.quotedSourceSpansReplayed).toBe(true);
    expect(result.externalPinCustodyAuthenticated).toBe(false);
    expect(result.authorizationIndependentlyVerified).toBe(false);
    expect(result.semanticEntailmentVerified).toBe(false);
    expect(result.completeAnswerCorrectness).toBeNull();
    expect(result.releaseGateAccepted).toBe(false);
  });
  it("records absence of optional Fastify inline citations without inventing a marker", () => {
    const withAbsentMarkers = responseChanged(base(), (r) => {
      (r.hits as Record<string, unknown>[])[0]!.citations = [];
    });
    const replayed = replayS2RawHttpEvidence(withAbsentMarkers);
    expect(replayed).toMatchObject({
      status: "REPLAY_VERIFIED",
      inlineCitationMarkers: "SOME_ABSENT",
      quotedSourceSpansReplayed: true,
      authorizationIndependentlyVerified: false,
      semanticEntailmentVerified: false,
      releaseGateAccepted: false,
    });
    const absentShape = responseChanged(base(), (r) => {
      delete (r.hits as Record<string, unknown>[])[0]!.citations;
    });
    expect(replayS2RawHttpEvidence(absentShape).status).toBe("REJECTED");
  });
  it("rejects modified request and response bytes after pinning", () => {
    const input = base();
    expect(
      replayS2RawHttpEvidence({
        ...input,
        rawRequestBytes: encode("{}"),
      }).reason,
    ).toBe("HTTP_BYTES_NOT_EXTERNALLY_PINNED");
    expect(
      replayS2RawHttpEvidence({
        ...input,
        rawResponseBytes: encode("{}"),
      }).reason,
    ).toBe("HTTP_BYTES_NOT_EXTERNALLY_PINNED");
  });
  it("rejects forged or cross-vault response scope despite fresh pin", () => {
    const result = replayS2RawHttpEvidence(
      responseChanged(base(), (r) => {
        r.scope = { vaultIds: ["unauthorized-vault"] };
      }),
    );
    expect(result.reason).toBe("HTTP_REQUEST_RESPONSE_SCOPE_INVALID");
    expect(result.releaseGateAccepted).toBe(false);
  });
  it("rejects a hit from another vault or a wrong revision", () => {
    const altered = responseChanged(base(), (r) => {
      (r.hits as Record<string, unknown>[])[0]!.vaultId = "unauthorized";
    });
    expect(replayS2RawHttpEvidence(altered).reason).toBe(
      "HTTP_HIT_CITATION_OR_EXCERPT_MISMATCH",
    );
    const stale = responseChanged(base(), (r) => {
      (r.hits as Record<string, unknown>[])[0]!.revision = "stale";
    });
    expect(replayS2RawHttpEvidence(stale).status).toBe("REJECTED");
  });
  it("rejects missing source-linked citation even when an excerpt looks correct", () => {
    const altered = responseChanged(base(), (r) => {
      (r.hits as Record<string, unknown>[])[0]!.citations = ["invented"];
    });
    expect(replayS2RawHttpEvidence(altered).reason).toBe(
      "HTTP_HIT_CITATION_OR_EXCERPT_MISMATCH",
    );
  });
  it("rejects tampered source bytes or an incorrect asserted original span", () => {
    const input = base();
    const changedSource = input.originals.map((s) => ({
      ...s,
      bytes: encode(sourceText.replace("37-minute", "93-minute")),
    }));
    expect(
      replayS2RawHttpEvidence({
        ...input,
        originals: changedSource,
      }).reason,
    ).toBe("ORIGINAL_SOURCE_IDENTITY_OR_HASH_INVALID");
    expect(
      replayS2RawHttpEvidence({
        ...input,
        quotes: input.quotes.map((q) => ({
          ...q,
          startUtf16: q.startUtf16 + 1,
        })),
      }).reason,
    ).toBe("QUOTE_DOES_NOT_REPLAY_AT_ORIGINAL_UTF16_SPAN");
  });
  it("rejects a quote that is not actually in the returned HTTP excerpt", () => {
    const altered = responseChanged(base(), (r) => {
      (r.hits as Record<string, unknown>[])[0]!.excerpt = "some unrelated text";
    });
    expect(replayS2RawHttpEvidence(altered).reason).toBe(
      "HTTP_HIT_CITATION_OR_EXCERPT_MISMATCH",
    );
  });
  it("rejects duplicate claimed spans, invalid UTF-16 boundaries and empty proof sets", () => {
    const input = base();
    expect(
      replayS2RawHttpEvidence({
        ...input,
        quotes: [...input.quotes, ...input.quotes],
      }).reason,
    ).toBe("DUPLICATED_CITATION_PROOF");
    const surrogatePosition = sourceText.indexOf("🚀") + 1;
    expect(
      replayS2RawHttpEvidence({
        ...input,
        quotes: [
          {
            ...input.quotes[0]!,
            startUtf16: surrogatePosition,
          },
        ],
      }).status,
    ).toBe("REJECTED");
    expect(
      replayS2RawHttpEvidence({
        ...input,
        quotes: [],
      }).reason,
    ).toBe("SOURCE_SET_OR_QUOTES_UNBOUNDED");
  });
  it("does not turn successful replay into semantic approval or authenticated scope evidence", () => {
    const ok = replayS2RawHttpEvidence(base());
    expect(ok).toMatchObject({
      status: "REPLAY_VERIFIED",
      authorizationIndependentlyVerified: false,
      semanticEntailmentVerified: false,
      completeAnswerCorrectness: null,
      releaseGateAccepted: false,
    });
  });
});
