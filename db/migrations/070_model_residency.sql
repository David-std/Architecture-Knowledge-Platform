-- Model execution residency is a durable data boundary. Space policy and
-- source policy are combined at routing time; source policy can only become
-- more restrictive when identical bytes are ingested again.
alter table spaces
  add column model_residency text not null default 'EXTERNAL_ALLOWED';

alter table spaces
  add constraint spaces_model_residency_check
  check (model_residency in ('LOCAL_ONLY','ORG_APPROVED','EXTERNAL_ALLOWED'));

alter table sources
  add column model_residency text not null default 'EXTERNAL_ALLOWED';

alter table sources
  add constraint sources_model_residency_check
  check (model_residency in ('LOCAL_ONLY','ORG_APPROVED','EXTERNAL_ALLOWED'));

-- Preserve LOCAL_ONLY intent from document-intelligence jobs created before
-- model_residency became a first-class source field.
update sources s
   set model_residency='LOCAL_ONLY'
 where exists (
   select 1
     from ingest_jobs j
    where j.stage_outputs->>'sourceId'=s.id::text
      and (
        j.payload->>'modelResidency'='LOCAL_ONLY'
        or j.payload #>> '{documentIntelligence,privacyPolicy}'='LOCAL_ONLY'
      )
 );

update sources s
   set model_residency='ORG_APPROVED'
 where s.model_residency='EXTERNAL_ALLOWED'
   and exists (
     select 1
       from ingest_jobs j
      where j.stage_outputs->>'sourceId'=s.id::text
        and j.payload->>'modelResidency'='ORG_APPROVED'
   );

comment on column spaces.model_residency is
  'Maximum model-processing residency permitted by the space policy.';
comment on column sources.model_residency is
  'Maximum model-processing residency permitted by this immutable source.';
