-- P2 work-claim scopes. Keep exact logical keys compatible while allowing one
-- explicit hierarchical form: a terminal /** recursive scope.
alter table workspace_claims
  drop constraint if exists workspace_claims_work_key_check;

alter table workspace_claims
  add constraint workspace_claims_work_key_check
  check (
    char_length(work_key) between 1 and 200
    and (
      work_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      or (
        work_key ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,196}/\*\*$'
        and work_key !~ '//'
        and work_key !~ '(^|/)\.{1,2}(/|$)'
      )
    )
  );
