export interface StructuralContextUnit {
  body: string;
  unitType: string;
  parentBody?: string | null;
  parentUnitType?: string | null;
}

function boundedWindow(text: string, needle: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const index = needle ? text.indexOf(needle) : -1;
  if (index < 0)
    return `${text.slice(0, Math.max(maxChars - 1, 0)).trimEnd()}…`;
  const start = Math.max(0, index - Math.floor((maxChars - needle.length) / 2));
  const end = Math.min(text.length, start + maxChars);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${
    end < text.length ? "…" : ""
  }`;
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
