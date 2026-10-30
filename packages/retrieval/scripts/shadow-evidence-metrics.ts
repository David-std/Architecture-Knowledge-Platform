export function shadowEvidenceMetrics(
  observations: readonly {
    goldLabels: readonly string[];
    candidates: readonly {
      label: string;
      score: number;
      directionCompatible: boolean;
      spanCorrect: boolean | null;
      polarityMargin?: number | null;
    }[];
  }[],
  threshold: number,
  minimumPolarityMargin = 0,
) {
  let positiveCases = 0;
  let negativeCases = 0;
  let falseAbstentions = 0;
  let falseAcceptances = 0;
  let selected = 0;
  let selectedGold = 0;
  let selectedWrong = 0;
  let selectedGoldWithSpan = 0;
  let selectedGoldSpanCorrect = 0;

  for (const observation of observations) {
    const gold = new Set(observation.goldLabels);
    const accepted = observation.candidates.filter(
      (candidate) =>
        candidate.directionCompatible &&
        candidate.score >= threshold &&
        (candidate.polarityMargin === null ||
          candidate.polarityMargin === undefined ||
          candidate.polarityMargin >= minimumPolarityMargin),
    );
    const acceptedGold = accepted.filter((candidate) =>
      gold.has(candidate.label),
    );
    const acceptedWrong = accepted.filter(
      (candidate) => !gold.has(candidate.label),
    );

    selected += accepted.length;
    selectedGold += acceptedGold.length;
    selectedWrong += acceptedWrong.length;
    for (const candidate of acceptedGold) {
      if (candidate.spanCorrect !== null) {
        selectedGoldWithSpan += 1;
        if (candidate.spanCorrect) selectedGoldSpanCorrect += 1;
      }
    }

    if (gold.size > 0) {
      positiveCases += 1;
      if (acceptedGold.length === 0) falseAbstentions += 1;
    } else {
      negativeCases += 1;
      if (accepted.length > 0) falseAcceptances += 1;
    }
  }

  return {
    positiveCases,
    negativeCases,
    falseAbstentions,
    falseAbstentionRate:
      positiveCases === 0 ? null : falseAbstentions / positiveCases,
    falseAcceptances,
    falseAcceptanceRate:
      negativeCases === 0 ? null : falseAcceptances / negativeCases,
    selectedCandidates: selected,
    selectedGoldCandidates: selectedGold,
    wrongSelections: selectedWrong,
    supportSelectionPrecision: selected === 0 ? null : selectedGold / selected,
    spanEvaluatedCandidates: selectedGoldWithSpan,
    spanCorrectCandidates: selectedGoldSpanCorrect,
    spanAnnotationCoverage:
      selectedGold === 0 ? null : selectedGoldWithSpan / selectedGold,
    // A partial annotation set cannot certify all selected gold spans.
    spanAccuracy:
      selectedGoldWithSpan === 0 || selectedGoldWithSpan !== selectedGold
        ? null
        : selectedGoldSpanCorrect / selectedGoldWithSpan,
  };
}
