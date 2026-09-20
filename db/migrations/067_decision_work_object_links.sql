-- Typed relationship between governed decision candidates and projected work
-- objects. Free-form affected_refs remains for human-readable references, while
-- this table gives object-centric pages a referentially-integral join.
create table workspace_decision_candidate_work_objects (
  candidate_id uuid not null
    references workspace_decision_candidates(id) on delete cascade,
  object_ref_id uuid not null
    references external_object_refs(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(candidate_id,object_ref_id)
);

create index workspace_decision_candidate_work_objects_ref_idx
  on workspace_decision_candidate_work_objects(object_ref_id,candidate_id);
