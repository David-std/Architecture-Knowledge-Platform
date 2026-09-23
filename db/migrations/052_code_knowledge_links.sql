-- Human-reviewed knowledge-to-code links are canonical approval facts.
-- The federated graph remains derived: a durable outbox event projects each
-- approved mapping into an EPISTEMIC -> CODE bridge.
create table code_knowledge_links (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references spaces(id),
  vault_id uuid not null references vaults(id),
  project_id uuid not null references projects(id),
  document_id uuid not null references knowledge_documents(id),
  review_id uuid not null references reviews(id),
  relation_type text not null check (
    relation_type in ('rationale_ref','applies_to')
  ),
  knowledge_revision text not null check (length(btrim(knowledge_revision)) > 0),
  code_repository text not null check (length(btrim(code_repository)) > 0),
  code_commit_sha text not null check (code_commit_sha ~ '^[a-f0-9]{40}$'),
  code_node_identity jsonb not null check (
    jsonb_typeof(code_node_identity)='object'
  ),
  code_selector jsonb not null check (jsonb_typeof(code_selector)='object'),
  mapping_hash text not null check (mapping_hash ~ '^[a-f0-9]{64}$'),
  approved_by_user_id uuid not null references users(id),
  approved_by_principal_id uuid not null references principals(id),
  created_at timestamptz not null default now(),
  unique (vault_id, mapping_hash)
);

create index code_knowledge_links_project_idx
  on code_knowledge_links(project_id, created_at desc);
create index code_knowledge_links_document_idx
  on code_knowledge_links(document_id, created_at desc);
create index code_knowledge_links_review_idx
  on code_knowledge_links(review_id, created_at desc);

create or replace function akp_reject_code_knowledge_link_mutation()
returns trigger language plpgsql as $$
begin
  raise exception 'CODE_KNOWLEDGE_LINK_IMMUTABLE';
end;
$$;

create trigger code_knowledge_links_append_only
before update or delete on code_knowledge_links
for each row execute function akp_reject_code_knowledge_link_mutation();

alter table event_outbox
  drop constraint if exists event_outbox_event_type_check;

alter table event_outbox
  add constraint event_outbox_event_type_check
  check (
    event_type in (
      'SourceRegistered',
      'ExtractionRequested',
      'ExtractionCompleted',
      'CompilationRequested',
      'KnowledgeDraftCreated',
      'ValidationRequested',
      'KnowledgePublished',
      'CorpusRevisionPublished',
      'LexicalIndexUpdateRequested',
      'VectorIndexUpdateRequested',
      'GraphIndexUpdateRequested',
      'CodeGraphRefreshRequested',
      'CodeKnowledgeLinkApproved',
      'GraphRevisionBuilt',
      'GraphRevisionActivated',
      'GraphRevisionStale',
      'ContextPackInvalidationRequested',
      'ImpactedEvalRunRequested',
      'WorkspaceSessionCreated',
      'WorkspaceSessionUpdated',
      'WorkspaceClaimUpdated',
      'WorkspaceHandoffCreated',
      'WorkspacePromotionRequested',
      'ExternalObjectRefUpserted',
      'OfflineDraftQueued',
      'OfflineDraftReconciled',
      'ContextFabricPeerRegistered',
      'PrincipalRevoked'
    )
  );
