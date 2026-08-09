alter table eval_runs add column space_id uuid references spaces(id);

update eval_runs
   set space_id='00000000-0000-0000-0000-000000000003'
 where space_id is null;

alter table eval_runs alter column space_id set not null;

create index eval_runs_space_created_idx on eval_runs(space_id, created_at desc);
