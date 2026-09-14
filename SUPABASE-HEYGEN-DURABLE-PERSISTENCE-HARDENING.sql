begin;

create index if not exists heygen_oauth_states_connected_account_idx
  on social_cues_private.heygen_oauth_states(connected_account_id);

alter table social_cues_private.heygen_oauth_states enable row level security;
alter table social_cues_private.heygen_oauth_states force row level security;
alter table social_cues_private.heygen_operation_receipts enable row level security;
alter table social_cues_private.heygen_operation_receipts force row level security;

drop policy if exists "client roles cannot access heygen oauth states"
  on social_cues_private.heygen_oauth_states;
create policy "client roles cannot access heygen oauth states"
  on social_cues_private.heygen_oauth_states
  as restrictive for all to anon, authenticated
  using (false)
  with check (false);

drop policy if exists "client roles cannot access heygen operation receipts"
  on social_cues_private.heygen_operation_receipts;
create policy "client roles cannot access heygen operation receipts"
  on social_cues_private.heygen_operation_receipts
  as restrictive for all to anon, authenticated
  using (false)
  with check (false);

revoke all on schema social_cues_private from public, anon, authenticated;
revoke all on table
  social_cues_private.heygen_oauth_states,
  social_cues_private.heygen_operation_receipts
from public, anon, authenticated;

commit;
