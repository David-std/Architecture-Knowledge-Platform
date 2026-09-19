-- P8.2/P8.10: persistent finding identity, lifecycle and spec-aligned contract.

alter table assurance_runs
  drop constraint if exists assurance_runs_detectors_nonempty;

update assurance_runs
   set detectors = array(
     select distinct
       case detector
         when 'LINK_ORPHAN' then 'LINK_GAP'
         when 'SYNTHESIS_ACCESS_BOUNDARY' then 'ACCESS_BOUNDARY'
         else detector
       end
       from unnest(detectors) detector
      order by 1
   );

alter table assurance_runs
  add constraint assurance_runs_detectors_nonempty
  check (
    cardinality(detectors) between 1 and 18
    and detectors <@ array[
      'GROUNDING','FRESHNESS','CONTRADICTION','DUPLICATE_IDENTITY',
      'GRAPH_HEALTH','TEMPORAL_CONSISTENCY','CODE_GRAPH_FRESHNESS',
      'LINK_GAP','SYNTHESIS_CANDIDATE','ACCESS_BOUNDARY',
      'CONNECTOR_DELETION','CONNECTOR_FRESHNESS','CONNECTOR_ACL_DRIFT',
      'GRAPH_DISAGREEMENT','ORPHAN_WORK','EXPIRED_CLAIM','STALE_HANDOFF',
      'UNSUPPORTED_CAUSALITY'
    ]::text[]
  );

alter table assurance_findings
  drop constraint if exists assurance_findings_severity_check,
  drop constraint if exists assurance_findings_state_check,
  drop constraint if exists assurance_findings_run_id_finding_key_key;

drop index if exists assurance_findings_scope_idx;
drop index if exists assurance_findings_run_idx;

update assurance_findings
   set detector = case detector
     when 'LINK_ORPHAN' then 'LINK_GAP'
     when 'SYNTHESIS_ACCESS_BOUNDARY' then 'ACCESS_BOUNDARY'
     else detector
   end,
       severity = case severity when 'WARN' then 'MEDIUM' else severity end,
       state = case state when 'SUPPRESSED' then 'FALSE_POSITIVE' else state end;

alter table assurance_findings
  add column detector_version text not null default '1.0.0'
    check (char_length(detector_version) between 1 and 80),
  add column category text not null default 'GENERAL'
    check (char_length(category) between 1 and 120),
  add column scope_id text,
  add column target_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(target_ids)='array'),
  add column support_set_ids jsonb not null default '[]'::jsonb
    check (jsonb_typeof(support_set_ids)='array'),
  add column first_seen_at timestamptz not null default now(),
  add column last_seen_at timestamptz not null default now(),
  add column proposed_action text,
  add column revision_set jsonb
    check (revision_set is null or jsonb_typeof(revision_set)='object');

update assurance_findings
   set category = case detector
     when 'GROUNDING' then 'GROUNDING'
     when 'FRESHNESS' then 'FRESHNESS'
     when 'CONTRADICTION' then 'CONTRADICTION'
     when 'DUPLICATE_IDENTITY' then 'IDENTITY'
     when 'GRAPH_HEALTH' then 'GRAPH_HEALTH'
     when 'TEMPORAL_CONSISTENCY' then 'TEMPORAL_CONSISTENCY'
     when 'CODE_GRAPH_FRESHNESS' then 'CODE_GRAPH_FRESHNESS'
     when 'LINK_GAP' then 'LINK_GAP'
     when 'SYNTHESIS_CANDIDATE' then 'SYNTHESIS_CANDIDATE'
     when 'ACCESS_BOUNDARY' then 'ACCESS_BOUNDARY'
     when 'CONNECTOR_DELETION' then 'CONNECTOR'
     when 'CONNECTOR_FRESHNESS' then 'CONNECTOR'
     when 'CONNECTOR_ACL_DRIFT' then 'ACCESS_BOUNDARY'
     when 'GRAPH_DISAGREEMENT' then 'GRAPH_HEALTH'
     when 'ORPHAN_WORK' then 'WORKSPACE'
     when 'EXPIRED_CLAIM' then 'WORKSPACE'
     when 'STALE_HANDOFF' then 'WORKSPACE'
     when 'UNSUPPORTED_CAUSALITY' then 'WORK_GRAPH'
     else 'GENERAL'
   end,
       scope_id = vault_id::text,
       target_ids = jsonb_build_array(subject_id),
       first_seen_at = created_at,
       last_seen_at = created_at;

alter table assurance_findings
  alter column scope_id set not null,
  add constraint assurance_findings_severity_check
    check (severity in ('INFO','LOW','MEDIUM','HIGH','CRITICAL')),
  add constraint assurance_findings_status_check
    check (state in ('OPEN','ACKNOWLEDGED','RESOLVED','FALSE_POSITIVE'));

-- Re-key old rows to the v0.4 persistent identity:
-- detector + code + scope + sorted target ids. Detector version is deliberately
-- excluded so an upgraded detector continues the same finding lifecycle.
update assurance_findings
   set finding_key = encode(
     digest(
       detector || chr(0) || code || chr(0) || scope_id || chr(0) ||
       coalesce(
         (
           select string_agg(value, chr(0) order by value)
             from jsonb_array_elements_text(target_ids)
         ),
         ''
       ),
       'sha256'
     ),
     'hex'
   );

with ranked as (
  select id,
         row_number() over (
           partition by space_id,vault_id,finding_key
           order by created_at desc,id desc
         ) rn,
         min(created_at) over (
           partition by space_id,vault_id,finding_key
         ) first_seen,
         max(created_at) over (
           partition by space_id,vault_id,finding_key
         ) last_seen
    from assurance_findings
), keepers as (
  update assurance_findings f
     set first_seen_at=r.first_seen,
         last_seen_at=r.last_seen
    from ranked r
   where f.id=r.id and r.rn=1
   returning f.id
)
delete from assurance_findings f
 using ranked r
 where f.id=r.id and r.rn>1;

alter table assurance_findings
  rename column state to status;

alter table assurance_findings
  add constraint assurance_findings_persistent_identity_key
    unique(space_id,vault_id,finding_key);

create index assurance_findings_scope_idx
  on assurance_findings(
    vault_id,status,severity,category,detector,last_seen_at desc
  );

create index assurance_findings_run_idx
  on assurance_findings(run_id,last_seen_at desc);

create table assurance_finding_events (
  id bigserial primary key,
  finding_id uuid not null
    references assurance_findings(id) on delete cascade,
  space_id uuid not null references spaces(id) on delete cascade,
  vault_id uuid not null,
  action text not null
    check (
      action in (
        'DETECTED','REOPENED','ACKNOWLEDGED','RESOLVED','FALSE_POSITIVE',
        'ACTION_REQUESTED'
      )
    ),
  from_status text,
  to_status text,
  actor_user_id uuid references users(id) on delete set null,
  actor_principal_id uuid references principals(id) on delete set null,
  reason text,
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload)='object'),
  created_at timestamptz not null default now(),
  constraint assurance_finding_events_vault_scope_fk
    foreign key(space_id,vault_id)
    references vaults(space_id,id)
    on delete cascade
);

create index assurance_finding_events_finding_idx
  on assurance_finding_events(finding_id,created_at,id);

comment on table assurance_findings is
  'Persistent P8 Continuous Assurance findings. Identity survives repeated detector runs; first/last seen and authorized lifecycle state are retained.';
comment on table assurance_finding_events is
  'Append-only lifecycle/audit history for assurance findings and operator action requests.';
