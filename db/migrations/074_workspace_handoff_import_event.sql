-- Durable fresh-session handoff import. Extend the append-only workspace
-- event vocabulary without rewriting or mutating existing coordination events.
alter table workspace_events
  drop constraint if exists workspace_events_event_type_check;

alter table workspace_events
  add constraint workspace_events_event_type_check
  check (
    event_type in (
      'SESSION_CREATED',
      'WORK_CONTEXT_UPDATED',
      'PARTICIPANT_JOINED',
      'CLAIM_ACQUIRED',
      'CLAIM_HEARTBEAT',
      'CLAIM_RELEASED',
      'CLAIM_HANDOFF',
      'HANDOFF_IMPORTED',
      'FINDING',
      'BLOCKER',
      'QUESTION',
      'ARTIFACT',
      'DECISION_CANDIDATE',
      'PROMOTION_REQUESTED',
      'NOTE'
    )
  );
