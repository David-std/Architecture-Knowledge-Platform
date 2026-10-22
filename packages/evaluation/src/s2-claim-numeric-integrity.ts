/**
 * Generic evidence integrity guard for explicit numeric atoms in a proposed
 * claim. NLI cannot be relied upon to preserve every number: mismatches are
 * barred before semantic inference, never repaired from similarity.
 *
 * This does not establish relations, units or arithmetic derivations.
 * Calculations and spelled-out quantities require a separate attested proof.
 */
export function explicitClaimNumbersBoundToQuote(
  quote: string,
  claim: string,
): { readonly eligible: boolean; readonly reason: string } {
  if (!quote.trim() || !claim.trim())
    return { eligible: false, reason: "EXPLICIT_NUMERIC_INPUT_EMPTY" };
  if (quote.length > 12000 || claim.length > 4096)
    return { eligible: false, reason: "EXPLICIT_NUMERIC_INPUT_UNBOUNDED" };
  const normalize = (value: string): string =>
    value.normalize("NFKC").normalize("NFC");
  const q = normalize(quote),
    c = normalize(claim);
  const extract = (s: string) =>
    [...s.matchAll(/[0-9]+(?:[.,][0-9]+)*/gu)].map((m) => {
      const raw = m[0];
      const numeric = /^[0-9]+$/u.test(raw)
        ? raw.replace(/^0+(?=[0-9])/u, "")
        : raw;
      const at = m.index;
      const signedNegative =
        at > 0 &&
        s[at - 1] === "-" &&
        (at < 2 || !/[\p{L}\p{N}]/u.test(s[at - 2]!));
      return signedNegative ? "-" + numeric : numeric;
    });
  // No guessing equivalence of Unicode numeral systems not handled by this
  // exact comparison; such evidence requires a separate numeric parser.
  const allDigitCharacters = (s: string) => [...s.matchAll(/\p{Nd}/gu)].length;
  if (
    allDigitCharacters(q) !== [...q.matchAll(/[0-9]/gu)].length ||
    allDigitCharacters(c) !== [...c.matchAll(/[0-9]/gu)].length
  )
    return { eligible: false, reason: "NON_ASCII_NUMERIC_SCRIPT_NOT_ATTESTED" };
  const available = new Set(extract(q));
  for (const value of extract(c))
    if (!available.has(value))
      return { eligible: false, reason: "EXPLICIT_CLAIM_NUMBER_NOT_IN_QUOTE" };
  return { eligible: true, reason: "EXPLICIT_NUMERIC_VALUES_NOT_CONTRADICTED" };
}
