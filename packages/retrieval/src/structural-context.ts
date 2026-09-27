export interface StructuralContextUnit {
  body: string;
  unitType: string;
  parentBody?: string | null;
  parentUnitType?: string | null;
  focusText?: string | null;
}

const FOCUS_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "de",
  "del",
  "el",
  "en",
  "for",
  "from",
  "in",
  "is",
  "la",
  "las",
  "los",
  "of",
  "on",
  "or",
  "para",
  "por",
  "que",
  "the",
  "to",
  "un",
  "una",
  "with",
  "y",
]);

function boundedWindow(text: string, needle: string, maxChars: number): string {
  const limit = Math.max(1, Math.trunc(maxChars));
  if (text.length <= limit) return text;
  const index = needle ? text.indexOf(needle) : -1;
  if (index < 0) {
    const suffix = limit > 1 ? "…" : "";
    return `${text.slice(0, limit - suffix.length).trimEnd()}${suffix}`;
  }
  const prefix = index > 0 ? "…" : "";
  const suffix = index + needle.length < text.length ? "…" : "";
  const available = Math.max(1, limit - prefix.length - suffix.length);
  const start = Math.max(
    0,
    Math.min(
      index - Math.floor(available / 2),
      Math.max(0, text.length - available),
    ),
  );
  const end = Math.min(text.length, start + available);
  return `${prefix}${text.slice(start, end).trim()}${suffix}`.slice(0, limit);
}

function focusTerms(value: string): string[] {
  return [
    ...new Set(
      (value.toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? []).filter(
        (token) => token.length >= 3 && !FOCUS_STOPWORDS.has(token),
      ),
    ),
  ];
}

function occurrencePositions(text: string, term: string): number[] {
  const positions: number[] = [];
  let offset = 0;
  while (positions.length < 32) {
    const index = text.indexOf(term, offset);
    if (index < 0) break;
    positions.push(index);
    offset = index + Math.max(1, term.length);
  }
  return positions;
}

/**
 * Selects a deterministic bounded window that contains as many query terms as
 * possible. This is retrieval presentation, not answerability: it only keeps a
 * lexical match visible so a later verifier can inspect the real passage.
 */
function boundedWindowAroundFocus(
  text: string,
  focusText: string,
  maxChars: number,
): string {
  const limit = Math.max(1, Math.trunc(maxChars));
  if (text.length <= limit) return text;

  const terms = focusTerms(focusText);
  if (terms.length === 0) return boundedWindow(text, "", limit);

  const normalizedText = text.toLocaleLowerCase("en-US");
  const positions = terms.flatMap((term) =>
    occurrencePositions(normalizedText, term).map((index) => ({ index, term })),
  );
  if (positions.length === 0) return boundedWindow(text, "", limit);

  const visibleChars = Math.max(1, limit - 2);
  let best:
    | {
        start: number;
        termCount: number;
        matchedChars: number;
        distance: number;
      }
    | undefined;

  for (const candidate of positions) {
    const start = Math.max(
      0,
      Math.min(
        candidate.index - Math.floor(visibleChars / 2),
        Math.max(0, text.length - visibleChars),
      ),
    );
    const end = Math.min(text.length, start + visibleChars);
    const windowText = normalizedText.slice(start, end);
    const matchedTerms = terms.filter((term) => windowText.includes(term));
    const firstPosition = Math.min(
      ...matchedTerms.flatMap((term) => {
        const local = windowText.indexOf(term);
        return local < 0 ? [] : [local];
      }),
    );
    const lastPosition = Math.max(
      ...matchedTerms.flatMap((term) => {
        const local = windowText.lastIndexOf(term);
        return local < 0 ? [] : [local + term.length];
      }),
    );
    const score = {
      start,
      termCount: matchedTerms.length,
      matchedChars: matchedTerms.reduce((sum, term) => sum + term.length, 0),
      distance:
        Number.isFinite(firstPosition) && Number.isFinite(lastPosition)
          ? lastPosition - firstPosition
          : Number.MAX_SAFE_INTEGER,
    };
    if (
      !best ||
      score.termCount > best.termCount ||
      (score.termCount === best.termCount &&
        score.matchedChars > best.matchedChars) ||
      (score.termCount === best.termCount &&
        score.matchedChars === best.matchedChars &&
        score.distance < best.distance) ||
      (score.termCount === best.termCount &&
        score.matchedChars === best.matchedChars &&
        score.distance === best.distance &&
        score.start < best.start)
    ) {
      best = score;
    }
  }

  if (!best) return boundedWindow(text, "", limit);
  const prefix = best.start > 0 ? "…" : "";
  const available = Math.max(1, limit - prefix.length - 1);
  const end = Math.min(text.length, best.start + available);
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${text.slice(best.start, end).trim()}${suffix}`.slice(
    0,
    limit,
  );
}

/**
 * Rehydrates a matched atomic unit with only its bounded structural parent.
 * A DOCUMENT parent is deliberately ignored because it is the complete dossier
 * container; returning it would defeat structural retrieval and token budgets.
 *
 * For oversized units, focusText only selects the visible window. It does not
 * establish answer support; answerability remains a separate verifier concern.
 */
export function rehydrateStructuralContext(
  unit: StructuralContextUnit,
  maxChars = 3600,
): string {
  const child = unit.body.trim();
  if (!child) return "";
  const focus = unit.focusText?.trim();
  const boundedChild = focus
    ? boundedWindowAroundFocus(child, focus, Math.min(maxChars, 1600))
    : boundedWindow(child, child, Math.min(maxChars, 1600));
  const parent = unit.parentBody?.trim();
  if (!parent || unit.parentUnitType === "DOCUMENT" || parent === child) {
    return boundedChild;
  }
  if (focus && child.length > maxChars) {
    return boundedWindowAroundFocus(parent, focus, maxChars);
  }
  return boundedWindow(parent, child, maxChars);
}
