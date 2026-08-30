-- A delivery attempt records both the claim and its terminal outcome.
-- Keeping the original uniqueness key made the first CLAIMED row suppress the
-- later SUCCEEDED/RETRY/QUARANTINED history through ON CONFLICT DO NOTHING.
-- Distinguish outcomes while retaining idempotency for redelivered terminal
-- writes from the same fenced worker.
alter table event_delivery_attempts
  drop constraint if exists event_delivery_attempts_event_id_consumer_name_delivery_gen_key;

create unique index event_delivery_attempts_outcome_key
  on event_delivery_attempts(
    event_id,consumer_name,delivery_generation,attempt,outcome
  );
