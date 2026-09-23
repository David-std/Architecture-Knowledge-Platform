-- The managed Git merge is the canonical knowledge commit point. Advance the
-- vault's Git revision in the same PostgreSQL transaction that changes a
-- review to APPROVED so new ContextRevisionSets cannot pin the pre-publication
-- SHA while downstream indexes are still catching up through the outbox.
create or replace function akp_advance_vault_revision_on_review_publish()
returns trigger
language plpgsql
as $$
begin
  if new.status='APPROVED'
     and new.merged_commit is not null
     and (
       old.status is distinct from new.status
       or old.merged_commit is distinct from new.merged_commit
     ) then
    update vaults
       set current_revision=new.merged_commit
     where id=new.vault_id
       and space_id=new.space_id
       and enabled;
    if not found then
      raise exception 'PUBLISHED_REVIEW_VAULT_NOT_AVAILABLE';
    end if;
  end if;
  return new;
end;
$$;

create trigger reviews_advance_vault_revision
  after update of status,merged_commit on reviews
  for each row execute function akp_advance_vault_revision_on_review_publish();
