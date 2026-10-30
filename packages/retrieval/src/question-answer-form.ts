/**
 * Conservative, language-agnostic-in-intent answer-form check.
 *
 * Only obvious value-seeking wh-questions are classified: a boolean
 * (yes/no/true/false) is not a frequency, time, actor, location, quantity or
 * condition. This is NOT entailment, negation detection or evidence authority.
 * Unknown interrogative patterns are left to the source-governed verifier.
 * The source itself is never scanned for interrogative keywords.
 */
export function explicitlyRequestsNonBooleanAnswer(query: string): boolean {
  if (!query || query.length > 4096) return false;
  const q = query
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .trim()
    .toLocaleLowerCase("und")
    .replace(/\s+/gu, " ");
  // English: require question-initial, explicit requested value / dimension.
  // Do not classify "If X, can Y?" or "When X happens, can Y?" as time
  // questions: those can ask a conditional binary proposition.
  if (
    /^(?:how often|how many|how much|what time|what happens|who(?:se|m)?\b|where\b|why\b|in what (?:cases|circumstances)|under what conditions)\b/u.test(
      q,
    )
  )
    return true;
  if (
    /^when\s+(?:can|could|should|must|may|will|would|do|does|did|is|are|was|were|have|has|had)\b/u.test(
      q,
    )
  )
    return true;
  // Spanish: unambiguous interrogative heads; not an initial conditional
  // clause ("Si ... ¿puedo ...?") and not "¿Es obligatorio ...?"
  if (
    /^¿?\s*(?:cuando|cuanto(?:s|as)?|donde|quien(?:es)?|por que|en que (?:casos|momentos|circunstancias)|a que hora|con que frecuencia|cada cuanto|que ocurre|que sucede)\b/u.test(
      q,
    )
  )
    return true;
  return false;
}
