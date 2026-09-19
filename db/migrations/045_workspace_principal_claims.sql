-- P2 first-class claim ownership. Keep owner_id as the compatibility/user
-- authorization anchor while fencing and audit gain a distinct principal identity.
alter table workspace_claims
  add column owner_principal_id uuid references principals(id);

update workspace_claims claim
   set owner_principal_id=principal.id
  from principals principal
 where principal.kind='HUMAN'
   and principal.user_id=claim.owner_id
   and claim.owner_principal_id is null;

alter table workspace_claims
  alter column owner_principal_id set not null;

create index workspace_claims_owner_principal_lease_idx
  on workspace_claims(owner_principal_id,lease_expires_at)
  where status='ACTIVE';

alter table workspace_events
  add column actor_principal_id uuid references principals(id) on delete set null;

update workspace_events event
   set actor_principal_id=principal.id
  from principals principal
 where principal.kind='HUMAN'
   and principal.user_id=event.actor_id
   and event.actor_principal_id is null;

create index workspace_events_actor_principal_idx
  on workspace_events(actor_principal_id,created_at desc)
  where actor_principal_id is not null;
