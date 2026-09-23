-- Revision verification for durable reasoning traces.
--
-- Execution metadata is persisted before the final revision fence. A trace is
-- usable as current-plan evidence only after the route confirms that the
-- complete ContextRevisionSet remained unchanged through the multi-step run.

alter table reasoning_execution_traces
  add column revision_verified boolean not null default false;

create index reasoning_execution_traces_unverified_idx
  on reasoning_execution_traces(space_id,created_at desc)
  where revision_verified=false;

comment on column reasoning_execution_traces.revision_verified is
  'True only after final ContextRevisionSet verification succeeds for the completed reasoning execution.';
