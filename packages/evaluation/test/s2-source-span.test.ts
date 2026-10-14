import { describe, expect, it } from "vitest";
import {
  scoreS2SpanObservations,
  s2WilsonLower,
  type S2SpanFixture,
  type S2SpanObservation,
} from "../src/s2-source-span.js";

const fixture: S2SpanFixture = {
  sourceDocuments: [
    {
      id: "synthetic-a",
      domain: "measurement-contract",
      units: [
        { id: "unit-a", text: "Protocol A holds seven signed receipts." },
        { id: "unit-b", text: "Protocol B holds nine signed receipts." },
      ],
    },
  ],
  cases: [
    {
      id: "q1",
      sourceId: "synthetic-a",
      language: "en",
      answerable: true,
      gold: [{ unitId: "unit-a", quote: "seven signed receipts" }],
    },
    {
      id: "q2",
      sourceId: "synthetic-a",
      language: "es",
      answerable: true,
      gold: [{ unitId: "unit-b", quote: "nine signed receipts" }],
    },
    {
      id: "q3",
      sourceId: "synthetic-a",
      language: "en",
      answerable: false,
      gold: [],
    },
    {
      id: "q4",
      sourceId: "synthetic-a",
      language: "es",
      answerable: false,
      gold: [],
    },
  ],
};

const observation = (
  caseId: string,
  overrides: Partial<S2SpanObservation> = {},
): S2SpanObservation => ({
  caseId,
  rankedUnitIds: [],
  admitted: [],
  elapsedMs: 40,
  degraded: false,
  ...overrides,
});

describe("S2 exact source-span measurement (not a live retrieval test)", () => {
  it("reports unexecuted holdouts as NO_OBSERVATIONS, never a synthetic pass", () => {
    const result = scoreS2SpanObservations(fixture, []);
    expect(result.status).toBe("NO_OBSERVATIONS");
    expect(result.recallAt10).toBeNull();
    expect(result.falseAdmissionRate).toBeNull();
    expect(result.finalAnswerCorrectRate).toBeNull();
    expect(result.meanExactInputTokens).toBeNull();
    expect(result.missingCaseIds).toHaveLength(4);
  });

  it("keeps unit recall, admitted quote exactness and negative FAR separate", () => {
    const observations: S2SpanObservation[] = [
      observation("q1", {
        rankedUnitIds: ["unit-a", "unit-b"],
        admitted: [
          {
            unitId: "unit-a",
            startOffset: 17,
            endOffset: 38,
            quote: "seven signed receipts",
          },
        ],
        elapsedMs: 10,
      }),
      observation("q2", {
        rankedUnitIds: ["unit-a", "unit-b"],
        admitted: [
          {
            unitId: "unit-a",
            startOffset: 17,
            endOffset: 38,
            quote: "seven signed receipts",
          },
        ],
        elapsedMs: 20,
        degraded: true,
      }),
      observation("q3", { elapsedMs: 30 }),
      observation("q4", {
        admitted: [
          {
            unitId: "unit-b",
            startOffset: 17,
            endOffset: 37,
            quote: "nine signed receipts",
          },
        ],
        elapsedMs: 40,
      }),
    ];
    const score = scoreS2SpanObservations(fixture, observations);
    expect(score.status).toBe("MEASURED_NOT_GATEABLE");
    expect(score.recallAt1).toBe(0.5);
    expect(score.recallAt5).toBe(1);
    expect(score.falseAdmissionRate).toBe(0.5);
    expect(score.exactGoldQuoteCoverage).toBeCloseTo(1 / 3);
    expect(score.p95Ms).toBe(40);
    expect(score.degradedRate).toBe(0.25);
    expect(score.finalAnswerCorrectRate).toBeNull();
    expect(score.meanExactInputTokens).toBeNull();
  });

  it("rejects duplicate observations and fabricated gold references", () => {
    expect(() =>
      scoreS2SpanObservations(fixture, [observation("q1"), observation("q1")]),
    ).toThrow("S2_OBSERVATION_UNKNOWN_OR_DUPLICATE_CASE");
    const invalid: S2SpanFixture = {
      ...fixture,
      cases: [
        {
          ...fixture.cases[0]!,
          gold: [{ unitId: "unit-z", quote: "invented" }],
        },
      ],
    };
    expect(() => scoreS2SpanObservations(invalid, [])).toThrow(
      "S2_FIXTURE_GOLD_SPAN_NOT_SOURCE_BOUND",
    );
  });

  it("rejects unscoped, unknown and duplicate ranked units before scoring", () => {
    expect(() =>
      scoreS2SpanObservations(fixture, [
        observation("q1", { rankedUnitIds: ["unit-a", "unit-a"] }),
      ]),
    ).toThrow("S2_OBSERVATION_UNSCOPED_OR_DUPLICATE_RANK");
    expect(() =>
      scoreS2SpanObservations(fixture, [
        observation("q1", { rankedUnitIds: ["other-vault-unit"] }),
      ]),
    ).toThrow("S2_OBSERVATION_UNSCOPED_OR_DUPLICATE_RANK");
    const otherVault: S2SpanFixture = {
      sourceDocuments: [
        ...fixture.sourceDocuments,
        {
          id: "synthetic-other",
          domain: "other-domain",
          units: [
            { id: "unit-foreign", text: "Secret foreign source content." },
          ],
        },
      ],
      cases: fixture.cases,
    };
    expect(() =>
      scoreS2SpanObservations(otherVault, [
        observation("q1", { rankedUnitIds: ["unit-foreign"] }),
      ]),
    ).toThrow("S2_OBSERVATION_UNSCOPED_OR_DUPLICATE_RANK");
  });

  it("never infers exact model tokens from missing tokenizer evidence", () => {
    const observations = [observation("q1", { exactInputTokens: 42 })];
    expect(() => scoreS2SpanObservations(fixture, observations)).toThrow(
      "S2_OBSERVATION_TOKENIZER_NOT_PINNED",
    );
    expect(s2WilsonLower(0, 0)).toBeNull();
    expect(s2WilsonLower(20, 20)).toBeLessThan(1);
  });

  it("does not misreport unexecuted admission as zero false admissions", () => {
    const rankedOnly = fixture.cases.map((item) =>
      observation(item.id, { admissionMeasured: false }),
    );
    const result = scoreS2SpanObservations(fixture, rankedOnly);
    expect(result.status).toBe("MEASURED_NOT_GATEABLE");
    expect(result.admissionObservedCases).toBe(0);
    expect(result.falseAdmissionRate).toBeNull();
    expect(result.exactGoldQuoteCoverage).toBeNull();
    expect(() =>
      scoreS2SpanObservations(fixture, [
        observation("q1", {
          admissionMeasured: false,
          admitted: [
            {
              unitId: "unit-a",
              startOffset: 17,
              endOffset: 38,
              quote: "seven signed receipts",
            },
          ],
        }),
      ]),
    ).toThrow("S2_OBSERVATION_MALFORMED");
  });

  it("does not present partial runs or absent adjudication as final evidence", () => {
    const result = scoreS2SpanObservations(fixture, [
      observation("q1", {
        rankedUnitIds: ["unit-a"],
        exactInputTokens: 23,
        tokenizerRevision: "real-model:rev-a",
      }),
    ]);
    expect(result.status).toBe("PARTIAL_NOT_GATEABLE");
    expect(result.tokenizerRevision).toBeNull();
    expect(result.meanExactInputTokens).toBeNull();
    expect(result.missingCaseIds).toEqual(["q2", "q3", "q4"]);
  });
});
