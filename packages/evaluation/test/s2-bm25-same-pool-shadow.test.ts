import { describe, expect, it } from "vitest";
import {
  s2Bm25Tokens,
  shadowS2Bm25SamePool,
} from "../src/s2-bm25-same-pool-shadow.js";

describe("S2 offline BM25 shadow (not a source sufficiency or release gate)", () => {
  it("preserves accented EN/ES terms, negations and technical identifiers", () => {
    expect(s2Bm25Tokens("¿Quién NO aprobó la política? M-7 api_key")).toEqual([
      "quién",
      "no",
      "aprobó",
      "la",
      "política",
      "m-7",
      "api_key",
    ]);
    expect(s2Bm25Tokens("año ano")).toEqual(["año", "ano"]);
    expect(s2Bm25Tokens("A.P.I. v2.1")).toEqual(["a", "p", "i", "v2", "1"]);
  });

  it("documents a Spanish morphological false-rank: a generic passage can beat a rare identifier", () => {
    const result = shadowS2Bm25SamePool({
      query: "¿Quién aprobó M-7 tras la auditoría?",
      candidates: [
        {
          candidateKey: "generic",
          passage: "La auditoría aprobó el informe general. Auditoría general.",
          baselineRank: 1,
        },
        {
          candidateKey: "exact",
          passage: "M-7 fue aprobado por Lira después de la auditoría.",
          baselineRank: 2,
        },
        {
          candidateKey: "wrong",
          passage: "M-9 fue rechazado por Lira antes de la auditoría.",
          baselineRank: 3,
        },
      ],
    });
    // Deliberate diagnostic limitation: Spanish inflection and topic-token
    // repetition can outrank the answer-bearing M-7 unit. Never retune the
    // scorer on one fixture to conceal this counterexample.
    expect(result.ordered[0]?.candidateKey).toBe("generic");
    expect(
      result.ordered.find((c) => c.candidateKey === "exact")?.score,
    ).toBeGreaterThan(0);
    expect(result).toMatchObject({
      poolSize: 3,
      model: "BM25_OKAPI",
      sourceTruthVerified: false,
      answersVerified: false,
      productionAdmission: false,
      releaseGateAccepted: false,
    });
  });

  it("can locate an exact technical identifier when other lexical terms are not competing", () => {
    const ranked = shadowS2Bm25SamePool({
      query: "M-7",
      candidates: [
        { candidateKey: "m9", passage: "M-9 fue rechazado.", baselineRank: 1 },
        { candidateKey: "m7", passage: "M-7 fue aprobado.", baselineRank: 2 },
      ],
    });
    expect(ranked.ordered[0]?.candidateKey).toBe("m7");
    expect(ranked.ordered[1]?.score).toBe(0);
  });

  it("applies corpus rarity and length normalization rather than raw term counts", () => {
    const result = shadowS2Bm25SamePool({
      query: "latency",
      candidates: [
        {
          candidateKey: "short",
          passage: "latency threshold",
        },
        {
          candidateKey: "long",
          passage: "latency " + "irrelevant ".repeat(100),
        },
        {
          candidateKey: "absent",
          passage: "capacity budget",
        },
      ],
    });
    expect(result.ordered.map((candidate) => candidate.candidateKey)).toEqual([
      "short",
      "long",
      "absent",
    ]);
    expect(result.ordered[0]?.score).toBeGreaterThan(result.ordered[1]!.score);
    expect(result.ordered[2]?.score).toBe(0);
  });

  it("shows that BM25 cannot certify actor, negation, time or answer role", () => {
    const result = shadowS2Bm25SamePool({
      query: "Did Lira approve the report on 2026-09-13?",
      candidates: [
        {
          candidateKey: "true",
          passage: "Lira approved the report on 2026-09-13.",
        },
        {
          candidateKey: "false-actor",
          passage: "Miro approved the report on 2026-09-13. Lira observed.",
        },
        {
          candidateKey: "false-negation",
          passage: "Lira did not approve the report on 2026-09-13.",
        },
        {
          candidateKey: "false-date",
          passage: "Lira approved the report on 2026-09-14.",
        },
      ],
    });
    expect(
      result.ordered.find((c) => c.candidateKey === "false-negation")?.score,
    ).toBeGreaterThan(0);
    expect(
      result.ordered.find((c) => c.candidateKey === "false-actor")?.score,
    ).toBeGreaterThan(0);
    expect(
      result.ordered.find((c) => c.candidateKey === "false-date")?.score,
    ).toBeGreaterThan(0);
    expect(result.releaseGateAccepted).toBe(false);
  });

  it("refuses duplicate identities or unbounded input instead of pretending there is a ranked source", () => {
    const candidate = { candidateKey: "doc:unit", passage: "retrieved" };
    expect(() =>
      shadowS2Bm25SamePool({
        query: "retrieved",
        candidates: [candidate, { ...candidate, passage: "another revision" }],
      }),
    ).toThrow("S2_BM25_AMBIGUOUS_OR_UNBOUNDED_SOURCE");
    expect(() =>
      shadowS2Bm25SamePool({
        query: "",
        candidates: [candidate],
      }),
    ).toThrow("S2_BM25_INVALID_QUERY_OR_BOUNDED_POOL");
    expect(() =>
      shadowS2Bm25SamePool({
        query: "retrieved",
        candidates: [{ ...candidate, passage: "x".repeat(16_385) }],
      }),
    ).toThrow("S2_BM25_AMBIGUOUS_OR_UNBOUNDED_SOURCE");
  });

  it("is deterministic under input permutation when scores tie and uses no provider/model", () => {
    const candidates = [
      { candidateKey: "a", passage: "alpha", baselineRank: 1 },
      { candidateKey: "b", passage: "beta", baselineRank: 2 },
    ];
    const first = shadowS2Bm25SamePool({ query: "missing", candidates });
    const reordered = shadowS2Bm25SamePool({
      query: "missing",
      candidates: [...candidates].reverse(),
    });
    expect(first.ordered).toEqual(reordered.ordered);
    expect(first.ordered.every((c) => c.score === 0)).toBe(true);
  });
});
