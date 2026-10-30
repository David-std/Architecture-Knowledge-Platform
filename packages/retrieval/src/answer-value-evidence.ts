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

/**
 * A source-located answer may express an exact small cardinal in words.
 * This is a narrowly typed value parser, NOT semantic entailment or an
 * instruction to search unrelated source text for quantity words.
 * Multiword numerals, ordinals, approximations and embedded identifiers
 * deliberately remain unsupported until separately evaluated.
 */
const EXACT_CARDINAL_WORDS: Readonly<Record<string, number>> = Object.freeze({
  zero: 0,
  cero: 0,
  one: 1,
  uno: 1,
  una: 1,
  two: 2,
  dos: 2,
  three: 3,
  tres: 3,
  four: 4,
  cuatro: 4,
  five: 5,
  cinco: 5,
  six: 6,
  seis: 6,
  seven: 7,
  siete: 7,
  eight: 8,
  ocho: 8,
  nine: 9,
  nueve: 9,
  ten: 10,
  diez: 10,
  eleven: 11,
  once: 11,
  twelve: 12,
  doce: 12,
  thirteen: 13,
  trece: 13,
  fourteen: 14,
  catorce: 14,
  fifteen: 15,
  quince: 15,
  sixteen: 16,
  dieciseis: 16,
  dieciséis: 16,
  seventeen: 17,
  diecisiete: 17,
  eighteen: 18,
  dieciocho: 18,
  nineteen: 19,
  diecinueve: 19,
  twenty: 20,
  veinte: 20,
});

export function exactSourceCardinalWord(value: string): number | null {
  if (!value || value.length > 24) return null;
  const token = value.normalize("NFC").trim().toLocaleLowerCase("und");
  if (!/^[\p{L}\p{M}]+$/u.test(token)) return null;
  return Object.prototype.hasOwnProperty.call(EXACT_CARDINAL_WORDS, token)
    ? EXACT_CARDINAL_WORDS[token]!
    : null;
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
