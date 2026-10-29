/** DEV-only HTTP orchestration measurements. Not a single-server-request p95 or S2 admission. */
export type S2HttpJourneyCase =
  "REVIEWED_EN" | "REVIEWED_ES" | "UNSEEN_NEGATIVE_EN";
export type S2HttpJourneyPhase = { httpStatus: number; elapsedMs: number };
export type S2HttpJourneySample = {
  caseTag: S2HttpJourneyCase;
  arm: "DETERMINISTIC";
  search: S2HttpJourneyPhase;
  context: S2HttpJourneyPhase | null;
  writer: S2HttpJourneyPhase | null;
  endToEndMs: number;
  outcome:
    | "SEARCH_FAILED"
    | "CONTEXT_FAILED"
    | "CONTEXT_NOT_SUPPORTED"
    | "WRITER_RECEIPT"
    | "WRITER_FAILED";
  writerModelInvoked: boolean;
  productionAdmission: false;
  releaseGateAccepted: false;
};
const finite = (x: number) => Number.isFinite(x) && x >= 0;
const validPhase = (x: S2HttpJourneyPhase | null): boolean =>
  x === null ||
  (Number.isSafeInteger(x.httpStatus) &&
    (x.httpStatus === 0 || (x.httpStatus >= 200 && x.httpStatus <= 599)) &&
    finite(x.elapsedMs));
const percentile = (xs: number[], p: number): number | null => {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return Math.round(sorted[Math.ceil(sorted.length * p) - 1]! * 100) / 100;
};
const aggregate = (items: readonly S2HttpJourneySample[]) => ({
  count: items.length,
  endToEndP50Ms: percentile(
    items.map((x) => x.endToEndMs),
    0.5,
  ),
  endToEndP95Ms: percentile(
    items.map((x) => x.endToEndMs),
    0.95,
  ),
  searchP95Ms: percentile(
    items.map((x) => x.search.elapsedMs),
    0.95,
  ),
  contextP95Ms: percentile(
    items.flatMap((x) => (x.context ? [x.context.elapsedMs] : [])),
    0.95,
  ),
  writerP95Ms: percentile(
    items.flatMap((x) => (x.writer ? [x.writer.elapsedMs] : [])),
    0.95,
  ),
  failures: items.filter((x) =>
    ["SEARCH_FAILED", "CONTEXT_FAILED", "WRITER_FAILED"].includes(x.outcome),
  ).length,
  contextWithheld: items.filter((x) => x.outcome === "CONTEXT_NOT_SUPPORTED")
    .length,
  writerReceipts: items.filter((x) => x.outcome === "WRITER_RECEIPT").length,
  http503: items.filter((x) =>
    [x.search, x.context, x.writer].some((stage) => stage?.httpStatus === 503),
  ).length,
  timeouts: items.filter((x) =>
    [x.search, x.context, x.writer].some((stage) => stage?.httpStatus === 0),
  ).length,
});
/** Stage latencies are diagnostic and never summed to claim a p95 journey. */
export function summarizeS2DevelopmentHttpJourney(
  samples: readonly S2HttpJourneySample[],
) {
  if (!samples.length || samples.length > 5000)
    throw Error("S2_HTTP_JOURNEY_EMPTY_OR_UNBOUNDED");
  for (const x of samples) {
    if (
      !["REVIEWED_EN", "REVIEWED_ES", "UNSEEN_NEGATIVE_EN"].includes(
        x.caseTag,
      ) ||
      x.arm !== "DETERMINISTIC" ||
      !validPhase(x.search) ||
      !validPhase(x.context) ||
      !validPhase(x.writer) ||
      !finite(x.endToEndMs) ||
      x.endToEndMs + 5 <
        x.search.elapsedMs +
          (x.context?.elapsedMs ?? 0) +
          (x.writer?.elapsedMs ?? 0) ||
      x.productionAdmission !== false ||
      x.releaseGateAccepted !== false ||
      typeof x.writerModelInvoked !== "boolean"
    )
      throw Error("S2_HTTP_JOURNEY_INVALID_SAMPLE");
    const searchOk = x.search.httpStatus === 200;
    const contextOk = x.context?.httpStatus === 200;
    const writerOk = x.writer?.httpStatus === 200;
    const expected = !searchOk
      ? "SEARCH_FAILED"
      : x.context === null || !contextOk
        ? "CONTEXT_FAILED"
        : x.writer === null
          ? "CONTEXT_NOT_SUPPORTED"
          : writerOk
            ? "WRITER_RECEIPT"
            : "WRITER_FAILED";
    if (
      x.outcome !== expected ||
      (!searchOk && (x.context !== null || x.writer !== null)) ||
      (x.context === null && x.writer !== null) ||
      (x.writer === null && x.writerModelInvoked)
    )
      throw Error("S2_HTTP_JOURNEY_INVALID_STAGE_TRANSITION");
  }
  return {
    schemaVersion: "akp.s2.development-http-composed-journey.v1" as const,
    status: "DEV_ONLY_NOT_INDEPENDENT" as const,
    sampleCount: samples.length,
    all: aggregate(samples),
    cases: Object.fromEntries(
      [...new Set(samples.map((x) => x.caseTag))]
        .sort()
        .map((tag) => [
          tag,
          aggregate(samples.filter((x) => x.caseTag === tag)),
        ]),
    ),
    // Search HTTP and Context HTTP independently run retrieval: this probe
    // does NOT represent one internal retrieval invocation.
    httpSequence: [
      "POST /v1/search",
      "POST /v1/context (search + admission + packet persistence)",
      "POST /v1/s2/writer-claims/generate-audit (when supported)",
    ] as const,
    searchExecutedTwice: true as const,
    readerTimeSeparatelyMeasured: false as const,
    tokenCountsSeparatelyMeasured: false as const,
    pairedCandidateArmMeasured: false as const,
    referenceLabelsIndependent: false as const,
    sourceFamiliesIndependent: false as const,
    semanticGoldVerified: false as const,
    fullWriterClaimsIndependentlyReviewed: false as const,
    modelColdStartVerified: false as const,
    policyDefaultsChanged: false as const,
    releaseGateAccepted: false as const,
  };
}
