-- P2 consultative architecture decision workflow.
--
-- Decision collaboration is coordination/provenance state until the existing
-- governed review pipeline publishes it. These tables deliberately do not
-- create a second canonical decision store.

create table workspace_decision_candidates (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references agent_sessions(id) on delete cascade,
  space_id uuid not null,
  vault_id uuid not null,
  created_by_principal_id uuid not null references principals(id),
  decision_authority_principal_id uuid not null references principals(id),
  title text not null check (char_length(title) between 1 and 200),
  problem text not null check (char_length(problem) between 1 and 12000),
  context text not null check (char_length(context) between 1 and 12000),
  drivers jsonb not null check (jsonb_typeof(drivers)='array'),
  quality_attributes jsonb not null check (jsonb_typeof(quality_attributes)='array'),
  affected_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(affected_refs)='array'),
  evidence_refs jsonb not null check (jsonb_typeof(evidence_refs)='array'),
  consequences text
    check (consequences is null or char_length(consequences) between 1 and 12000),
  follow_up_actions jsonb not null default '[]'::jsonb
    check (jsonb_typeof(follow_up_actions)='array'),
  verification_plan text not null
    check (char_length(verification_plan) between 1 and 12000),
  verification_due_at timestamptz,
  decision_deadline timestamptz,
  effective_from timestamptz,
  effective_until timestamptz,
  status text not null default 'DRAFT'
    check (
      status in (
        'DRAFT','CONSULTATION','READY_FOR_REVIEW','PENDING_REVIEW',
        'APPROVED','REJECTED','SUPERSEDED','WITHDRAWN'
      )
    ),
  selected_alternative_id uuid,
  captured_event_id bigint unique references workspace_events(id),
  review_id uuid unique references reviews(id),
  supersedes_candidate_id uuid references workspace_decision_candidates(id),
  superseded_by_candidate_id uuid references workspace_decision_candidates(id),
  published_revision text,
  version bigint not null default 1 check (version > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  approved_at timestamptz,
  superseded_at timestamptz,
  constraint workspace_decision_candidate_vault_fk
    foreign key(space_id,vault_id) references vaults(space_id,id),
  check (supersedes_candidate_id is null or supersedes_candidate_id <> id),
  check (superseded_by_candidate_id is null or superseded_by_candidate_id <> id),
  check (
    status not in ('PENDING_REVIEW','APPROVED','REJECTED','SUPERSEDED')
    or review_id is not null
  ),
  check (
    status not in ('READY_FOR_REVIEW','PENDING_REVIEW','APPROVED','REJECTED','SUPERSEDED')
    or (selected_alternative_id is not null and consequences is not null)
  ),
  check (
    status not in ('APPROVED','SUPERSEDED')
    or published_revision is not null
  ),
  check (
    effective_until is null
    or (effective_from is not null and effective_until > effective_from)
  )
);

create index workspace_decision_candidates_session_idx
  on workspace_decision_candidates(session_id,updated_at desc);
create index workspace_decision_candidates_vault_idx
  on workspace_decision_candidates(vault_id,status,updated_at desc);
create unique index workspace_decision_single_live_supersession_idx
  on workspace_decision_candidates(supersedes_candidate_id)
  where supersedes_candidate_id is not null
    and status in ('PENDING_REVIEW','APPROVED');

create table workspace_decision_alternatives (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null
    references workspace_decision_candidates(id) on delete cascade,
  author_principal_id uuid not null references principals(id),
  origin text not null
    check (origin in ('HUMAN_SUBMITTED','AGENT_SUGGESTED')),
  title text not null check (char_length(title) between 1 and 240),
  description text not null check (char_length(description) between 1 and 12000),
  tradeoffs text not null check (char_length(tradeoffs) between 1 and 12000),
  evidence_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(evidence_refs)='array'),
  status text not null
    check (status in ('SUGGESTED','CONSIDERED','REJECTED')),
  decided_by_principal_id uuid references principals(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  unique(candidate_id,id),
  check (
    (status='SUGGESTED' and decided_by_principal_id is null and decided_at is null)
    or status<>'SUGGESTED'
  )
);

create index workspace_decision_alternatives_candidate_idx
  on workspace_decision_alternatives(candidate_id,created_at,id);

alter table workspace_decision_candidates
  add constraint workspace_decision_selected_alternative_fk
  foreign key(id,selected_alternative_id)
  references workspace_decision_alternatives(candidate_id,id);

create table workspace_decision_objections (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null
    references workspace_decision_candidates(id) on delete cascade,
  alternative_id uuid,
  author_principal_id uuid not null references principals(id),
  statement text not null check (char_length(statement) between 1 and 12000),
  evidence_refs jsonb not null default '[]'::jsonb
    check (jsonb_typeof(evidence_refs)='array'),
  status text not null default 'OPEN'
    check (status in ('OPEN','RESOLVED','WITHDRAWN')),
  resolution text,
  resolved_by_principal_id uuid references principals(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(candidate_id,alternative_id)
    references workspace_decision_alternatives(candidate_id,id),
  check (
    (status='RESOLVED' and resolution is not null
      and resolved_by_principal_id is not null and resolved_at is not null)
    or status<>'RESOLVED'
  )
);

create index workspace_decision_objections_candidate_idx
  on workspace_decision_objections(candidate_id,status,created_at,id);

create table workspace_decision_consultations (
  id uuid primary key default gen_random_uuid(),
  candidate_id uuid not null
    references workspace_decision_candidates(id) on delete cascade,
  requested_by_principal_id uuid not null references principals(id),
  reviewer_principal_id uuid not null references principals(id),
  question text not null check (char_length(question) between 1 and 8000),
  status text not null default 'REQUESTED'
    check (status in ('REQUESTED','RESPONDED','DECLINED')),
  position text
    check (position is null or position in ('SUPPORT','OPPOSE','NEUTRAL')),
  response text,
  requested_at timestamptz not null default now(),
  responded_at timestamptz,
  check (requested_by_principal_id <> reviewer_principal_id),
  check (
    (status='RESPONDED' and response is not null and position is not null
      and responded_at is not null)
    or status<>'RESPONDED'
  )
);

create index workspace_decision_consultations_candidate_idx
  on workspace_decision_consultations(candidate_id,status,requested_at,id);
create index workspace_decision_consultations_reviewer_idx
  on workspace_decision_consultations(reviewer_principal_id,status,requested_at);

-- Scope/authorship are immutable. Workflow state evolves, but a candidate
-- cannot be silently moved to another session/vault or rewritten as authored
-- by another principal.
create or replace function akp_guard_workspace_decision_identity()
returns trigger language plpgsql as $$
begin
  if row(
    new.session_id,new.space_id,new.vault_id,new.created_by_principal_id,
    new.decision_authority_principal_id,new.supersedes_candidate_id,new.created_at
  ) is distinct from row(
    old.session_id,old.space_id,old.vault_id,old.created_by_principal_id,
    old.decision_authority_principal_id,old.supersedes_candidate_id,old.created_at
  ) then
    raise exception 'DECISION_CANDIDATE_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$$;

create trigger workspace_decision_candidates_guard_identity
  before update on workspace_decision_candidates
  for each row execute function akp_guard_workspace_decision_identity();

comment on table workspace_decision_candidates is
  'Consultative decision workflow state. APPROVED means its linked governed review published canonical knowledge.';
comment on table workspace_decision_alternatives is
  'Decision alternatives with explicit human-submitted versus agent-suggested provenance.';
comment on table workspace_decision_objections is
  'Attributed objections/contradictions that must be resolved before selection.';
comment on table workspace_decision_consultations is
  'Explicit human consultation requests/responses; not fabricated consensus.';
