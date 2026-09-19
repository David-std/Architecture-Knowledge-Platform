-- P2.17/P2.18 explicit claim release. Claims already support RELEASED;
-- this migration extends the append-only workspace event vocabulary without
-- rewriting prior coordination history.
alter table workspace_events
  drop constraint if exists workspace_events_event_type_check;
alter table workspace_events
  add constraint workspace_events_event_type_check
  check (
    event_type in (
      'SESSION_CREATED',
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
