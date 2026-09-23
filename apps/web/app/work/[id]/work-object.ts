export type WorkActivity = {
  id: string;
  objectRefId: string;
  targetRefId: string | null;
  action: string;
  derivation: string;
};

export function relationDirection(
  event: WorkActivity,
  focusObjectId: string,
): "OUTGOING" | "INCOMING" | "SELF" | "NONE" {
  if (
    event.objectRefId === focusObjectId &&
    event.targetRefId === focusObjectId
  ) {
    return "SELF";
  }
  if (event.objectRefId === focusObjectId && event.targetRefId) {
    return "OUTGOING";
  }
  if (event.targetRefId === focusObjectId) {
    return "INCOMING";
  }
  return "NONE";
}

export function relatedObjectId(
  event: WorkActivity,
  focusObjectId: string,
): string | null {
  const direction = relationDirection(event, focusObjectId);
  if (direction === "OUTGOING") return event.targetRefId;
  if (direction === "INCOMING") return event.objectRefId;
  if (direction === "SELF") return focusObjectId;
  return null;
}

export type DependencyPerspective = "DECLARED" | "STATIC" | "OBSERVED";

export interface DependencyPerspectiveRow {
  relatedId: string;
  declared: boolean;
  static: boolean;
  observed: boolean;
  status: "ALIGNED" | "PERSPECTIVE_GAP";
}

export function dependencyPerspective(
  derivation: string,
): DependencyPerspective | null {
  if (derivation === "SOURCE_EXPLICIT" || derivation === "HUMAN_ASSERTED") {
    return "DECLARED";
  }
  if (derivation === "STATICALLY_RESOLVED") return "STATIC";
  if (
    derivation === "RUNTIME_OBSERVED" ||
    derivation === "DYNAMICALLY_PROVEN"
  ) {
    return "OBSERVED";
  }
  return null;
}

export function compareDependencyPerspectives(
  dependencies: Array<{ relatedId: string; derivation: string }>,
): DependencyPerspectiveRow[] {
  const grouped = new Map<string, Set<DependencyPerspective>>();
  for (const dependency of dependencies) {
    const perspective = dependencyPerspective(dependency.derivation);
    if (!perspective) continue;
    const current = grouped.get(dependency.relatedId) ?? new Set();
    current.add(perspective);
    grouped.set(dependency.relatedId, current);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relatedId, perspectives]) => {
      const declared = perspectives.has("DECLARED");
      const staticDependency = perspectives.has("STATIC");
      const observed = perspectives.has("OBSERVED");
      return {
        relatedId,
        declared,
        static: staticDependency,
        observed,
        status:
          declared && staticDependency && observed
            ? ("ALIGNED" as const)
            : ("PERSPECTIVE_GAP" as const),
      };
    });
}
