export interface StructuralContextUnit {
  body: string;
  unitType: string;
  parentBody?: string | null;
  parentUnitType?: string | null;
}

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

/**
 * Rehydrates a matched atomic unit with only its bounded structural parent.
 * A DOCUMENT parent is deliberately ignored because it is the complete dossier
 * container; returning it would defeat structural retrieval and token budgets.
 */
export function rehydrateStructuralContext(
  unit: StructuralContextUnit,
  maxChars = 3600,
): string {
  const child = unit.body.trim();
  if (!child) return "";
  const boundedChild = boundedWindow(child, child, Math.min(maxChars, 1600));
  const parent = unit.parentBody?.trim();
  if (!parent || unit.parentUnitType === "DOCUMENT" || parent === child) {
    return boundedChild;
  }
  return boundedWindow(parent, child, maxChars);
}
