import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { selectS2ClaimEvidenceWindows } from "../src/s2-evidence-window-selection.js";
const body = [
  "# Contingency plan",
  "Nebula stores 37 encrypted folders in locker E17.",
  "This rule applies only after the custodian approves retention.",
  "Horizon stores 64 encrypted folders in locker D24.",
  "The emergency exception never authorizes deletion without approval.",
].join("\n");
const bytes = Buffer.from(body, "utf8");
const original = {
  assignedSourceId: "S1",
  sourceSha256: createHash("sha256").update(bytes).digest("hex"),
  exactUtf8Bytes: bytes,
  bodyStartUtf16: 0,
  bodyEndUtf16: body.length,
};
const config = () => ({
  tokenizerId: "pinned-tokenizer@revision-1",
  countTokens: vi.fn(async (p: string, h: string) =>
    Math.ceil((p.length + h.length) / 4),
  ),
  maxTokens: 200,
  maxWindows: 4,
  maxSentencesPerWindow: 2 as const,
});
describe("bounded exact-source evidence window discovery", () => {
  it("optionally reduces duplicate overlapping windows without changing the default ranking", async () => {
    const question = "Where does Nebula store folders?";
    const claim = "Nebula stores folders near Horizon.";
    const a = await selectS2ClaimEvidenceWindows(original, question, claim, {
      ...config(),
      maxWindows: 3,
    });
    const b = await selectS2ClaimEvidenceWindows(original, question, claim, {
      ...config(),
      maxWindows: 3,
      diversityMode: "NON_REDUNDANT",
    });
    expect(a.status).toBe("CANDIDATES");
    expect(b.status).toBe("CANDIDATES");
    expect(b.windows[0]?.exactText).toBe(a.windows[0]?.exactText);
    expect(b.windows.every((w) => w.productionAdmission === false)).toBe(true);
    for (const w of b.windows) {
      expect(body.slice(w.startUtf16, w.endUtf16)).toBe(w.exactText);
      expect(w.modelTokens).toBeLessThanOrEqual(200);
    }
  });
  it("rejects unsupported shadow selection modes", async () => {
    const r = await selectS2ClaimEvidenceWindows(
      original,
      "Where does Nebula store folders?",
      "Nebula stores folders.",
      { ...config(), diversityMode: "UNKNOWN" as "NON_REDUNDANT" },
    );
    expect(r.status).toBe("REJECTED");
  });

  it("selects contiguous original spans, with SHA and UTF-16 replay", async () => {
    const r = await selectS2ClaimEvidenceWindows(
      original,
      "Where are Nebula folders kept?",
      "Nebula stores 37 encrypted folders in E17.",
      config(),
    );
    expect(r.status).toBe("CANDIDATES");
    expect(r.windows.length).toBeGreaterThan(0);
    for (const w of r.windows) {
      expect(body.slice(w.startUtf16, w.endUtf16)).toBe(w.exactText);
      expect(w.sourceSha256).toBe(original.sourceSha256);
      expect(w.productionAdmission).toBe(false);
    }
    expect(r.productionAdmission).toBe(false);
  });
  it("keeps adjacent conditions available for a downstream context verifier", async () => {
    const r = await selectS2ClaimEvidenceWindows(
      original,
      "When does Nebula retain folders?",
      "Nebula retains folders after custodian approval.",
      config(),
    );
    expect(
      r.windows.some((w) => w.exactText.includes("only after the custodian")),
    ).toBe(true);
  });
  it("fails closed on a modified SHA and malformed UTF-8", async () => {
    const a = await selectS2ClaimEvidenceWindows(
      { ...original, sourceSha256: "0".repeat(64) },
      "Where does Nebula keep folders?",
      "Nebula keeps folders.",
      config(),
    );
    expect(a.status).toBe("REJECTED");
    const invalid = Buffer.from([0xc3, 0x28]);
    const b = await selectS2ClaimEvidenceWindows(
      {
        ...original,
        exactUtf8Bytes: invalid,
        sourceSha256: createHash("sha256").update(invalid).digest("hex"),
        bodyStartUtf16: 0,
        bodyEndUtf16: 2,
      },
      "Where does Nebula keep folders?",
      "Nebula keeps folders.",
      config(),
    );
    expect(b.status).toBe("REJECTED");
  });
  it("does not silently truncate overbudget input or bypass tokenizer", async () => {
    const v = config();
    v.maxTokens = 1;
    const r = await selectS2ClaimEvidenceWindows(
      original,
      "Where does Nebula keep folders?",
      "Nebula keeps encrypted folders.",
      v,
    );
    expect(r.windows).toHaveLength(0);
    expect(r.reason).toBe("NO_WINDOW_WITHIN_TOKEN_BUDGET");
    expect(r.overBudget).toBeGreaterThan(0);
    expect(v.countTokens).toHaveBeenCalled();
  });
  it("rejects invalid tokenizers instead of guessing model token counts", async () => {
    const v = config();
    v.countTokens = vi.fn(async () => NaN);
    const r = await selectS2ClaimEvidenceWindows(
      original,
      "Where does Nebula keep folders?",
      "Nebula keeps folders.",
      v,
    );
    expect(r.status).toBe("REJECTED");
    expect(r.reason).toBe("PINNED_TOKENIZER_INVALID");
  });
  it("does not manufacture windows when unrelated claim has no matching terms", async () => {
    const r = await selectS2ClaimEvidenceWindows(
      original,
      "What is zephyrium?",
      "Zephyrium is violet.",
      config(),
    );
    expect(r.status).toBe("INSUFFICIENT");
  });
  it("does not treat lexical selection as verification even for reversed relationships", async () => {
    const r = await selectS2ClaimEvidenceWindows(
      original,
      "Does Nebula store more folders than Horizon?",
      "Horizon stores fewer folders than Nebula.",
      config(),
    );
    expect(r.productionAdmission).toBe(false);
    expect(r.windows.every((w) => !w.productionAdmission)).toBe(true);
  });
  it("prevents surrogate-pair offset corruption", async () => {
    const source = "🗂️ Nebula retains documents.\n😀 Horizon retains records.";
    const b = Buffer.from(source);
    const r = await selectS2ClaimEvidenceWindows(
      {
        ...original,
        exactUtf8Bytes: b,
        sourceSha256: createHash("sha256").update(b).digest("hex"),
        bodyEndUtf16: source.length,
      },
      "Does Horizon retain records?",
      "Horizon retains records.",
      config(),
    );
    expect(r.status).toBe("CANDIDATES");
    expect(
      r.windows.every(
        (w) => source.slice(w.startUtf16, w.endUtf16) === w.exactText,
      ),
    ).toBe(true);
  });
});
