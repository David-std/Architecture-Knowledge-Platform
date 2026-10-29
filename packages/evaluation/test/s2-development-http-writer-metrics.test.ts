import { describe, expect, it } from "vitest";
import {
  summarizeS2DevelopmentFullHttp,
  type S2HttpWriterSample,
} from "../src/s2-development-http-writer-metrics.js";
const specimen = (values: number[], states: number[] = [200, 200, 200]) =>
  values.map((fullHttpMs, i): S2HttpWriterSample => ({
    caseTag: i % 2 === 0 ? "REVIEWED_EN" : "UNSEEN_NEGATIVE_EN",
    httpStatus: states[i] ?? 200,
    fullHttpMs,
    providerMs: states[i] === 503 ? null : Math.max(0, fullHttpMs - 5),
    status:
      states[i] === 503 ? "PROVIDER_UNAVAILABLE" : "WRITER_ABSTAINED_NO_ANSWER",
    modelInvoked: true,
    productionAdmission: false,
    releaseGateAccepted: false,
  }));
describe("S2 full application HTTP metrics must not silently omit degraded calls", () => {
  it("uses nearest-rank p95 over every measured HTTP response and separates first/repeats", () => {
    const v = summarizeS2DevelopmentFullHttp(
      specimen([10, 20, 30, 40, 50], [200, 200, 503, 200, 200]),
    );
    expect(v).toMatchObject({
      sampleCount: 5,
      degraded: 1,
      degradedFraction: 0.2,
      all: { samples: 5, httpP50Ms: 30, httpP95Ms: 50, http503: 1 },
      firstPerScenario: { samples: 2, httpP95Ms: 20 },
      repeatsPerScenario: { samples: 3, httpP95Ms: 50 },
      referenceLabelsIndependent: false,
      releaseGateAccepted: false,
    });
  });
  it("does not treat provider-only p95 as HTTP p95", () => {
    const v = summarizeS2DevelopmentFullHttp(specimen([100, 200, 400]));
    expect(v.all.httpP95Ms).toBe(400);
    expect(v.all.providerP95Ms).toBe(395);
  });
  it("rejects invalid elapsed time, response status and invented production admission", () => {
    expect(() => summarizeS2DevelopmentFullHttp([])).toThrow(/UNBOUNDED/);
    const cases = specimen([30]);
    expect(() =>
      summarizeS2DevelopmentFullHttp([{ ...cases[0]!, fullHttpMs: -1 }]),
    ).toThrow(/INVALID/);
    expect(() =>
      summarizeS2DevelopmentFullHttp([{ ...cases[0]!, providerMs: 91 }]),
    ).toThrow(/INVALID/);
    expect(() =>
      summarizeS2DevelopmentFullHttp([{ ...cases[0]!, httpStatus: 403 }]),
    ).toThrow(/INVALID/);
    expect(() =>
      summarizeS2DevelopmentFullHttp([
        { ...cases[0]!, releaseGateAccepted: true as false },
      ]),
    ).toThrow(/INVALID/);
  });
});
