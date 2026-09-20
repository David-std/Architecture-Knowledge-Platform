-- Structured service ownership and typed structural Work/Activity relations.
--
-- owners are source-provided identities/labels; AKP does not promote them into
-- principals. relation_kind is deliberately limited to LINKED/REFERENCED
-- activity so structural topology stays distinct from causal assertions.
alter table external_object_refs
  add column owners jsonb not null default '[]'::jsonb
    check (
      jsonb_typeof(owners)='array'
      and jsonb_array_length(owners) <= 50
    );

alter table work_activity_events
  add column relation_kind text
    check (
      relation_kind is null or relation_kind in (
        'DEPENDS_ON',
        'PROVIDES_TO',
        'CODE_REPOSITORY',
        'INCIDENT',
        'RUNS_ON',
        'RULE',
        'RELATED'
      )
    ),
  add constraint work_activity_relation_kind_requires_link
    check (
      relation_kind is null
      or (
        target_ref_id is not null
        and action in ('LINKED','REFERENCED')
      )
    );

create index work_activity_events_relation_kind_idx
  on work_activity_events(vault_id,relation_kind,occurred_at desc)
  where relation_kind is not null;
