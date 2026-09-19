-- Keep the durable workspace event vocabulary aligned with the runtime.
-- WorkContext lifecycle updates append WORK_CONTEXT_UPDATED and must commit
-- atomically with their event instead of failing after the session row changes.
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
      'FINDING',
      'BLOCKER',
      'QUESTION',
      'ARTIFACT',
      'DECISION_CANDIDATE',
      'PROMOTION_REQUESTED',
      'NOTE'
    )
  );
