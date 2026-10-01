-- Personal loans are transfers, never ordinary income or consumption.
create table public.loan_counterparties (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  name text not null check (length(trim(name)) between 2 and 120),
  name_key text generated always as (lower(trim(name))) stored,
  created_by_user_id uuid not null references public.ofa_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (workspace_id, name_key),
  unique (id, workspace_id)
);

create table public.personal_loans (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  counterparty_id uuid not null,
  created_by_user_id uuid not null references public.ofa_users(id) on delete restrict,
  direction text not null check (direction in ('lent', 'borrowed')),
  original_minor bigint not null check (original_minor > 0),
  repaid_minor bigint not null default 0 check (repaid_minor >= 0 and repaid_minor <= original_minor),
  currency_code char(3) not null references public.currencies(code),
  due_on date,
  opened_at timestamptz not null default now(),
  status text not null default 'OPEN' check (status in ('OPEN', 'SETTLED', 'VOIDED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint personal_loans_counterparty_fk foreign key (counterparty_id, workspace_id)
    references public.loan_counterparties(id, workspace_id) on delete restrict,
  unique (id, workspace_id),
  check ((status = 'OPEN' and repaid_minor < original_minor)
    or (status = 'SETTLED' and repaid_minor = original_minor)
    or (status = 'VOIDED' and repaid_minor = 0))
);
create index personal_loans_open_idx on public.personal_loans
  (workspace_id, counterparty_id, direction, currency_code, opened_at, id)
  where status = 'OPEN';

create table public.loan_movements (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  counterparty_id uuid not null,
  direction text not null check (direction in ('lent', 'borrowed')),
  kind text not null check (kind in ('principal', 'repayment')),
  amount_minor bigint not null check (amount_minor > 0),
  currency_code char(3) not null references public.currencies(code),
  transaction_id uuid not null unique references public.financial_transactions(id) on delete cascade,
  telegram_update_id text not null unique,
  created_by_user_id uuid not null references public.ofa_users(id) on delete restrict,
  occurred_at timestamptz not null default now(),
  voided_at timestamptz,
  constraint loan_movements_counterparty_fk foreign key (counterparty_id, workspace_id)
    references public.loan_counterparties(id, workspace_id) on delete restrict,
  unique (id, workspace_id)
);
create index loan_movements_workspace_recent_idx on public.loan_movements
  (workspace_id, created_by_user_id, occurred_at desc, id desc) where voided_at is null;

create or replace function public.protect_loan_transfer()
returns trigger language plpgsql set search_path = '' as $$
begin
  if exists (select 1 from public.loan_movements m where m.transaction_id = old.id)
    and (new.status, new.amount_minor, new.currency_code, new.transaction_type, new.deleted_at)
      is distinct from (old.status, old.amount_minor, old.currency_code, old.transaction_type, old.deleted_at)
    and pg_catalog.current_setting('ofa.loan_void', true) is distinct from 'on' then
    raise exception 'Loan movement must be changed through the loan ledger' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger financial_transactions_protect_loan_transfer before update on public.financial_transactions
  for each row execute function public.protect_loan_transfer();

create table public.loan_allocations (
  id uuid not null unique default gen_random_uuid(),
  movement_id uuid not null,
  loan_id uuid not null,
  workspace_id uuid not null,
  amount_minor bigint not null check (amount_minor > 0),
  primary key (movement_id, loan_id),
  foreign key (movement_id, workspace_id) references public.loan_movements(id, workspace_id) on delete cascade,
  foreign key (loan_id, workspace_id) references public.personal_loans(id, workspace_id) on delete restrict
);
create index loan_allocations_loan_idx on public.loan_allocations (loan_id);

create table public.telegram_loan_pending_states (
  id uuid not null unique default gen_random_uuid(),
  user_id uuid primary key references public.ofa_users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  intent text not null check (intent in ('missing_name', 'ambiguous_name')),
  kind text not null check (kind in ('principal', 'repayment')),
  direction text not null check (direction in ('lent', 'borrowed')),
  amount_minor bigint not null check (amount_minor > 0),
  currency_code char(3) not null references public.currencies(code),
  due_on date,
  original_update_id text not null,
  original_message_id text not null,
  original_chat_id text not null,
  candidate_ids uuid[],
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

alter table public.loan_counterparties enable row level security;
alter table public.personal_loans enable row level security;
alter table public.loan_movements enable row level security;
alter table public.loan_allocations enable row level security;
alter table public.telegram_loan_pending_states enable row level security;
revoke all on public.loan_counterparties, public.personal_loans, public.loan_movements,
  public.loan_allocations, public.telegram_loan_pending_states from anon, authenticated;
grant select, insert, update, delete on public.loan_counterparties, public.personal_loans,
  public.loan_movements, public.loan_allocations, public.telegram_loan_pending_states to service_role;

create trigger personal_loans_set_updated_at before update on public.personal_loans
  for each row execute function public.set_updated_at();

-- Existing erasure finalizer deletes transactions before the exclusive workspace.
-- Cascaded movements disappear with transactions; this trigger removes the
-- remaining ledger and person rows only when that workspace is deleted.
create or replace function public.remove_exclusive_workspace_loans()
returns trigger language plpgsql set search_path = '' as $$
begin
  delete from public.telegram_loan_pending_states where workspace_id = old.id;
  delete from public.loan_allocations where workspace_id = old.id;
  delete from public.loan_movements where workspace_id = old.id;
  delete from public.personal_loans where workspace_id = old.id;
  delete from public.loan_counterparties where workspace_id = old.id;
  return old;
end;
$$;
create trigger workspaces_remove_exclusive_loans before delete on public.workspaces
  for each row execute function public.remove_exclusive_workspace_loans();

create or replace function public.remove_departing_member_loan_state()
returns trigger language plpgsql set search_path = '' as $$
begin
  delete from public.telegram_loan_pending_states
    where workspace_id = old.workspace_id and user_id = old.user_id;
  return old;
end;
$$;
create trigger workspace_members_remove_loan_state before delete on public.workspace_members
  for each row execute function public.remove_departing_member_loan_state();

create index telegram_loan_pending_expiry_idx on public.telegram_loan_pending_states (expires_at);
create or replace function public.cleanup_expired_loan_pending(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = '' as $$
declare v_count integer;
begin
  if p_limit < 1 or p_limit > 1000 then raise exception 'Invalid cleanup limit' using errcode = '22023'; end if;
  with expired as (
    select user_id from public.telegram_loan_pending_states
    where expires_at <= pg_catalog.now() order by expires_at, user_id limit p_limit for update skip locked
  )
  delete from public.telegram_loan_pending_states pending using expired
    where pending.user_id = expired.user_id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;
revoke all on function public.cleanup_expired_loan_pending(integer) from public, anon, authenticated;
grant execute on function public.cleanup_expired_loan_pending(integer) to service_role;

create or replace function public.ensure_telegram_loan_workspace(
  p_telegram_user_id text, p_display_name text, p_currency_code char(3)
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_workspace_id uuid;
  v_unlinked_at timestamptz;
  v_status text;
begin
  if p_telegram_user_id !~ '^[0-9]{1,20}$' or p_currency_code is null then
    raise exception 'Invalid Telegram identity' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_telegram_user_id, 7292));
  select ca.user_id, ca.unlinked_at, u.status into v_user_id, v_unlinked_at, v_status
    from public.channel_accounts ca join public.ofa_users u on u.id = ca.user_id
    where ca.channel = 'telegram' and ca.external_account_id = p_telegram_user_id;
  if v_user_id is null then
    insert into public.ofa_users (display_name, time_zone)
      values (nullif(trim(p_display_name), ''), 'Europe/Bratislava') returning id into v_user_id;
    insert into public.workspaces (name, workspace_type, base_currency_code, time_zone, created_by_user_id)
      values (coalesce(nullif(trim(p_display_name), ''), 'Môj finančný priestor'),
        'personal', p_currency_code, 'Europe/Bratislava', v_user_id)
      returning id into v_workspace_id;
    insert into public.workspace_members (workspace_id, user_id, role, status, joined_at)
      values (v_workspace_id, v_user_id, 'owner', 'active', now());
    insert into public.channel_accounts (user_id, channel, external_account_id)
      values (v_user_id, 'telegram', p_telegram_user_id);
    insert into public.auth_identities (user_id, provider, provider_subject, verified_at)
      values (v_user_id, 'telegram', p_telegram_user_id, now());
  else
    if v_unlinked_at is not null or v_status <> 'active'
      or exists (select 1 from public.ofa_users u where u.id = v_user_id and u.deleted_at is not null) then
      raise exception 'Telegram account is not active' using errcode = '42501';
    end if;
    select wm.workspace_id into v_workspace_id from public.workspace_members wm
      join public.workspaces w on w.id = wm.workspace_id and w.deleted_at is null
      where wm.user_id = v_user_id and wm.status = 'active' and wm.removed_at is null
      order by (wm.role = 'owner') desc, w.created_at asc limit 1;
    if v_workspace_id is null then raise exception 'Active workspace required' using errcode = '42501'; end if;
  end if;
  return v_workspace_id;
end;
$$;
revoke all on function public.ensure_telegram_loan_workspace(text,text,char(3)) from public, anon, authenticated;
grant execute on function public.ensure_telegram_loan_workspace(text,text,char(3)) to service_role;

create or replace function public.record_telegram_loan_movement(
  p_telegram_user_id text,
  p_chat_id text,
  p_message_id text,
  p_update_id text,
  p_name text,
  p_counterparty_id uuid,
  p_direction text,
  p_kind text,
  p_amount_minor bigint,
  p_currency_code char(3),
  p_due_on date default null,
  p_occurred_at timestamptz default now()
)
returns table (movement_id uuid, counterparty_name text, remaining_minor bigint, was_duplicate boolean)
language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_workspace_id uuid;
  v_account_id uuid;
  v_counterparty public.loan_counterparties%rowtype;
  v_conversation_id uuid;
  v_message_id uuid;
  v_transaction_id uuid;
  v_movement_id uuid;
  v_loan public.personal_loans%rowtype;
  v_available bigint;
  v_to_apply bigint;
  v_remaining bigint;
  v_total bigint;
  v_match_count integer;
begin
  if p_telegram_user_id is null or p_update_id !~ '^[0-9]{1,20}$'
    or p_message_id !~ '^[0-9]{1,20}$' or p_chat_id !~ '^[-0-9]{1,24}$'
    or p_amount_minor <= 0 or p_direction not in ('lent', 'borrowed')
    or p_kind not in ('principal', 'repayment') or p_currency_code is null then
    raise exception 'Invalid loan movement' using errcode = '22023';
  end if;
  select ca.user_id, ca.id into v_user_id, v_account_id
  from public.channel_accounts ca
  join public.ofa_users u on u.id = ca.user_id and u.status = 'active' and u.deleted_at is null
  where ca.channel = 'telegram' and ca.external_account_id = p_telegram_user_id
    and ca.unlinked_at is null;
  if v_user_id is null then raise exception 'Active Telegram account required' using errcode = '42501'; end if;
  select wm.workspace_id into v_workspace_id from public.workspace_members wm
  join public.workspaces w on w.id = wm.workspace_id and w.deleted_at is null
  where wm.user_id = v_user_id and wm.status = 'active' and wm.removed_at is null
  order by (wm.role = 'owner') desc, w.created_at asc limit 1;
  if v_workspace_id is null then raise exception 'Active workspace required' using errcode = '42501'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_workspace_id::text, 7291));
  select m.id, cp.name into v_movement_id, counterparty_name
  from public.loan_movements m join public.loan_counterparties cp on cp.id = m.counterparty_id
  where m.telegram_update_id = p_update_id and m.created_by_user_id = v_user_id;
  if found then
    movement_id := v_movement_id;
    select coalesce(sum(l.original_minor - l.repaid_minor), 0) into remaining_minor
      from public.personal_loans l where l.counterparty_id = (
        select m.counterparty_id from public.loan_movements m where m.id = v_movement_id
      ) and l.workspace_id = v_workspace_id
      and l.direction = p_direction and l.currency_code = p_currency_code and l.status = 'OPEN';
    was_duplicate := true;
    return next;
    return;
  end if;
  if p_counterparty_id is not null then
    select * into v_counterparty from public.loan_counterparties cp
      where cp.id = p_counterparty_id and cp.workspace_id = v_workspace_id;
    if not found then raise exception 'Counterparty not found' using errcode = '22023'; end if;
  else
    if p_kind <> 'principal' or length(trim(coalesce(p_name, ''))) not between 2 and 120 then
      raise exception 'Counterparty required' using errcode = '22023';
    end if;
    insert into public.loan_counterparties (workspace_id, name, created_by_user_id)
      values (v_workspace_id, trim(p_name), v_user_id)
      on conflict (workspace_id, name_key) do nothing;
    select * into v_counterparty from public.loan_counterparties cp
      where cp.workspace_id = v_workspace_id and cp.name_key = lower(trim(p_name));
  end if;
  if p_kind = 'repayment' then
    select count(*), coalesce(sum(l.original_minor - l.repaid_minor), 0)
      into v_match_count, v_total from public.personal_loans l
      where l.workspace_id = v_workspace_id and l.counterparty_id = v_counterparty.id
        and l.direction = p_direction and l.currency_code = p_currency_code and l.status = 'OPEN';
    if v_match_count = 0 then raise exception 'No open loan' using errcode = 'P0002'; end if;
    if p_amount_minor > v_total then raise exception 'Repayment exceeds open balance' using errcode = '22003'; end if;
  end if;
  insert into public.conversations (workspace_id, channel, external_conversation_id, conversation_type, last_message_at)
    values (v_workspace_id, 'telegram', p_chat_id, 'direct', p_occurred_at)
    on conflict (channel, external_conversation_id) do update set last_message_at = excluded.last_message_at
    returning id into v_conversation_id;
  insert into public.channel_messages (conversation_id, sender_channel_account_id, direction,
    external_message_id, idempotency_key, content_type, processing_status, received_at, processed_at)
    values (v_conversation_id, v_account_id, 'inbound', p_message_id,
      'telegram:update:' || p_update_id, 'text', 'completed', p_occurred_at, now())
    returning id into v_message_id;
  insert into public.financial_transactions (workspace_id, created_by_user_id, transaction_type,
    status, amount_minor, currency_code, occurred_at, time_zone, source, source_message_id, confirmed_at,
    metadata)
    values (v_workspace_id, v_user_id, 'transfer', 'confirmed', p_amount_minor,
      p_currency_code, p_occurred_at, 'Europe/Bratislava', 'message', v_message_id, now(),
      pg_catalog.jsonb_build_object('loan_direction', p_direction, 'loan_kind', p_kind))
    returning id into v_transaction_id;
  insert into public.loan_movements (workspace_id, counterparty_id, direction, kind, amount_minor,
    currency_code, transaction_id, telegram_update_id, created_by_user_id, occurred_at)
    values (v_workspace_id, v_counterparty.id, p_direction, p_kind, p_amount_minor,
      p_currency_code, v_transaction_id, p_update_id, v_user_id, p_occurred_at)
    returning id into v_movement_id;
  if p_kind = 'principal' then
    insert into public.personal_loans (workspace_id, counterparty_id, created_by_user_id,
      direction, original_minor, currency_code, due_on, opened_at)
      values (v_workspace_id, v_counterparty.id, v_user_id, p_direction,
        p_amount_minor, p_currency_code, p_due_on, p_occurred_at)
      returning * into v_loan;
    insert into public.loan_allocations (movement_id, loan_id, workspace_id, amount_minor)
      values (v_movement_id, v_loan.id, v_workspace_id, p_amount_minor);
  else
    v_remaining := p_amount_minor;
    for v_loan in select * from public.personal_loans l
      where l.workspace_id = v_workspace_id and l.counterparty_id = v_counterparty.id
        and l.direction = p_direction and l.currency_code = p_currency_code and l.status = 'OPEN'
      order by l.opened_at, l.id for update
    loop
      exit when v_remaining = 0;
      v_available := v_loan.original_minor - v_loan.repaid_minor;
      v_to_apply := least(v_remaining, v_available);
      update public.personal_loans l set repaid_minor = repaid_minor + v_to_apply,
        status = case when repaid_minor + v_to_apply = original_minor then 'SETTLED' else 'OPEN' end
        where l.id = v_loan.id;
      insert into public.loan_allocations (movement_id, loan_id, workspace_id, amount_minor)
        values (v_movement_id, v_loan.id, v_workspace_id, v_to_apply);
      v_remaining := v_remaining - v_to_apply;
    end loop;
  end if;
  insert into public.transaction_events (transaction_id, event_type, actor_user_id, after_state)
    values (v_transaction_id, 'created', v_user_id,
      pg_catalog.jsonb_build_object('loan_movement_id', v_movement_id, 'amount_minor', p_amount_minor));
  insert into public.audit_events (workspace_id, actor_user_id, actor_type, action, entity_type,
    entity_id, after_data)
    values (v_workspace_id, v_user_id, 'user', 'loan.movement_recorded', 'loan_movement',
      v_movement_id, pg_catalog.jsonb_build_object('kind', p_kind, 'direction', p_direction,
        'amount_minor', p_amount_minor, 'currency_code', p_currency_code));
  movement_id := v_movement_id;
  counterparty_name := v_counterparty.name;
  select coalesce(sum(l.original_minor - l.repaid_minor), 0) into remaining_minor
    from public.personal_loans l where l.workspace_id = v_workspace_id
      and l.counterparty_id = v_counterparty.id and l.direction = p_direction
      and l.currency_code = p_currency_code and l.status = 'OPEN';
  was_duplicate := false;
  return next;
end;
$$;
revoke all on function public.record_telegram_loan_movement(text,text,text,text,text,uuid,text,text,bigint,char(3),date,timestamptz) from public, anon, authenticated;
grant execute on function public.record_telegram_loan_movement(text,text,text,text,text,uuid,text,text,bigint,char(3),date,timestamptz) to service_role;

create or replace function public.void_last_telegram_loan_movement(p_telegram_user_id text, p_movement_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  v_user_id uuid;
  v_workspace_id uuid;
  v_movement public.loan_movements%rowtype;
  v_allocation record;
begin
  select ca.user_id into v_user_id from public.channel_accounts ca
    join public.ofa_users u on u.id = ca.user_id and u.status = 'active' and u.deleted_at is null
    where ca.channel = 'telegram' and ca.external_account_id = p_telegram_user_id and ca.unlinked_at is null;
  if v_user_id is null then return false; end if;
  select wm.workspace_id into v_workspace_id from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id and w.deleted_at is null
    where wm.user_id = v_user_id and wm.status = 'active' and wm.removed_at is null
    order by (wm.role = 'owner') desc, w.created_at asc limit 1;
  if v_workspace_id is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_workspace_id::text, 7291));
  select * into v_movement from public.loan_movements m
    where m.workspace_id = v_workspace_id and m.created_by_user_id = v_user_id and m.voided_at is null
    order by m.created_at desc, m.id desc limit 1 for update;
  if not found or v_movement.id <> p_movement_id then return false; end if;
  if v_movement.transaction_id <> (
    select ft.id from public.financial_transactions ft
    where ft.created_by_user_id = v_user_id and ft.status = 'confirmed' and ft.deleted_at is null
    order by ft.created_at desc, ft.id desc limit 1
  ) then return false; end if;
  if v_movement.kind = 'principal' and exists (
    select 1 from public.loan_allocations a join public.personal_loans l on l.id = a.loan_id
    where a.movement_id = v_movement.id and l.repaid_minor > 0
  ) then return false; end if;
  for v_allocation in select a.loan_id, a.amount_minor from public.loan_allocations a
    where a.movement_id = v_movement.id loop
    if v_movement.kind = 'principal' then
      update public.personal_loans l set status = 'VOIDED' where l.id = v_allocation.loan_id;
    else
      update public.personal_loans l set repaid_minor = repaid_minor - v_allocation.amount_minor,
        status = 'OPEN' where l.id = v_allocation.loan_id;
    end if;
  end loop;
  update public.loan_movements m set voided_at = now() where m.id = v_movement.id;
  perform pg_catalog.set_config('ofa.loan_void', 'on', true);
  update public.financial_transactions ft set status = 'voided', voided_at = now(), version = version + 1
    where ft.id = v_movement.transaction_id and ft.workspace_id = v_workspace_id;
  perform pg_catalog.set_config('ofa.loan_void', 'off', true);
  insert into public.transaction_events (transaction_id, event_type, actor_user_id, after_state)
    values (v_movement.transaction_id, 'voided', v_user_id, pg_catalog.jsonb_build_object('loan_movement_id', v_movement.id));
  insert into public.audit_events (workspace_id, actor_user_id, actor_type, action, entity_type, entity_id)
    values (v_workspace_id, v_user_id, 'user', 'loan.movement_voided', 'loan_movement', v_movement.id);
  return true;
end;
$$;
revoke all on function public.void_last_telegram_loan_movement(text,uuid) from public, anon, authenticated;
grant execute on function public.void_last_telegram_loan_movement(text,uuid) to service_role;
