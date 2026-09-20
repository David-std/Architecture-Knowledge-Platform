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
