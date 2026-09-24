\set ON_ERROR_STOP on

-- Disposable CI database only. All identities and records are synthetic.
insert into public.ofa_users (id, display_name, email) values
  ('00000000-0000-4000-8000-00000000a001', 'Synthetic departing owner', 'privacy-a@example.invalid'),
  ('00000000-0000-4000-8000-00000000a002', 'Synthetic remaining member', 'privacy-b@example.invalid'),
  ('00000000-0000-4000-8000-00000000a003', 'Synthetic sole owner', 'privacy-c@example.invalid'),
  ('00000000-0000-4000-8000-00000000a004', 'Synthetic cancellation', 'privacy-d@example.invalid'),
  ('00000000-0000-4000-8000-00000000a005', 'Synthetic inactive member', 'privacy-e@example.invalid');

insert into public.workspaces (id, name, workspace_type, base_currency_code, created_by_user_id) values
  ('00000000-0000-4000-8000-00000000b001', 'Synthetic shared', 'family', 'EUR', '00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000b002', 'Synthetic sole', 'personal', 'EUR', '00000000-0000-4000-8000-00000000a003'),
  ('00000000-0000-4000-8000-00000000b003', 'Synthetic cancel', 'personal', 'EUR', '00000000-0000-4000-8000-00000000a004');

insert into public.workspace_members (workspace_id, user_id, role, status, joined_at) values
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a001', 'owner', 'active', now()),
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a002', 'member', 'active', now()),
  ('00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a005', 'member', 'suspended', now()),
  ('00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000a003', 'owner', 'active', now()),
  ('00000000-0000-4000-8000-00000000b003', '00000000-0000-4000-8000-00000000a004', 'owner', 'active', now());

insert into public.financial_transactions (
  id, workspace_id, created_by_user_id, transaction_type, amount_minor,
  currency_code, occurred_at, time_zone, source, confirmed_at
) values
  ('00000000-0000-4000-8000-00000000e001', '00000000-0000-4000-8000-00000000b001', '00000000-0000-4000-8000-00000000a001', 'expense', 1234, 'EUR', now(), 'Europe/Bratislava', 'manual', now()),
  ('00000000-0000-4000-8000-00000000e002', '00000000-0000-4000-8000-00000000b002', '00000000-0000-4000-8000-00000000a003', 'expense', 5678, 'EUR', now(), 'Europe/Bratislava', 'manual', now());

insert into public.report_deliveries (
  id, workspace_id, report_type, period_start, period_end,
  base_currency_code, data_snapshot, status, sent_at
) values (
  '00000000-0000-4000-8000-00000000f001',
  '00000000-0000-4000-8000-00000000b001', 'monthly_summary',
  now() - interval '1 month', now(), 'EUR', '{"income":0,"expense":1234}', 'sent', now()
);

insert into public.stored_files (
  id, workspace_id, storage_provider, storage_key, content_type,
  byte_size, sha256, uploaded_by_user_id
) values
  ('00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000b001', 'supabase_storage', 'synthetic/shared.jpg', 'image/jpeg', 10, decode(repeat('aa', 32), 'hex'), '00000000-0000-4000-8000-00000000a001'),
  ('00000000-0000-4000-8000-00000000c002', '00000000-0000-4000-8000-00000000b002', 'supabase_storage', 'synthetic/sole.jpg', 'image/jpeg', 10, decode(repeat('bb', 32), 'hex'), '00000000-0000-4000-8000-00000000a003');

insert into public.ofa_receipts (
  id, workspace_id, file_id, uploaded_by_user_id, status, archive_status, receipt_date
) values (
  '00000000-0000-4000-8000-00000000d001', '00000000-0000-4000-8000-00000000b001',
  '00000000-0000-4000-8000-00000000c001', '00000000-0000-4000-8000-00000000a001',
  'completed', 'archived', current_date
);

do $$
declare
  blocked boolean := false;
  request_row record;
  claim record;
begin
  begin
    perform public.confirm_account_erasure_internal('00000000-0000-4000-8000-00000000a001', 'VYMAZAŤ ÚČET');
  exception when check_violation then
    blocked := true;
  end;
  if not blocked then raise exception 'Shared owner erasure was not blocked before explicit transfer'; end if;

  blocked := false;
  begin
    perform public.transfer_workspace_ownership_for_erasure_internal(
      '00000000-0000-4000-8000-00000000a001',
      '00000000-0000-4000-8000-00000000b001',
      '00000000-0000-4000-8000-00000000a004'
    );
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'Non-member successor was accepted'; end if;

  blocked := false;
  begin
    perform public.transfer_workspace_ownership_for_erasure_internal(
      '00000000-0000-4000-8000-00000000a001',
      '00000000-0000-4000-8000-00000000b001',
      '00000000-0000-4000-8000-00000000a005'
    );
  exception when insufficient_privilege then blocked := true;
  end;
  if not blocked then raise exception 'Inactive successor was accepted'; end if;

  perform public.transfer_workspace_ownership_for_erasure_internal(
    '00000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-00000000b001',
    '00000000-0000-4000-8000-00000000a002'
  );
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = '00000000-0000-4000-8000-00000000b001'
      and user_id = '00000000-0000-4000-8000-00000000a002' and role = 'owner'
  ) then raise exception 'Explicit transfer did not select the intended successor'; end if;
  if not exists (
    select 1 from public.workspaces
    where id = '00000000-0000-4000-8000-00000000b002'
      and created_by_user_id = '00000000-0000-4000-8000-00000000a003'
  ) then raise exception 'Transfer changed another workspace'; end if;

  perform public.confirm_account_erasure_internal('00000000-0000-4000-8000-00000000a001', 'VYMAZAŤ ÚČET');
  if not public.cancel_account_erasure_internal('00000000-0000-4000-8000-00000000a001') then
    raise exception 'Transferred owner could not cancel during grace';
  end if;
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = '00000000-0000-4000-8000-00000000b001'
      and user_id = '00000000-0000-4000-8000-00000000a002' and role = 'owner'
  ) then raise exception 'Cancellation reverted explicit ownership transfer'; end if;
  perform public.confirm_account_erasure_internal('00000000-0000-4000-8000-00000000a001', 'VYMAZAŤ ÚČET');
  perform public.confirm_account_erasure_internal('00000000-0000-4000-8000-00000000a003', 'VYMAZAŤ ÚČET');
  perform public.confirm_account_erasure_internal('00000000-0000-4000-8000-00000000a004', 'VYMAZAŤ ÚČET');
  if not public.cancel_account_erasure_internal('00000000-0000-4000-8000-00000000a004') then
    raise exception 'Grace-period cancellation failed';
  end if;
  if not exists (select 1 from public.workspaces where id = '00000000-0000-4000-8000-00000000b003') then
    raise exception 'Cancellation removed workspace data';
  end if;
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = '00000000-0000-4000-8000-00000000b001'
      and user_id = '00000000-0000-4000-8000-00000000a002' and role = 'owner'
  ) then raise exception 'Cancellation reverted a separate ownership transfer'; end if;

  -- Advance only synthetic requests in this disposable CI database.
  update public.gdpr_requests set due_at = now() - interval '1 minute'
  where user_id in (
    '00000000-0000-4000-8000-00000000a001',
    '00000000-0000-4000-8000-00000000a003'
  ) and request_type = 'erasure';

  for claim in select * from public.claim_due_account_erasures(2) loop
    if claim.user_id = '00000000-0000-4000-8000-00000000a001' then
      if exists (
        select 1 from public.list_account_erasure_storage_files(claim.request_id, claim.lease_token, 25)
      ) then raise exception 'Shared receipt was listed for deletion'; end if;
    elsif claim.user_id = '00000000-0000-4000-8000-00000000a003' then
      if not exists (
        select 1 from public.list_account_erasure_storage_files(claim.request_id, claim.lease_token, 25)
        where file_id = '00000000-0000-4000-8000-00000000c002'
      ) then raise exception 'Sole-owner receipt was not listed'; end if;
      if not public.mark_account_erasure_storage_file_removed(
        claim.request_id, claim.lease_token, '00000000-0000-4000-8000-00000000c002'
      ) then raise exception 'Synthetic Storage metadata could not be marked'; end if;
    else
      raise exception 'Unexpected account erasure claim';
    end if;
    if not public.finalize_account_erasure(claim.request_id, claim.lease_token) then
      raise exception 'Synthetic erasure was not finalized';
    end if;
  end loop;

  if not exists (select 1 from public.financial_transactions where id = '00000000-0000-4000-8000-00000000e001')
     or not exists (select 1 from public.report_deliveries where id = '00000000-0000-4000-8000-00000000f001')
     or not exists (select 1 from public.ofa_receipts where id = '00000000-0000-4000-8000-00000000d001')
     or not exists (select 1 from public.stored_files where id = '00000000-0000-4000-8000-00000000c001') then
    raise exception 'Shared workspace data was removed';
  end if;
  if exists (select 1 from public.workspace_members where user_id = '00000000-0000-4000-8000-00000000a001')
     or exists (select 1 from public.workspaces where id = '00000000-0000-4000-8000-00000000b002')
     or exists (select 1 from public.financial_transactions where id = '00000000-0000-4000-8000-00000000e002') then
    raise exception 'Account or sole workspace was not erased';
  end if;
  if not exists (
    select 1 from public.ofa_users
    where id = '00000000-0000-4000-8000-00000000a001'
      and email is null and display_name is null and deleted_at is not null
  ) then raise exception 'Departing user tombstone still contains direct identity'; end if;
  if not exists (
    select 1 from public.ofa_users
    where id = '00000000-0000-4000-8000-00000000a002'
      and email = 'privacy-b@example.invalid' and status = 'active'
  ) then raise exception 'Remaining member was altered'; end if;
end;
$$;
