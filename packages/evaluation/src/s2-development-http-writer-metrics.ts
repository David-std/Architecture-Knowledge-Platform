/** Development-only, actual HTTP response-to-response timing; never production admission. */
export type S2HttpWriterSample = {
  caseTag: "REVIEWED_EN" | "REVIEWED_ES" | "UNSEEN_NEGATIVE_EN";
  httpStatus: number;
  fullHttpMs: number;
  providerMs: number | null;
  status: string;
  modelInvoked: boolean;
  productionAdmission: false;
  releaseGateAccepted: false;
};
const finite = (x: number) => Number.isFinite(x) && x >= 0;
const percentile = (xs: number[], p: number): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(p * sorted.length) - 1]! * 100) / 100;
};
const aggregate = (xs: S2HttpWriterSample[]) => ({
  samples: xs.length,
  httpP50Ms: percentile(
    xs.map((x) => x.fullHttpMs),
    0.5,
  ),
  httpP95Ms: percentile(
    xs.map((x) => x.fullHttpMs),
    0.95,
  ),
  providerP50Ms: percentile(
    xs.map((x) => x.providerMs).filter((v): v is number => v !== null),
    0.5,
  ),
  providerP95Ms: percentile(
    xs.map((x) => x.providerMs).filter((v): v is number => v !== null),
    0.95,
  ),
  http503: xs.filter((x) => x.httpStatus === 503).length,
  http200: xs.filter((x) => x.httpStatus === 200).length,
});
/** Stage: already authorized original-SOURCE test fixture, previously reviewed or unseen.
 * These observations cannot be a blind/unseen-family acceptance holdout.
 * Includes 503s in HTTP latency and degradation denominator; no silent exclusions.
 */
export function summarizeS2DevelopmentFullHttp(
  samples: readonly S2HttpWriterSample[],
) {
  if (samples.length === 0 || samples.length > 5000)
    throw Error("S2_FULL_HTTP_EMPTY_OR_UNBOUNDED");
  const seen = new Set<S2HttpWriterSample["caseTag"]>();
  for (const s of samples) {
    if (
      !["REVIEWED_EN", "REVIEWED_ES", "UNSEEN_NEGATIVE_EN"].includes(
        s.caseTag,
      ) ||
      !Number.isSafeInteger(s.httpStatus) ||
      ![200, 503].includes(s.httpStatus) ||
      !finite(s.fullHttpMs) ||
      !(s.providerMs === null || finite(s.providerMs)) ||
      (s.providerMs !== null && s.providerMs > s.fullHttpMs + 5) ||
      typeof s.status !== "string" ||
      s.status.length === 0 ||
      s.status.length > 180 ||
      s.productionAdmission !== false ||
      s.releaseGateAccepted !== false ||
      typeof s.modelInvoked !== "boolean"
    )
      throw Error("S2_FULL_HTTP_SAMPLE_INVALID");
    seen.add(s.caseTag);
  }
  const first = new Set<S2HttpWriterSample["caseTag"]>();
  const cold: S2HttpWriterSample[] = [];
  const warm: S2HttpWriterSample[] = [];
  for (const s of samples) {
    if (first.has(s.caseTag)) warm.push(s);
    else {
      first.add(s.caseTag);
      cold.push(s);
    }
  }
  const degraded = samples.filter((x) => x.httpStatus === 503).length;
  return {
    schemaVersion: "akp.s2.development-full-http-writer-metrics.v1" as const,
    status: "AUTHENTICATED_HTTP_REAL_PROVIDER_DEV_ONLY_NOT_GOLD" as const,
    sampleCount: samples.length,
    distinctScenarioCount: seen.size,
    degraded,
    degradedFraction: degraded / samples.length,
    all: aggregate([...samples]),
    firstPerScenario: aggregate(cold),
    repeatsPerScenario: aggregate(warm),
    cases: Object.fromEntries(
      [...seen]
        .sort()
        .map((k) => [k, aggregate(samples.filter((s) => s.caseTag === k))]),
    ),
    // Provider time is diagnostic only; never add it to full HTTP duration.
    coldWarmClassification:
      "FIRST_OBSERVED_PER_SCENARIO_NOT_PROVEN_MODEL_COLD_START" as const,
    referenceLabelsIndependent: false as const,
    sourceFamiliesIndependent: false as const,
    independentSemanticGoldVerified: false as const,
    fullWriterClaimsIndependentlyReviewed: false as const,
    policyDefaultsChanged: false as const,
    releaseGateAccepted: false as const,
  };
}
