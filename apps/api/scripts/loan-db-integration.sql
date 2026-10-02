\set ON_ERROR_STOP on

-- Disposable database only; every identity and financial amount below is synthetic.
insert into public.ofa_users (id, display_name) values
  ('10000000-0000-4000-8000-00000000a001', 'Synthetic lender'),
  ('10000000-0000-4000-8000-00000000a002', 'Synthetic other member');
insert into public.workspaces (id, name, workspace_type, base_currency_code, created_by_user_id) values
  ('10000000-0000-4000-8000-00000000b001', 'Synthetic loan workspace', 'personal', 'EUR', '10000000-0000-4000-8000-00000000a001'),
  ('10000000-0000-4000-8000-00000000b002', 'Synthetic isolated workspace', 'personal', 'EUR', '10000000-0000-4000-8000-00000000a002');
insert into public.workspace_members (workspace_id, user_id, role, status, joined_at) values
  ('10000000-0000-4000-8000-00000000b001', '10000000-0000-4000-8000-00000000a001', 'owner', 'active', now()),
  ('10000000-0000-4000-8000-00000000b002', '10000000-0000-4000-8000-00000000a002', 'owner', 'active', now());
insert into public.channel_accounts (user_id, channel, external_account_id) values
  ('10000000-0000-4000-8000-00000000a001', 'telegram', '111111111'),
  ('10000000-0000-4000-8000-00000000a002', 'telegram', '222222222');

do $$
declare
  result record;
  jano_id uuid;
  failed boolean;
begin
  select * into result from public.record_telegram_loan_movement(
    '111111111','111111111','1','1001','Jano',null,'lent','principal',50000,'EUR',null,'2026-10-01T10:00:00Z');
  if result.remaining_minor <> 50000 or result.was_duplicate then raise exception 'Principal was not recorded'; end if;
  select id into jano_id from public.loan_counterparties where name = 'Jano';
  select * into result from public.record_telegram_loan_movement(
    '111111111','111111111','1','1001','Jano',null,'lent','principal',50000,'EUR',null,'2026-10-01T10:00:00Z');
  if not result.was_duplicate or (select count(*) from public.personal_loans
      where workspace_id = '10000000-0000-4000-8000-00000000b001') <> 1 then
    raise exception 'Loan replay duplicated the principal';
  end if;
  select * into result from public.record_telegram_loan_movement(
    '111111111','111111111','2','1002',null,jano_id,'lent','principal',5000,'EUR',null,'2026-10-02T10:00:00Z');
  if result.remaining_minor <> 55000 then raise exception 'Second loan did not aggregate'; end if;
  select * into result from public.record_telegram_loan_movement(
    '111111111','111111111','3','1003',null,jano_id,'lent','repayment',20000,'EUR',null,'2026-10-03T10:00:00Z');
  if result.remaining_minor <> 35000 then raise exception 'Partial repayment did not update balance'; end if;
  if not exists (select 1 from public.personal_loans where original_minor = 50000 and repaid_minor = 20000) then
    raise exception 'Repayment did not allocate to oldest loan first';
  end if;
  failed := false;
  begin
    perform public.record_telegram_loan_movement(
      '111111111','111111111','4','1004',null,jano_id,'lent','repayment',40000,'EUR');
  exception when numeric_value_out_of_range then failed := true;
  end;
  if not failed or (select count(*) from public.loan_movements
      where workspace_id = '10000000-0000-4000-8000-00000000b001') <> 3 then
    raise exception 'Overpayment created a movement';
  end if;
  select * into result from public.record_telegram_loan_movement(
    '111111111','111111111','5','1005',null,jano_id,'lent','repayment',35000,'EUR',null,'2026-10-04T10:00:00Z');
  if result.remaining_minor <> 0 or exists (select 1 from public.personal_loans
      where workspace_id = '10000000-0000-4000-8000-00000000b001' and status = 'OPEN') then
    raise exception 'Settlement left an open loan';
  end if;
  failed := false;
  begin
    perform public.record_telegram_loan_movement(
      '222222222','222222222','6','1006',null,jano_id,'lent','repayment',100,'EUR');
  exception when invalid_parameter_value then failed := true;
  end;
  if not failed then raise exception 'Cross-workspace counterparty accepted'; end if;
  if public.void_last_telegram_loan_movement('222222222', result.movement_id) then
    raise exception 'Cross-user void accepted';
  end if;
  if (select count(*) from public.financial_transactions
      where workspace_id = '10000000-0000-4000-8000-00000000b001' and transaction_type <> 'transfer') <> 0 then
    raise exception 'Loan distorted ordinary transaction totals';
  end if;
  if pg_catalog.has_table_privilege('authenticated', 'public.personal_loans', 'SELECT') then
    raise exception 'Loan table exposed to browser role';
  end if;
end;
$$;

do $$
declare
  created_workspace uuid;
  martin_id uuid;
  result record;
begin
  created_workspace := public.ensure_telegram_loan_workspace('333333333', 'Synthetic newcomer', 'EUR');
  if created_workspace is null or created_workspace <> public.ensure_telegram_loan_workspace('333333333', 'Synthetic newcomer', 'EUR') then
    raise exception 'First-use loan workspace was not idempotent';
  end if;
  if exists (select 1 from public.financial_transactions where workspace_id = created_workspace) then
    raise exception 'First-use setup created a fake financial transaction';
  end if;
  select * into result from public.record_telegram_loan_movement(
    '333333333','333333333','1','2001','Martin',null,'borrowed','principal',30000,'EUR');
  if result.remaining_minor <> 30000 then raise exception 'Borrowed loan missing'; end if;
  select id into martin_id from public.loan_counterparties where workspace_id = created_workspace and name = 'Martin';
  select * into result from public.record_telegram_loan_movement(
    '333333333','333333333','2','2002',null,martin_id,'borrowed','repayment',10000,'EUR');
  if result.remaining_minor <> 20000 then raise exception 'Borrowed repayment missing'; end if;
end;
$$;

do $$
declare result record;
begin
  select * into result from public.record_telegram_loan_movement(
    '111111111','111111111','7','1007','Peter',null,'lent','principal',1000,'EUR');
  if result.remaining_minor <> 1000 then raise exception 'Last loan was not created'; end if;
end;
$$;

do $$
declare last_id uuid;
begin
  select m.id into last_id from public.loan_movements m
  where m.telegram_update_id = '1007';
  if not public.void_last_telegram_loan_movement('111111111', last_id) then
    raise exception 'Last principal could not be voided';
  end if;
  if exists (select 1 from public.personal_loans where workspace_id = '10000000-0000-4000-8000-00000000b001'
      and original_minor = 1000 and status <> 'VOIDED') then
    raise exception 'Voided principal remains open';
  end if;
  if not exists (select 1 from public.transaction_events where event_type = 'voided'
      and transaction_id = (select transaction_id from public.loan_movements where id = last_id)) then
    raise exception 'Loan void was not audited';
  end if;
end;
$$;
