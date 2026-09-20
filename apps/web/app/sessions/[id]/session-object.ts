export type SessionEvent = {
  id: string | number;
  event_type: string;
  payload?: unknown;
  session_version?: number;
  actor_principal_id?: string | null;
  created_at?: string;
};

export function sessionObjectGroups(events: SessionEvent[]) {
  return {
    captures: events.filter((event) =>
      ["FINDING", "ARTIFACT", "DECISION_CANDIDATE"].includes(
        event.event_type,
      ),
    ),
    handoffs: events.filter((event) => event.event_type === "CLAIM_HANDOFF"),
    blockers: events.filter((event) =>
      ["BLOCKER", "QUESTION"].includes(event.event_type),
    ),
  };
}

export function eventPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
