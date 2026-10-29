import { describe, expect, it } from "vitest";
import {
  summarizeS2DevelopmentHttpJourney,
  summarizeS2DevelopmentContextWriter,
  type S2ContextWriterSample,
  type S2HttpJourneySample,
} from "../src/s2-development-http-journey-metrics.js";

const sample = (elapsed: number): S2HttpJourneySample => ({
  caseTag: "REVIEWED_EN",
  arm: "DETERMINISTIC",
  search: { httpStatus: 200, elapsedMs: 10 },
  context: { httpStatus: 200, elapsedMs: 15 },
  writer: { httpStatus: 200, elapsedMs: elapsed - 30 },
  endToEndMs: elapsed,
  outcome: "WRITER_RECEIPT",
  writerModelInvoked: true,
  productionAdmission: false,
  releaseGateAccepted: false,
});
describe("development HTTP composed journey metrics", () => {
  it("uses the same attempt's external clock and includes failures in p95", () => {
    const a = sample(100);
    const b: S2HttpJourneySample = {
      ...sample(220),
      caseTag: "UNSEEN_NEGATIVE_EN",
      writer: null,
      context: { httpStatus: 503, elapsedMs: 195 },
      outcome: "CONTEXT_FAILED",
      writerModelInvoked: false,
    };
    const c = sample(300);
    const result = summarizeS2DevelopmentHttpJourney([a, b, c]);
    expect(result.all).toMatchObject({
      count: 3,
      endToEndP50Ms: 220,
      endToEndP95Ms: 300,
      http503: 1,
      failures: 1,
    });
    expect(result).toMatchObject({
      searchExecutedTwice: true,
      readerTimeSeparatelyMeasured: false,
      pairedCandidateArmMeasured: false,
      releaseGateAccepted: false,
    });
  });
  it("counts unsupported context without pretending it invoked the Writer", () => {
    const withheld: S2HttpJourneySample = {
      ...sample(80),
      writer: null,
      outcome: "CONTEXT_NOT_SUPPORTED",
      writerModelInvoked: false,
    };
    expect(summarizeS2DevelopmentHttpJourney([withheld]).all).toMatchObject({
      contextWithheld: 1,
      writerReceipts: 0,
    });
  });
  it("rejects impossible stage transitions, negative timings and invented release", () => {
    expect(() => summarizeS2DevelopmentHttpJourney([])).toThrow(/UNBOUNDED/);
    expect(() =>
      summarizeS2DevelopmentHttpJourney([{ ...sample(100), endToEndMs: 5 }]),
    ).toThrow(/INVALID_SAMPLE/);
    expect(() =>
      summarizeS2DevelopmentHttpJourney([
        { ...sample(100), search: { httpStatus: 403, elapsedMs: 10 } },
      ]),
    ).toThrow(/STAGE_TRANSITION/);
    expect(() =>
      summarizeS2DevelopmentHttpJourney([
        { ...sample(100), releaseGateAccepted: true as false },
      ]),
    ).toThrow(/INVALID_SAMPLE/);
  });
});

const contextWriterSample = (elapsed: number): S2ContextWriterSample => ({
  caseTag: "REVIEWED_EN",
  arm: "DETERMINISTIC",
  context: { httpStatus: 200, elapsedMs: 23 },
  writer: { httpStatus: 200, elapsedMs: elapsed - 30 },
  endToEndMs: elapsed,
  outcome: "WRITER_RECEIPT",
  writerModelInvoked: true,
  productionAdmission: false,
  releaseGateAccepted: false,
});

describe("one-retrieval Context to Writer HTTP development metrics", () => {
  it("measures one external wall clock, without adding p95 stages", () => {
    const result = summarizeS2DevelopmentContextWriter([
      contextWriterSample(100),
      contextWriterSample(250),
      contextWriterSample(400),
    ]);
    expect(result.all).toMatchObject({
      count: 3,
      endToEndP50Ms: 250,
      endToEndP95Ms: 400,
      contextP95Ms: 23,
      writerP95Ms: 370,
    });
    expect(result).toMatchObject({
      separateSearchHttpIssued: false,
      singleServerHttpRequest: false,
      semanticGoldVerified: false,
      releaseGateAccepted: false,
    });
  });
  it("includes context 503/timeout, Writer 503 and pre-Writer withholding", () => {
    const samples: S2ContextWriterSample[] = [
      {
        ...contextWriterSample(300),
        context: { httpStatus: 503, elapsedMs: 290 },
        writer: null,
        writerModelInvoked: false,
        outcome: "CONTEXT_FAILED",
      },
      {
        ...contextWriterSample(270),
        context: { httpStatus: 200, elapsedMs: 15 },
        writer: { httpStatus: 503, elapsedMs: 250 },
        outcome: "WRITER_FAILED",
      },
      {
        ...contextWriterSample(120),
        caseTag: "UNSEEN_NEGATIVE_EN",
        writer: null,
        writerModelInvoked: false,
        outcome: "CONTEXT_NOT_SUPPORTED",
      },
      {
        ...contextWriterSample(350),
        context: { httpStatus: 0, elapsedMs: 345 },
        writer: null,
        writerModelInvoked: false,
        outcome: "CONTEXT_FAILED",
      },
    ];
    expect(summarizeS2DevelopmentContextWriter(samples).all).toMatchObject({
      count: 4,
      endToEndP95Ms: 350,
      failures: 3,
      contextWithheld: 1,
      writerReceipts: 0,
      http503: 2,
      timeouts: 1,
    });
  });
  it("rejects imaginary Writer invocation, false release and invalid timing", () => {
    expect(() => summarizeS2DevelopmentContextWriter([])).toThrow(/UNBOUNDED/);
    expect(() =>
      summarizeS2DevelopmentContextWriter([
        {
          ...contextWriterSample(100),
          writer: null,
          writerModelInvoked: true,
          outcome: "CONTEXT_NOT_SUPPORTED",
        },
      ]),
    ).toThrow(/STAGE_TRANSITION/);
    expect(() =>
      summarizeS2DevelopmentContextWriter([
        { ...contextWriterSample(100), releaseGateAccepted: true as false },
      ]),
    ).toThrow(/INVALID_SAMPLE/);
    expect(() =>
      summarizeS2DevelopmentContextWriter([{ ...contextWriterSample(5) }]),
    ).toThrow(/INVALID_SAMPLE/);
  });
});
