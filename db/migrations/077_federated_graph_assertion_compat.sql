-- Preserve legacy/direct graph projection writers while enforcing first-class
-- relationship assertions for every structural edge.
--
-- Some benchmark/test producers intentionally write the derived graph schema
-- directly. A BEFORE INSERT trigger materializes the same assertion entity the
-- application store creates, so assertion_id remains NOT NULL and no caller
-- can bypass the first-class relationship contract.

alter table federated_graph_relationship_assertions
  drop constraint federated_graph_assertion_from_space_fk;
alter table federated_graph_relationship_assertions
  add constraint federated_graph_assertion_from_space_fk
  foreign key(space_id,from_node_id)
  references federated_graph_nodes(space_id,id)
  on delete cascade;

alter table federated_graph_relationship_assertions
  drop constraint federated_graph_assertion_to_space_fk;
alter table federated_graph_relationship_assertions
  add constraint federated_graph_assertion_to_space_fk
  foreign key(space_id,to_node_id)
  references federated_graph_nodes(space_id,id)
  on delete cascade;

create or replace function ensure_federated_graph_edge_assertion()
returns trigger
language plpgsql
as $$
declare
  assertion uuid;
begin
  if new.assertion_id is not null then
    return new;
  end if;

  insert into federated_graph_relationship_assertions(
    space_id,owner_graph_domain,from_node_id,to_node_id,relation_type,
    authorization_path,lifecycle,derivation,source_ids,evidence_ids,locator_refs,
    provenance_revision,support_set_id,confidence,valid_from,valid_to,recorded_at,
    assertion_hash
  ) values(
    new.space_id,new.owner_graph_domain,new.from_node_id,new.to_node_id,
    new.relation_type,new.authorization_path,'ACTIVE',new.derivation,
    new.source_ids,new.evidence_ids,new.locator_refs,new.provenance_revision,
    new.support_set_id,new.confidence,new.valid_from,new.valid_to,new.recorded_at,
    new.provenance_hash
  )
  on conflict(
    space_id,owner_graph_domain,from_node_id,to_node_id,relation_type,assertion_hash
  ) do update
    set updated_at=federated_graph_relationship_assertions.updated_at
  returning id into assertion;

  new.assertion_id := assertion;
  return new;
end;
$$;

drop trigger if exists federated_graph_edge_assertion_compat
  on federated_graph_edges;
create trigger federated_graph_edge_assertion_compat
before insert on federated_graph_edges
for each row
execute function ensure_federated_graph_edge_assertion();
