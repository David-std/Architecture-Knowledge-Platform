import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assessS2WindowedClaim } from "../src/s2-windowed-claim-diagnostics.js";
import type { S2SemanticProbe } from "../src/s2-semantic-evidence.js";
const body = [
  "The Nova station controls locker 37.",
  "The Horizon station controls locker 64.",
  "Horizon does not control locker 37.",
].join("\n");
const bytes = Buffer.from(body);
const source = {
  assignedSourceId: "PINNED",
  sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  exactUtf8Bytes: bytes,
  bodyStartUtf16: 0,
  bodyEndUtf16: body.length,
};
const select = {
  tokenizerId: "tokenizer@rev1",
  countTokens: async (p: string, h: string) =>
    Math.ceil((p.length + h.length) / 4),
  maxTokens: 128,
  maxWindows: 3,
  maxSentencesPerWindow: 1 as const,
};
const probe = (
  id: string,
  decide: (quote: string) => "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT",
): S2SemanticProbe => ({
  id,
  verify: async (input) => {
    const decision = decide(input.exactQuote);
    return {
      decision,
      reason: "SYNTHETIC_PORT",
      ...(decision === "INSUFFICIENT"
        ? {}
        : {
            evidenceSpan: { startUtf16: 0, endUtf16: input.exactQuote.length },
          }),
    };
  },
});
const semantic = (
  fn: (quote: string) => "SUPPORTS" | "CONTRADICTS" | "INSUFFICIENT",
) => ({
  questionRelevanceProbe: probe("qa@fixed", () => "SUPPORTS" as const),
  claimEntailmentProbe: probe("nli@fixed", fn),
  timeoutMs: 500,
});
describe("source-window semantic aggregation is evaluation only", () => {
  it("replays source windows and reports candidate support without product admission", async () => {
    const x = await assessS2WindowedClaim(
      "Which station controls locker 37?",
      "The Nova station controls locker 37.",
      source,
      select,
      semantic((q) => (q.includes("Nova") ? "SUPPORTS" : "INSUFFICIENT")),
    );
    expect(x.status).toBe("SUPPORTED_CANDIDATE");
    expect(x.productionAdmission).toBe(false);
    expect(x.releaseGateAccepted).toBe(false);
    expect(
      x.results.every(
        (r) => r.attribution.status === "VERBATIM_UNIQUE_SOURCE_BOUND",
      ),
    ).toBe(true);
  });
  it("vetoes a supported candidate when another source window explicitly conflicts", async () => {
    const x = await assessS2WindowedClaim(
      "Which station controls locker 37?",
      "The Nova station controls locker 37.",
      source,
      select,
      semantic((q) =>
        q.includes("Nova")
          ? "SUPPORTS"
          : q.includes("does not")
            ? "CONTRADICTS"
            : "INSUFFICIENT",
      ),
    );
    expect(x.status).toBe("CONTRADICTED");
    expect(x.reason).toBe("CONFLICTING_SOURCE_WINDOW_EVIDENCE");
  });
  it("refuses direct numeric mismatch without calling models", async () => {
    const x = await assessS2WindowedClaim(
      "Which station controls locker 38?",
      "The Nova station controls locker 38.",
      source,
      select,
      semantic(() => "SUPPORTS"),
    );
    expect(x.status).toBe("INSUFFICIENT");
  });
  it("rejects tampered originals before model selection", async () => {
    const x = await assessS2WindowedClaim(
      "Which station controls locker 37?",
      "The Nova station controls locker 37.",
      { ...source, sourceSha256: "0".repeat(64) },
      select,
      semantic(() => "SUPPORTS"),
    );
    expect(x.status).toBe("REJECTED");
    expect(x.evaluatedWindows).toBe(0);
  });
  it("never fabricates a positive when all candidates are irrelevant", async () => {
    const x = await assessS2WindowedClaim(
      "Which animal is zephyrium?",
      "Zephyrium is purple.",
      source,
      select,
      semantic(() => "SUPPORTS"),
    );
    expect(x.status).toBe("INSUFFICIENT");
    expect(x.evaluatedWindows).toBe(0);
  });
});
