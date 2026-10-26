/** Exact UTF-16 source binding for a reader's proposed answer value.
 * Unicode canonical composition, case and whitespace are normalization only;
 * never numeric words, translations, stemmers, synonyms or model repair.
 * Matches inside words, hyphenated IDs and duplicates have no unique anchor.
 */
import type { QueryConditionedEvidenceSpan } from "./answerability.js";

const atom = /[\p{L}\p{N}\p{M}_-]/u;
const norm = (s: string): string =>
  s.normalize("NFC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();

export function uniqueSourceAnswerValueSpan(
  quote: string,
  proposedValue: string,
  citedStartUtf16: number,
): QueryConditionedEvidenceSpan | null {
  if (
    !quote ||
    !proposedValue.trim() ||
    proposedValue.length > 2048 ||
    !Number.isSafeInteger(citedStartUtf16) ||
    citedStartUtf16 < 0
  )
    return null;
  const units: Array<{ start: number; end: number }> = [];
  let indexed = "";
  for (const grapheme of new Intl.Segmenter("und", {
    granularity: "grapheme",
  }).segment(quote)) {
    const transformed = grapheme.segment
      .normalize("NFC")
      .toLocaleLowerCase("und");
    for (const char of transformed) {
      const glyph = /\s/u.test(char) ? " " : char;
      if (glyph === " " && indexed.endsWith(" ")) {
        units[units.length - 1]!.end = grapheme.index + grapheme.segment.length;
      } else {
        indexed += glyph;
        for (let n = 0; n < glyph.length; n++)
          units.push({
            start: grapheme.index,
            end: grapheme.index + grapheme.segment.length,
          });
      }
    }
  }
  const target = norm(proposedValue);
  if (!target || indexed.length !== units.length) return null;
  const found: QueryConditionedEvidenceSpan[] = [];
  for (
    let at = indexed.indexOf(target);
    at !== -1;
    at = indexed.indexOf(target, at + 1)
  ) {
    const from = units[at]!.start;
    const to = units[at + target.length - 1]!.end;
    const left = quote[from - 1] ?? "";
    const right = quote[to] ?? "";
    if (
      (atom.test(left) && atom.test(target[0] ?? "")) ||
      (atom.test(right) && atom.test(target.at(-1) ?? ""))
    )
      continue;
    const original = quote.slice(from, to);
    if (norm(original) !== target) continue;
    found.push({
      startOffset: citedStartUtf16 + from,
      endOffset: citedStartUtf16 + to,
    });
    if (found.length > 1) return null;
  }
  return found.length === 1 ? found[0]! : null;
}

export function sourceAnswerValueMatches(
  originalValue: string,
  reportedValue: string,
): boolean {
  return (
    Boolean(originalValue) &&
    Boolean(reportedValue.trim()) &&
    norm(originalValue) === norm(reportedValue)
  );
}
