-- First-class link from workspace claims to projected work objects.
--
-- work_key remains the concurrency/fencing scope. object_ref_id is an optional
-- typed relationship used by object-centric workflows; legacy claims remain
-- valid with NULL and no string parsing is required to discover ownership.
alter table workspace_claims
  add column object_ref_id uuid
    references external_object_refs(id) on delete set null;

create index workspace_claims_object_ref_idx
  on workspace_claims(object_ref_id,lease_expires_at desc)
  where object_ref_id is not null;
