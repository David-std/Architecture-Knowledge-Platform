drop index if exists knowledge_documents_external_id_idx;

create index knowledge_documents_external_id_idx
  on knowledge_documents(space_id, external_id)
  where external_id is not null;
