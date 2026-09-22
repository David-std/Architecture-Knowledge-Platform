-- Organization model residency is an enterprise-wide upper policy boundary.
-- Source/data policy remains the most specific durable restriction; spaces may
-- further restrict an organization, while role/fallback configuration can only
-- select providers that already satisfy every durable boundary.
alter table organizations
  add column model_residency text not null default 'EXTERNAL_ALLOWED';

alter table organizations
  add constraint organizations_model_residency_check
  check (model_residency in ('LOCAL_ONLY','ORG_APPROVED','EXTERNAL_ALLOWED'));

comment on column organizations.model_residency is
  'Organization-wide maximum model-processing residency. Spaces, sources and role policies may only become more restrictive.';
