import { createHash } from "node:crypto";
import type { S2PairedAdjudicatedCase } from "./s2-prospective-paired-score.js";

/** Cluster-resampled paired diagnostics. NOT an independent confidence certificate. */
const hash = (v: string) => createHash("sha256").update(v).digest();
const q = (sorted: number[], p: number): number | null => {
  if (!sorted.length) return null;
  const rank = (sorted.length - 1) * p,
    lo = Math.floor(rank),
    hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
};
const frac = (a: number, b: number) => (b > 0 ? a / b : null);
type RateName = "precision" | "negativeFar" | "correctAnswer";
type Arm = "DETERMINISTIC" | "CANDIDATE";
type Bin = { numerator: number; denominator: number };
const bin = (
  group: readonly S2PairedAdjudicatedCase[],
  arm: Arm,
  kind: RateName,
): Bin => {
  let n = 0,
    d = 0;
  for (const c of group) {
    const x = c.outcomes[arm];
    if (kind === "precision") {
      d += x.admittedPassages.length;
      n += x.admittedPassages.filter(
        (p) => p.sourceExact && p.semanticallySufficient,
      ).length;
    } else if (kind === "negativeFar") {
      if (c.sourceGold !== "NOT_ANSWERABLE") continue;
      d++;
      n += Number(x.admittedPassages.length > 0);
    } else {
      d++;
      n += Number(
        (c.sourceGold === "ANSWERABLE_EXPLICIT" &&
          x.finalAnswer === "CORRECT") ||
          (c.sourceGold === "NOT_ANSWERABLE" &&
            x.finalAnswer === "JUSTIFIED_ABSTENTION"),
      );
    }
  }
  return { numerator: n, denominator: d };
};
const averaged = (
  rows: readonly S2PairedAdjudicatedCase[],
  arm: Arm,
  kind: RateName,
) => {
  const en = bin(
    rows.filter((c) => c.language === "en"),
    arm,
    kind,
  );
  const es = bin(
    rows.filter((c) => c.language === "es"),
    arm,
    kind,
  );
  const e = frac(en.numerator, en.denominator),
    s = frac(es.numerator, es.denominator);
  return e === null || s === null ? null : (e + s) / 2;
};
const summarize = (x: number[]) => ({
  lower95: q(x, 0.025),
  upper95: q(x, 0.975),
  replicatesWithDefinedMetric: x.length,
});
export function s2ClusterStratifiedPairedBootstrap(
  cases: readonly S2PairedAdjudicatedCase[],
  options: { replicates?: number } = {},
) {
  const reps = options.replicates ?? 2048;
  if (!Number.isSafeInteger(reps) || reps < 128 || reps > 4096)
    throw Error("S2_CLUSTER_BOOTSTRAP_REPLICATE_BUDGET");
  const families = [...new Set(cases.map((c) => c.publisherFamily))].sort();
  // Small-cluster bootstrap percentiles can be misleading; never report a CI
  // with fewer than eight complete source families.
  if (families.length < 8 || families.length > 200)
    return {
      status: "INSUFFICIENT_FAMILY_CLUSTERS" as const,
      sourceFamilyCount: families.length,
      seedProtocol: "SHA256_FAMILY_CASE_KEYS_V1" as const,
      independentGoldVerified: false as const,
      releaseGateAccepted: false as const,
    };
  const grouped = new Map(
    families.map((f) => [f, cases.filter((c) => c.publisherFamily === f)]),
  );
  const seed = createHash("sha256")
    .update(
      "AKP:S2:PAIRED:BOOTSTRAP:V1\0" +
        [...cases]
          .map((c) => c.caseId + "|" + c.publisherFamily + "|" + c.language)
          .sort()
          .join("\n"),
    )
    .digest("hex");
  const kinds = ["precision", "negativeFar", "correctAnswer"] as const;
  const data = Object.fromEntries(
    kinds.map((k) => [
      k,
      {
        deterministic: [] as number[],
        candidate: [] as number[],
        candidateMinusDeterministic: [] as number[],
      },
    ]),
  ) as Record<
    RateName,
    {
      deterministic: number[];
      candidate: number[];
      candidateMinusDeterministic: number[];
    }
  >;
  for (let i = 0; i < reps; i++) {
    const sample: S2PairedAdjudicatedCase[] = [];
    // A common cluster resample for both arms preserves pairing.
    for (let j = 0; j < families.length; j++) {
      const n =
        hash(seed + "\0" + i + "\0" + j).readUInt32BE(0) % families.length;
      sample.push(...grouped.get(families[n]!)!);
    }
    for (const kind of kinds) {
      const a = averaged(sample, "DETERMINISTIC", kind);
      const b = averaged(sample, "CANDIDATE", kind);
      if (a !== null) data[kind].deterministic.push(a);
      if (b !== null) data[kind].candidate.push(b);
      if (a !== null && b !== null)
        data[kind].candidateMinusDeterministic.push(b - a);
    }
  }
  return {
    status: "EXPLORATORY_STRATIFIED_CLUSTER_BOOTSTRAP_NOT_CERTIFIED" as const,
    sourceFamilyCount: families.length,
    replicatesRequested: reps,
    seedProtocol: "SHA256_FAMILY_CASE_KEYS_V1" as const,
    seedSha256: seed,
    languageWeights: { en: 0.5, es: 0.5 },
    sourceResampling: "PAIRED_WHOLE_FAMILIES_WITH_REPLACEMENT" as const,
    rateIntervals: Object.fromEntries(
      kinds.map((kind) => [
        kind,
        {
          deterministic: summarize(data[kind].deterministic),
          candidate: summarize(data[kind].candidate),
          candidateMinusDeterministic: summarize(
            data[kind].candidateMinusDeterministic,
          ),
        },
      ]),
    ),
    independentGoldVerified: false as const,
    sourceFamilyExchangeabilityProven: false as const,
    clusterConfidenceIntervalCertified: false as const,
    releaseGateAccepted: false as const,
  };
}
