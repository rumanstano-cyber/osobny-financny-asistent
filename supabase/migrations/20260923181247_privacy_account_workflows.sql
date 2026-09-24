-- Ownership is never reassigned as a side effect of an erasure request.
-- An authenticated original owner must explicitly name an eligible successor.
-- The service_role entry point is for a verified Telegram owner only.
create or replace function public.transfer_workspace_ownership_for_erasure_internal(
  p_actor_user_id uuid,
  p_workspace_id uuid,
  p_successor_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_owner uuid;
begin
  if p_actor_user_id is null or p_workspace_id is null or p_successor_user_id is null
     or p_actor_user_id = p_successor_user_id then
    raise exception 'Invalid ownership transfer' using errcode = '22023';
  end if;

  -- This row serialises concurrent transfer/deletion requests for one workspace.
  perform 1 from public.workspaces workspace
  where workspace.id = p_workspace_id and workspace.deleted_at is null
  for update;
  if not found then
    raise exception 'Workspace is not available' using errcode = '42501';
  end if;

  select member.user_id into v_existing_owner
  from public.workspace_members member
  join public.ofa_users actor on actor.id = member.user_id
  where member.workspace_id = p_workspace_id
    and member.role = 'owner'
    and member.status = 'active'
    and member.removed_at is null
    and actor.status = 'active'
    and actor.deleted_at is null
  for update of member;
  if v_existing_owner is distinct from p_actor_user_id then
    raise exception 'Only the current active owner may transfer ownership' using errcode = '42501';
  end if;

  perform 1
  from public.workspace_members member
  join public.ofa_users successor on successor.id = member.user_id
  where member.workspace_id = p_workspace_id
    and member.user_id = p_successor_user_id
    and member.status = 'active'
    and member.removed_at is null
    and member.role in ('admin', 'member')
    and successor.status = 'active'
    and successor.deleted_at is null
  for update of member;
  if not found then
    raise exception 'Successor must be an eligible active member of this workspace' using errcode = '42501';
  end if;

  -- Clear the partial unique-owner slot before assigning the successor.
  update public.workspace_members member
  set role = 'member'
  where member.workspace_id = p_workspace_id and member.user_id = p_actor_user_id;
  update public.workspace_members member
  set role = 'owner'
  where member.workspace_id = p_workspace_id and member.user_id = p_successor_user_id;
  update public.workspaces workspace
  set created_by_user_id = p_successor_user_id
  where workspace.id = p_workspace_id and workspace.created_by_user_id = p_actor_user_id;

  insert into public.audit_events (
    workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, before_data, after_data
  ) values (
    p_workspace_id, p_actor_user_id, 'user', 'workspace.ownership_transferred_for_erasure',
    'workspace', p_workspace_id,
    pg_catalog.jsonb_build_object('owner_user_id', p_actor_user_id),
    pg_catalog.jsonb_build_object('owner_user_id', p_successor_user_id)
  );
  return true;
end;
$$;

create or replace function public.transfer_workspace_ownership_for_erasure(
  p_workspace_id uuid,
  p_successor_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid := public.current_ofa_user_id();
begin
  if v_actor_user_id is null then
    raise exception 'Verified active account required' using errcode = '42501';
  end if;
  return public.transfer_workspace_ownership_for_erasure_internal(
    v_actor_user_id, p_workspace_id, p_successor_user_id
  );
end;
$$;

create or replace function public.transfer_telegram_workspace_ownership_for_erasure(
  p_telegram_user_id text,
  p_workspace_id uuid,
  p_successor_user_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_user_id uuid;
begin
  select account.user_id into v_actor_user_id
  from public.channel_accounts account
  join public.ofa_users actor on actor.id = account.user_id
  where account.channel = 'telegram'
    and account.external_account_id = p_telegram_user_id
    and account.unlinked_at is null
    and actor.status = 'active'
    and actor.deleted_at is null;
  if v_actor_user_id is null then
    raise exception 'Active Telegram account required' using errcode = '42501';
  end if;
  return public.transfer_workspace_ownership_for_erasure_internal(
    v_actor_user_id, p_workspace_id, p_successor_user_id
  );
end;
$$;

revoke all on function public.transfer_workspace_ownership_for_erasure_internal(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.transfer_workspace_ownership_for_erasure(uuid, uuid) from public, anon, service_role;
revoke all on function public.transfer_telegram_workspace_ownership_for_erasure(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.transfer_workspace_ownership_for_erasure_internal(uuid, uuid, uuid) to service_role;
grant execute on function public.transfer_workspace_ownership_for_erasure(uuid, uuid) to authenticated;
grant execute on function public.transfer_telegram_workspace_ownership_for_erasure(text, uuid, uuid) to service_role;

-- A revoked account cannot use the normal current_ofa_user_id() helper. This
-- narrowly scoped lookup permits cancellation during grace, but never returns
-- an account whose Auth email was not verified.
create or replace function public.privacy_web_account_user_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select app_user.id
  from public.ofa_users app_user
  join auth.users auth_user on auth_user.id = app_user.auth_user_id
  where app_user.auth_user_id = auth.uid()
    and auth_user.email_confirmed_at is not null
  limit 1;
$$;

create or replace function public.privacy_telegram_account_user_id(p_telegram_user_id text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select account.user_id
  from public.channel_accounts account
  where account.channel = 'telegram'
    and account.external_account_id = p_telegram_user_id
    and account.unlinked_at is null
  limit 1;
$$;

-- No identity is guessed from workspace age or membership order. The preview
-- reports which workspaces require a separately authorised owner transfer.
create or replace function public.account_erasure_preview_internal(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_blocked_workspaces jsonb;
  v_active_warranties integer;
begin
  if p_user_id is null or not exists (
    select 1 from public.ofa_users app_user
    where app_user.id = p_user_id
      and app_user.status = 'active'
      and app_user.deleted_at is null
  ) then
    raise exception 'Active account required' using errcode = '42501';
  end if;

  select coalesce(pg_catalog.jsonb_agg(workspace.id order by workspace.id), '[]'::jsonb)
  into v_blocked_workspaces
  from public.workspace_members owner_member
  join public.workspaces workspace on workspace.id = owner_member.workspace_id
  where owner_member.user_id = p_user_id
    and owner_member.role = 'owner'
    and owner_member.status = 'active'
    and owner_member.removed_at is null
    and workspace.deleted_at is null
    and exists (
      select 1 from public.workspace_members candidate
      join public.ofa_users candidate_user on candidate_user.id = candidate.user_id
      where candidate.workspace_id = workspace.id
        and candidate.user_id <> p_user_id
        and candidate.status = 'active'
        and candidate.removed_at is null
        and candidate_user.status = 'active'
        and candidate_user.deleted_at is null
    );

  select count(*) into v_active_warranties
  from public.receipt_purchase_protections protection
  where protection.recipient_user_id = p_user_id
    and protection.status = 'active'
    and protection.ends_on >= (pg_catalog.now() at time zone 'Europe/Bratislava')::date;

  return pg_catalog.jsonb_build_object(
    'active_warranty_documents', v_active_warranties,
    'ownership_transfer_required_workspace_ids', v_blocked_workspaces,
    'grace_days', 30
  );
end;
$$;

create or replace function public.account_erasure_preview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.current_ofa_user_id();
begin
  if v_user_id is null then
    raise exception 'Verified active account required' using errcode = '42501';
  end if;
  return public.account_erasure_preview_internal(v_user_id);
end;
$$;

create or replace function public.telegram_account_erasure_preview(p_telegram_user_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.privacy_telegram_account_user_id(p_telegram_user_id);
begin
  return public.account_erasure_preview_internal(v_user_id);
end;
$$;

create unique index if not exists gdpr_requests_one_open_erasure_idx
  on public.gdpr_requests (user_id)
  where request_type = 'erasure' and status in ('requested', 'processing');

create or replace function public.confirm_account_erasure_internal(
  p_user_id uuid,
  p_confirmation text
)
returns table (request_id uuid, grace_ends_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_due_at timestamptz := pg_catalog.now() + interval '30 days';
  v_request_id uuid;
  v_user_status text;
begin
  if p_user_id is null or p_confirmation is distinct from 'VYMAZAŤ ÚČET' then
    raise exception 'Explicit erasure confirmation required' using errcode = '22023';
  end if;
  select app_user.status into v_user_status
  from public.ofa_users app_user
  where app_user.id = p_user_id
  for update;
  if not found then
    raise exception 'Account not found' using errcode = '42501';
  end if;
  if v_user_status = 'deleted' then
    select request.id, request.due_at into v_request_id, v_due_at
    from public.gdpr_requests request
    where request.user_id = p_user_id
      and request.request_type = 'erasure'
      and request.status = 'requested'
      and request.due_at > pg_catalog.now()
    order by request.requested_at desc limit 1;
    if v_request_id is not null then
      return query select v_request_id, v_due_at;
      return;
    end if;
  end if;
  if v_user_status <> 'active' then
    raise exception 'Active account required' using errcode = '42501';
  end if;

  -- No successor is silently selected. The owner must first invoke the
  -- explicit transfer RPC for every shared workspace they own.
  if exists (
    select 1 from public.workspace_members owner_member
    join public.workspaces workspace on workspace.id = owner_member.workspace_id
    where owner_member.user_id = p_user_id
      and owner_member.role = 'owner'
      and owner_member.status = 'active'
      and owner_member.removed_at is null
      and workspace.deleted_at is null
      and exists (
        select 1 from public.workspace_members other_member
        join public.ofa_users other_user on other_user.id = other_member.user_id
        where other_member.workspace_id = workspace.id
          and other_member.user_id <> p_user_id
          and other_member.status = 'active'
          and other_member.removed_at is null
          and other_user.status = 'active'
          and other_user.deleted_at is null
      )
  ) then
    raise exception 'Explicit ownership transfer required before erasure' using errcode = '23514';
  end if;

  insert into public.gdpr_requests (user_id, request_type, status, due_at)
  values (p_user_id, 'erasure', 'requested', v_due_at)
  returning id into v_request_id;

  -- Keep the email reservation during grace. deleted_at is set only after the
  -- irreversible phase; changing status alone revokes existing RLS/Telegram.
  update public.ofa_users app_user
  set status = 'deleted'
  where app_user.id = p_user_id;

  insert into public.audit_events (
    actor_user_id, actor_type, action, entity_type, entity_id, after_data
  ) values (
    p_user_id, 'user', 'privacy.erasure_requested', 'gdpr_request', v_request_id,
    pg_catalog.jsonb_build_object('grace_ends_at', v_due_at)
  );
  return query select v_request_id, v_due_at;
end;
$$;

create or replace function public.confirm_account_erasure(p_confirmation text)
returns table (request_id uuid, grace_ends_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query select * from public.confirm_account_erasure_internal(
    public.current_ofa_user_id(), p_confirmation
  );
end;
$$;

create or replace function public.confirm_telegram_account_erasure(
  p_telegram_user_id text,
  p_confirmation text
)
returns table (request_id uuid, grace_ends_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query select * from public.confirm_account_erasure_internal(
    public.privacy_telegram_account_user_id(p_telegram_user_id), p_confirmation
  );
end;
$$;

create or replace function public.cancel_account_erasure_internal(p_user_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_request_id uuid;
begin
  if p_user_id is null then
    raise exception 'Account required' using errcode = '42501';
  end if;
  perform 1 from public.ofa_users app_user
  where app_user.id = p_user_id and app_user.status = 'deleted' and app_user.deleted_at is null
  for update;
  if not found then
    return false;
  end if;
  select request.id into v_request_id
  from public.gdpr_requests request
  where request.user_id = p_user_id
    and request.request_type = 'erasure'
    and request.status = 'requested'
    and request.due_at > pg_catalog.now()
  order by request.requested_at desc
  limit 1
  for update;
  if v_request_id is null then
    return false;
  end if;
  update public.gdpr_requests request
  set status = 'cancelled', completed_at = pg_catalog.now()
  where request.id = v_request_id;
  update public.ofa_users app_user
  set status = 'active'
  where app_user.id = p_user_id;
  -- Intentionally do not change workspace_members or workspaces. A prior
  -- explicit ownership transfer is a separate, already completed operation.
  insert into public.audit_events (
    actor_user_id, actor_type, action, entity_type, entity_id
  ) values (
    p_user_id, 'user', 'privacy.erasure_cancelled', 'gdpr_request', v_request_id
  );
  return true;
end;
$$;

create or replace function public.cancel_account_erasure()
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.cancel_account_erasure_internal(public.privacy_web_account_user_id());
end;
$$;

create or replace function public.cancel_telegram_account_erasure(p_telegram_user_id text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  return public.cancel_account_erasure_internal(
    public.privacy_telegram_account_user_id(p_telegram_user_id)
  );
end;
$$;

revoke all on function public.privacy_web_account_user_id() from public, anon, service_role;
revoke all on function public.privacy_telegram_account_user_id(text) from public, anon, authenticated;
revoke all on function public.account_erasure_preview_internal(uuid) from public, anon, authenticated;
revoke all on function public.account_erasure_preview() from public, anon, service_role;
revoke all on function public.telegram_account_erasure_preview(text) from public, anon, authenticated;
revoke all on function public.confirm_account_erasure_internal(uuid, text) from public, anon, authenticated;
revoke all on function public.confirm_account_erasure(text) from public, anon, service_role;
revoke all on function public.confirm_telegram_account_erasure(text, text) from public, anon, authenticated;
revoke all on function public.cancel_account_erasure_internal(uuid) from public, anon, authenticated;
revoke all on function public.cancel_account_erasure() from public, anon, service_role;
revoke all on function public.cancel_telegram_account_erasure(text) from public, anon, authenticated;
grant execute on function public.privacy_web_account_user_id() to authenticated;
grant execute on function public.privacy_telegram_account_user_id(text) to service_role;
grant execute on function public.account_erasure_preview_internal(uuid) to service_role;
grant execute on function public.account_erasure_preview() to authenticated;
grant execute on function public.telegram_account_erasure_preview(text) to service_role;
grant execute on function public.confirm_account_erasure_internal(uuid, text) to service_role;
grant execute on function public.confirm_account_erasure(text) to authenticated;
grant execute on function public.confirm_telegram_account_erasure(text, text) to service_role;
grant execute on function public.cancel_account_erasure_internal(uuid) to service_role;
grant execute on function public.cancel_account_erasure() to authenticated;
grant execute on function public.cancel_telegram_account_erasure(text) to service_role;

create or replace function public.list_eligible_ownership_successors(p_workspace_id uuid)
returns table (user_id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := public.current_ofa_user_id();
begin
  if v_owner_id is null or not exists (
    select 1 from public.workspace_members owner_member
    join public.workspaces workspace on workspace.id = owner_member.workspace_id
    where owner_member.workspace_id = p_workspace_id
      and owner_member.user_id = v_owner_id
      and owner_member.role = 'owner'
      and owner_member.status = 'active'
      and owner_member.removed_at is null
      and workspace.deleted_at is null
  ) then
    raise exception 'Only an active workspace owner may list successors' using errcode = '42501';
  end if;
  return query
  select member.user_id, coalesce(nullif(pg_catalog.btrim(app_user.display_name), ''), 'Člen účtu')
  from public.workspace_members member
  join public.ofa_users app_user on app_user.id = member.user_id
  where member.workspace_id = p_workspace_id
    and member.user_id <> v_owner_id
    and member.status = 'active'
    and member.removed_at is null
    and member.role in ('admin', 'member')
    and app_user.status = 'active'
    and app_user.deleted_at is null
  order by member.joined_at, member.user_id;
end;
$$;

revoke all on function public.list_eligible_ownership_successors(uuid) from public, anon, service_role;
grant execute on function public.list_eligible_ownership_successors(uuid) to authenticated;

create or replace function public.list_telegram_eligible_ownership_successors(
  p_telegram_user_id text,
  p_workspace_id uuid
)
returns table (user_id uuid, display_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_owner_id uuid := public.privacy_telegram_account_user_id(p_telegram_user_id);
begin
  if v_owner_id is null or not exists (
    select 1 from public.workspace_members owner_member
    join public.workspaces workspace on workspace.id = owner_member.workspace_id
    join public.ofa_users owner_user on owner_user.id = owner_member.user_id
    where owner_member.workspace_id = p_workspace_id
      and owner_member.user_id = v_owner_id
      and owner_member.role = 'owner'
      and owner_member.status = 'active'
      and owner_member.removed_at is null
      and workspace.deleted_at is null
      and owner_user.status = 'active'
      and owner_user.deleted_at is null
  ) then
    raise exception 'Only an active workspace owner may list successors' using errcode = '42501';
  end if;
  return query
  select member.user_id, coalesce(nullif(pg_catalog.btrim(app_user.display_name), ''), 'Člen účtu')
  from public.workspace_members member
  join public.ofa_users app_user on app_user.id = member.user_id
  where member.workspace_id = p_workspace_id
    and member.user_id <> v_owner_id
    and member.status = 'active'
    and member.removed_at is null
    and member.role in ('admin', 'member')
    and app_user.status = 'active'
    and app_user.deleted_at is null
  order by member.joined_at, member.user_id;
end;
$$;

revoke all on function public.list_telegram_eligible_ownership_successors(text, uuid) from public, anon, authenticated;
grant execute on function public.list_telegram_eligible_ownership_successors(text, uuid) to service_role;

create or replace function public.get_my_account_erasure_state()
returns table (request_id uuid, grace_ends_at timestamptz, can_cancel boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := public.privacy_web_account_user_id();
begin
  if v_user_id is null then
    raise exception 'Verified account required' using errcode = '42501';
  end if;
  return query
  select request.id, request.due_at,
    (request.status = 'requested' and request.due_at > pg_catalog.now())
  from public.gdpr_requests request
  where request.user_id = v_user_id
    and request.request_type = 'erasure'
    and request.status in ('requested', 'processing')
  order by request.requested_at desc
  limit 1;
end;
$$;

revoke all on function public.get_my_account_erasure_state() from public, anon, service_role;
grant execute on function public.get_my_account_erasure_state() to authenticated;

-- Durable, bounded finalization lease. No request is claimed before its
-- 30-day grace deadline, and a crashed worker can be reclaimed safely.
alter table public.gdpr_requests
  add column if not exists erasure_lease_token uuid,
  add column if not exists erasure_lease_expires_at timestamptz,
  add column if not exists erasure_attempt_count smallint not null default 0
    check (erasure_attempt_count between 0 and 10),
  add column if not exists erasure_retry_after timestamptz,
  add column if not exists erasure_last_error_code varchar(64),
  add column if not exists erasure_backup_confirmed_at timestamptz;

create index if not exists gdpr_requests_erasure_due_idx
  on public.gdpr_requests (due_at, erasure_retry_after)
  where request_type = 'erasure' and status in ('requested', 'processing');

create or replace function public.claim_due_account_erasures(p_limit integer default 2)
returns table (request_id uuid, user_id uuid, lease_token uuid)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 2 then
    raise exception 'Invalid erasure claim limit' using errcode = '22023';
  end if;
  return query
  with candidate as (
    select request.id
    from public.gdpr_requests request
    join public.ofa_users app_user on app_user.id = request.user_id
    where request.request_type = 'erasure'
      and request.status in ('requested', 'processing')
      and request.due_at <= pg_catalog.now()
      and coalesce(request.erasure_retry_after, request.due_at) <= pg_catalog.now()
      and (request.status = 'requested' or request.erasure_lease_expires_at < pg_catalog.now())
      and request.erasure_attempt_count < 10
      -- No irreversible cleanup before an independent S3 backup has captured
      -- this request. A failed backup leaves the request pending, not erased.
      and request.erasure_backup_confirmed_at is not null
      and app_user.status = 'deleted'
      and app_user.deleted_at is null
    order by request.due_at, request.id
    for update of request skip locked
    limit p_limit
  ), claimed as (
    update public.gdpr_requests request
    set status = 'processing',
      erasure_lease_token = extensions.gen_random_uuid(),
      erasure_lease_expires_at = pg_catalog.now() + interval '15 minutes',
      erasure_attempt_count = request.erasure_attempt_count + 1,
      erasure_retry_after = null,
      erasure_last_error_code = null
    from candidate where request.id = candidate.id
    returning request.id, request.user_id, request.erasure_lease_token
  )
  select claimed.id, claimed.user_id, claimed.erasure_lease_token from claimed;
end;
$$;

-- A workspace is eligible for irreversible deletion only when its entire
-- membership history and every explicit owner reference are unambiguous.
-- Suspended/removed members still count: their historical data is not ours.
create or replace function public.is_exclusive_erasure_workspace(
  p_user_id uuid,
  p_workspace_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return exists (
    select 1 from public.workspaces workspace
    join public.workspace_members member on member.workspace_id = workspace.id
    where workspace.id = p_workspace_id
      and workspace.deleted_at is null
      and workspace.created_by_user_id = p_user_id
      and member.user_id = p_user_id
      and member.status = 'active'
      and member.removed_at is null
  )
  and not exists (
    select 1 from public.workspace_members member
    where member.workspace_id = p_workspace_id and member.user_id <> p_user_id
  )
  and not exists (
    select 1 from public.financial_transactions transaction
    where transaction.workspace_id = p_workspace_id and transaction.created_by_user_id <> p_user_id
  )
  and not exists (
    select 1 from public.ofa_receipts receipt
    where receipt.workspace_id = p_workspace_id and receipt.uploaded_by_user_id <> p_user_id
  )
  and not exists (
    select 1 from public.stored_files file
    where file.workspace_id = p_workspace_id
      and file.uploaded_by_user_id is distinct from p_user_id
  )
  and not exists (
    select 1 from public.report_schedules schedule
    where schedule.workspace_id = p_workspace_id
      and (schedule.created_by_user_id <> p_user_id
        or schedule.recipient_user_id is distinct from p_user_id)
  )
  and not exists (
    select 1 from public.budgets budget
    where budget.workspace_id = p_workspace_id and budget.created_by_user_id <> p_user_id
  )
  and not exists (
    select 1 from public.receipt_purchase_protections protection
    where protection.workspace_id = p_workspace_id and protection.recipient_user_id <> p_user_id
  )
  and not exists (
    select 1 from public.receipt_purchase_protection_reminders reminder
    where reminder.workspace_id = p_workspace_id and reminder.recipient_user_id <> p_user_id
  )
  and not exists (
    select 1 from public.audit_events event
    where event.workspace_id = p_workspace_id
      and event.actor_user_id is not null and event.actor_user_id <> p_user_id
  )
  and not exists (
    select 1 from public.transaction_events event
    join public.financial_transactions transaction on transaction.id = event.transaction_id
    where transaction.workspace_id = p_workspace_id
      and event.actor_user_id is not null and event.actor_user_id <> p_user_id
  )
  and not exists (
    select 1 from public.transaction_category_assignments assignment
    join public.financial_transactions transaction on transaction.id = assignment.transaction_id
    where transaction.workspace_id = p_workspace_id
      and assignment.assigned_by_user_id is not null
      and assignment.assigned_by_user_id <> p_user_id
  )
  and not exists (
    select 1 from public.receipt_transaction_links link
    join public.ofa_receipts receipt on receipt.id = link.receipt_id
    where receipt.workspace_id = p_workspace_id
      and link.linked_by_user_id is not null
      and link.linked_by_user_id <> p_user_id
  )
  and not exists (
    select 1 from public.notification_deliveries delivery
    where delivery.workspace_id = p_workspace_id
      and delivery.recipient_user_id <> p_user_id
  )
  and not exists (
    select 1 from public.notification_preferences preference
    where preference.workspace_id = p_workspace_id
      and preference.user_id <> p_user_id
  )
  and not exists (
    select 1 from public.budget_preferences preference
    where preference.workspace_id = p_workspace_id
      and preference.user_id <> p_user_id
  )
  and not exists (
    select 1 from public.telegram_budget_pending_states pending
    where pending.workspace_id = p_workspace_id
      and pending.user_id <> p_user_id
  )
  and not exists (
    select 1 from public.gdpr_requests request
    where request.requested_workspace_id = p_workspace_id and request.user_id <> p_user_id
  );
end;
$$;

revoke all on function public.is_exclusive_erasure_workspace(uuid, uuid) from public, anon, authenticated;
grant execute on function public.is_exclusive_erasure_workspace(uuid, uuid) to service_role;

create or replace function public.prevent_join_to_erasing_workspace()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.status = 'active' and exists (
    select 1 from public.workspaces workspace
    join public.ofa_users owner_user on owner_user.id = workspace.created_by_user_id
    join public.gdpr_requests request on request.user_id = owner_user.id
    where workspace.id = new.workspace_id
      and owner_user.status = 'deleted'
      and request.request_type = 'erasure'
      and request.status in ('requested', 'processing')
  ) then
    raise exception 'Workspace is pending account erasure' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists workspace_members_prevent_join_during_erasure on public.workspace_members;
create trigger workspace_members_prevent_join_during_erasure
  before insert or update of status, workspace_id on public.workspace_members
  for each row execute function public.prevent_join_to_erasing_workspace();

-- Storage deletion is scoped to exclusively owned workspaces. Even a file
-- uploaded by the departing user is preserved when it is part of a shared
-- workspace; otherwise its removal could break another member's receipt.
create or replace function public.list_account_erasure_storage_files(
  p_request_id uuid,
  p_lease_token uuid,
  p_limit integer default 25
)
returns table (file_id uuid, storage_key text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 25 then
    raise exception 'Invalid erasure file limit' using errcode = '22023';
  end if;
  select request.user_id into v_user_id
  from public.gdpr_requests request
  where request.id = p_request_id
    and request.request_type = 'erasure'
    and request.status = 'processing'
    and request.erasure_lease_token = p_lease_token
    and request.erasure_lease_expires_at > pg_catalog.now()
    and request.due_at <= pg_catalog.now();
  if v_user_id is null then
    raise exception 'Erasure lease is not active' using errcode = '42501';
  end if;
  return query
  select file.id, file.storage_key
  from public.stored_files file
  where file.deleted_at is null
    and public.is_exclusive_erasure_workspace(v_user_id, file.workspace_id)
  order by file.created_at, file.id
  limit p_limit;
end;
$$;

create or replace function public.mark_account_erasure_storage_file_removed(
  p_request_id uuid,
  p_lease_token uuid,
  p_file_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_expected_file_id uuid;
begin
  select candidate.file_id into v_expected_file_id
  from public.list_account_erasure_storage_files(p_request_id, p_lease_token, 25) candidate
  where candidate.file_id = p_file_id;
  if v_expected_file_id is null then
    return false;
  end if;
  update public.stored_files file
  set deleted_at = pg_catalog.now()
  where file.id = p_file_id and file.deleted_at is null;
  return found;
end;
$$;

create or replace function public.defer_account_erasure(
  p_request_id uuid,
  p_lease_token uuid,
  p_error_code text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_error_code is null or p_error_code !~ '^[a-z_]{1,64}$' then
    raise exception 'Invalid erasure error code' using errcode = '22023';
  end if;
  update public.gdpr_requests request
  set status = case when request.erasure_attempt_count >= 10 and p_error_code <> 'storage_pending'
      then 'processing'::public.gdpr_request_status else 'requested'::public.gdpr_request_status end,
    erasure_lease_token = null,
    erasure_lease_expires_at = null,
    erasure_attempt_count = case when p_error_code = 'storage_pending' then 0 else request.erasure_attempt_count end,
    erasure_retry_after = case
      when p_error_code = 'storage_pending' then pg_catalog.now() + interval '5 minutes'
      when request.erasure_attempt_count >= 10 then null
      else pg_catalog.now() + pg_catalog.make_interval(mins => least(240, 15 * request.erasure_attempt_count)) end,
    erasure_last_error_code = p_error_code
  where request.id = p_request_id
    and request.request_type = 'erasure'
    and request.status = 'processing'
    and request.erasure_lease_token = p_lease_token;
  return found;
end;
$$;

revoke all on function public.claim_due_account_erasures(integer) from public, anon, authenticated;
revoke all on function public.list_account_erasure_storage_files(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.mark_account_erasure_storage_file_removed(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.defer_account_erasure(uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_due_account_erasures(integer) to service_role;
grant execute on function public.list_account_erasure_storage_files(uuid, uuid, integer) to service_role;
grant execute on function public.mark_account_erasure_storage_file_removed(uuid, uuid, uuid) to service_role;
grant execute on function public.defer_account_erasure(uuid, uuid, text) to service_role;

-- Called only after the worker has confirmed physical Storage removal and,
-- when present, Supabase Auth user deletion. All DB changes commit atomically.
-- Shared workspace finances, receipts, reports and audit history are retained.
create or replace function public.finalize_account_erasure(
  p_request_id uuid,
  p_lease_token uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid;
  v_workspace_id uuid;
  v_category_count integer;
begin
  select request.user_id into v_user_id
  from public.gdpr_requests request
  where request.id = p_request_id
    and request.request_type = 'erasure'
    and request.status = 'processing'
    and request.erasure_lease_token = p_lease_token
    and request.erasure_lease_expires_at > pg_catalog.now()
    and request.due_at <= pg_catalog.now()
  for update;
  if v_user_id is null then
    raise exception 'Erasure lease is not active' using errcode = '42501';
  end if;
  perform 1 from public.ofa_users app_user
  where app_user.id = v_user_id
    and app_user.status = 'deleted'
    and app_user.deleted_at is null
    and app_user.auth_user_id is null
  for update;
  if not found then
    raise exception 'Account or Auth deletion is not ready' using errcode = '55000';
  end if;

  -- A sole-member workspace may still contain historical records created by
  -- another user. Such a workspace is held for operator reconciliation.
  for v_workspace_id in
    select member.workspace_id from public.workspace_members member
    join public.workspaces workspace on workspace.id = member.workspace_id
    where member.user_id = v_user_id and workspace.deleted_at is null
    order by member.workspace_id
  loop
    perform 1 from public.workspaces workspace
    where workspace.id = v_workspace_id for update;
    if not exists (
      select 1 from public.workspace_members other_member
      where other_member.workspace_id = v_workspace_id and other_member.user_id <> v_user_id
    ) then
      if not public.is_exclusive_erasure_workspace(v_user_id, v_workspace_id) then
        raise exception 'Workspace ownership requires reconciliation' using errcode = '55000';
      end if;
      if exists (
        select 1 from public.stored_files file
        where file.workspace_id = v_workspace_id and file.deleted_at is null
      ) then
        raise exception 'Storage removal is incomplete' using errcode = '55000';
      end if;

      delete from public.receipt_purchase_protection_reminders reminder
        where reminder.workspace_id = v_workspace_id;
      delete from public.receipt_transaction_links link
        using public.ofa_receipts receipt
        where link.receipt_id = receipt.id and receipt.workspace_id = v_workspace_id;
      delete from public.receipt_line_items item where item.workspace_id = v_workspace_id;
      delete from public.receipt_ocr_runs run
        using public.ofa_receipts receipt
        where run.receipt_id = receipt.id and receipt.workspace_id = v_workspace_id;
      delete from public.receipt_purchase_protections protection
        where protection.workspace_id = v_workspace_id;

      perform pg_catalog.set_config('ofa.privacy_cleanup', 'on', true);
      delete from public.transaction_category_assignments assignment
        using public.financial_transactions transaction
        where assignment.transaction_id = transaction.id and transaction.workspace_id = v_workspace_id;
      delete from public.transaction_events event
        using public.financial_transactions transaction
        where event.transaction_id = transaction.id and transaction.workspace_id = v_workspace_id;
      delete from public.audit_events event where event.workspace_id = v_workspace_id;
      perform pg_catalog.set_config('ofa.privacy_cleanup', 'off', true);

      delete from public.budget_alert_events alert where alert.workspace_id = v_workspace_id;
      delete from public.budget_preferences preference where preference.workspace_id = v_workspace_id;
      delete from public.telegram_budget_pending_states pending where pending.workspace_id = v_workspace_id;
      delete from public.notification_deliveries delivery where delivery.workspace_id = v_workspace_id;
      delete from public.notification_preferences preference where preference.workspace_id = v_workspace_id;
      delete from public.report_deliveries delivery where delivery.workspace_id = v_workspace_id;
      delete from public.report_schedules schedule where schedule.workspace_id = v_workspace_id;
      delete from public.budgets budget where budget.workspace_id = v_workspace_id;
      delete from public.category_rules rule
        using public.categories category
        where rule.category_id = category.id and category.workspace_id = v_workspace_id;
      delete from public.ofa_receipts receipt where receipt.workspace_id = v_workspace_id;
      delete from public.financial_transactions transaction where transaction.workspace_id = v_workspace_id;
      delete from public.channel_messages message
        using public.conversations conversation
        where message.conversation_id = conversation.id and conversation.workspace_id = v_workspace_id;
      delete from public.conversations conversation where conversation.workspace_id = v_workspace_id;
      delete from public.async_jobs job where job.workspace_id = v_workspace_id;
      delete from public.ai_runs run where run.workspace_id = v_workspace_id;
      update public.gdpr_requests request set requested_workspace_id = null
        where request.user_id = v_user_id and request.requested_workspace_id = v_workspace_id;
      delete from public.stored_files file where file.workspace_id = v_workspace_id;

      -- Parent categories are removed only after their children. Any external
      -- reference causes a hard failure and rolls back this whole finalizer.
      loop
        delete from public.categories category
        where category.workspace_id = v_workspace_id
          and not exists (
            select 1 from public.categories child where child.parent_category_id = category.id
          );
        get diagnostics v_category_count = row_count;
        exit when v_category_count = 0;
      end loop;
      if exists (select 1 from public.categories category where category.workspace_id = v_workspace_id) then
        raise exception 'Category dependency requires reconciliation' using errcode = '55000';
      end if;
      delete from public.workspace_members member where member.workspace_id = v_workspace_id;
      delete from public.workspaces workspace where workspace.id = v_workspace_id;
    else
      -- No shared financial or receipt row is removed. In particular, the
      -- departing user's old uploads may be needed by remaining members.
      if exists (
        select 1 from public.workspace_members member
        where member.workspace_id = v_workspace_id
          and member.user_id = v_user_id and member.role = 'owner'
      ) or exists (
        select 1 from public.workspaces workspace
        where workspace.id = v_workspace_id and workspace.created_by_user_id = v_user_id
      ) then
        raise exception 'Shared ownership transfer is incomplete' using errcode = '55000';
      end if;
      delete from public.receipt_purchase_protection_reminders reminder
        where reminder.workspace_id = v_workspace_id and reminder.recipient_user_id = v_user_id;
      delete from public.receipt_purchase_protections protection
        where protection.workspace_id = v_workspace_id and protection.recipient_user_id = v_user_id;
      delete from public.report_schedules schedule
        where schedule.workspace_id = v_workspace_id and schedule.recipient_user_id = v_user_id;
      delete from public.notification_deliveries delivery
        where delivery.workspace_id = v_workspace_id and delivery.recipient_user_id = v_user_id;
      delete from public.notification_preferences preference
        where preference.workspace_id = v_workspace_id and preference.user_id = v_user_id;
      delete from public.budget_preferences preference
        where preference.workspace_id = v_workspace_id and preference.user_id = v_user_id;
      delete from public.telegram_budget_pending_states pending
        where pending.workspace_id = v_workspace_id and pending.user_id = v_user_id;
      delete from public.workspace_members member
        where member.workspace_id = v_workspace_id and member.user_id = v_user_id;
    end if;
  end loop;

  -- Remove user-only identity, contact and device data. Keep a non-identifying
  -- user tombstone because shared records have RESTRICT foreign keys to it.
  delete from public.telegram_link_codes code
    where code.target_user_id = v_user_id or code.consumed_by_user_id = v_user_id;
  delete from public.user_devices device where device.user_id = v_user_id;
  delete from public.auth_identities identity where identity.user_id = v_user_id;
  delete from public.channel_accounts account where account.user_id = v_user_id;
  delete from public.notification_preferences preference where preference.user_id = v_user_id;
  delete from public.notification_deliveries delivery where delivery.recipient_user_id = v_user_id;
  delete from public.budget_preferences preference where preference.user_id = v_user_id;
  delete from public.telegram_budget_pending_states pending where pending.user_id = v_user_id;
  update public.user_consents consent set evidence = '{}'::jsonb where consent.user_id = v_user_id;
  update public.gdpr_requests request
    set export_file_id = null, rejection_reason = null
    where request.user_id = v_user_id;

  -- If a new direct ownership dependency appears, fail closed rather than
  -- misclassifying or deleting it. The entire transaction rolls back.
  if exists (select 1 from public.workspace_members member where member.user_id = v_user_id)
     or exists (select 1 from public.workspaces workspace where workspace.created_by_user_id = v_user_id)
     or exists (select 1 from public.report_schedules schedule where schedule.recipient_user_id = v_user_id)
     or exists (select 1 from public.receipt_purchase_protections protection where protection.recipient_user_id = v_user_id)
     or exists (select 1 from public.receipt_purchase_protection_reminders reminder where reminder.recipient_user_id = v_user_id) then
    raise exception 'Unresolved ownership requires reconciliation' using errcode = '55000';
  end if;

  update public.ofa_users app_user
  set display_name = null, email = null, auth_user_id = null,
    last_seen_at = null, locale = 'sk-SK', time_zone = 'Europe/Bratislava',
    deleted_at = pg_catalog.now()
  where app_user.id = v_user_id;
  update public.gdpr_requests request
  set status = 'completed', completed_at = pg_catalog.now(),
    erasure_lease_token = null, erasure_lease_expires_at = null,
    erasure_retry_after = null, erasure_last_error_code = null
  where request.id = p_request_id;
  return true;
end;
$$;

revoke all on function public.finalize_account_erasure(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_account_erasure(uuid, uuid) to service_role;

-- The existing daily AWS backup writes this minimal request ledger alongside
-- its database dump. It is independent of any one restored database snapshot.
create or replace function public.list_erasure_reconciliation_snapshot(
  p_after uuid default null,
  p_limit integer default 500
)
returns table (
  request_id uuid, user_id uuid, request_status text,
  requested_at timestamptz, due_at timestamptz, completed_at timestamptz
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 500 then
    raise exception 'Invalid reconciliation page size' using errcode = '22023';
  end if;
  return query
  select request.id, request.user_id, request.status::text,
    request.requested_at, request.due_at, request.completed_at
  from public.gdpr_requests request
  where request.request_type = 'erasure'
    and (p_after is null or request.id > p_after)
    and (
      request.status in ('requested', 'processing')
      or request.requested_at >= pg_catalog.now() - interval '32 days'
      or request.completed_at >= pg_catalog.now() - interval '32 days'
    )
  order by request.id
  limit p_limit;
end;
$$;

revoke all on function public.list_erasure_reconciliation_snapshot(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.list_erasure_reconciliation_snapshot(uuid, integer)
  to service_role;

-- Called only after the backup manifest was uploaded and read back from S3.
-- A request confirmed after the snapshot cannot be acknowledged by that run.
create or replace function public.ack_erasure_reconciliation_snapshot(
  p_snapshot_at timestamptz,
  p_request_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare v_count integer;
begin
  if p_snapshot_at is null or p_snapshot_at > pg_catalog.now()
     or p_snapshot_at < pg_catalog.now() - interval '2 hours'
     or p_request_ids is null or pg_catalog.array_length(p_request_ids, 1) > 500 then
    raise exception 'Invalid reconciliation acknowledgement' using errcode = '22023';
  end if;
  update public.gdpr_requests request
  set erasure_backup_confirmed_at = pg_catalog.now()
  where request.id = any(p_request_ids)
    and request.request_type = 'erasure'
    and request.status in ('requested', 'processing')
    and request.requested_at <= p_snapshot_at;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.ack_erasure_reconciliation_snapshot(timestamptz, uuid[])
  from public, anon, authenticated;
grant execute on function public.ack_erasure_reconciliation_snapshot(timestamptz, uuid[])
  to service_role;
