-- Safe Telegram controls for correcting or voiding a user's own transaction.
-- These functions are backend-only; the service role is the sole caller.

create or replace function public.get_last_telegram_transaction(
  p_telegram_user_id text
)
returns table (
  transaction_id uuid,
  transaction_type public.ofa_transaction_type,
  amount_minor bigint,
  currency_code char(3),
  category_name text,
  note text,
  occurred_at timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    ft.id,
    ft.transaction_type,
    ft.amount_minor,
    ft.currency_code,
    c.name,
    ft.note,
    ft.occurred_at
  from public.financial_transactions ft
  join public.channel_accounts ca
    on ca.user_id = ft.created_by_user_id
   and ca.channel = 'telegram'
   and ca.external_account_id = p_telegram_user_id
   and ca.unlinked_at is null
  left join public.transaction_category_assignments tca
    on tca.transaction_id = ft.id
   and tca.valid_to is null
  left join public.categories c on c.id = tca.category_id
  where ft.status = 'confirmed'
    and ft.deleted_at is null
  order by ft.created_at desc, ft.id desc
  limit 1;
$$;

create or replace function public.void_telegram_transaction(
  p_telegram_user_id text,
  p_transaction_id uuid,
  p_reason text default 'Zrušené používateľom cez Telegram'
)
returns table (
  transaction_id uuid,
  amount_minor bigint,
  currency_code char(3),
  note text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_transaction public.financial_transactions%rowtype;
  v_user_id uuid;
begin
  select ca.user_id into v_user_id
  from public.channel_accounts ca
  where ca.channel = 'telegram'
    and ca.external_account_id = p_telegram_user_id
    and ca.unlinked_at is null
  limit 1;

  if v_user_id is null then
    return;
  end if;

  select ft.* into v_transaction
  from public.financial_transactions ft
  where ft.id = p_transaction_id
    and ft.created_by_user_id = v_user_id
    and ft.status = 'confirmed'
    and ft.deleted_at is null
  for update;

  if not found then
    return;
  end if;

  update public.financial_transactions ft
  set status = 'voided',
      voided_at = now(),
      version = ft.version + 1
  where ft.id = v_transaction.id;

  insert into public.transaction_events (
    transaction_id, event_type, actor_user_id, before_state, after_state, reason
  ) values (
    v_transaction.id,
    'voided',
    v_user_id,
    jsonb_build_object(
      'transaction_type', v_transaction.transaction_type,
      'amount_minor', v_transaction.amount_minor,
      'currency_code', v_transaction.currency_code,
      'note', v_transaction.note,
      'status', v_transaction.status,
      'version', v_transaction.version
    ),
    jsonb_build_object('status', 'voided', 'version', v_transaction.version + 1),
    nullif(trim(p_reason), '')
  );

  return query select v_transaction.id, v_transaction.amount_minor, v_transaction.currency_code, v_transaction.note;
end;
$$;

create or replace function public.correct_last_telegram_transaction(
  p_telegram_user_id text,
  p_amount_minor bigint,
  p_currency_code char(3),
  p_transaction_type public.ofa_transaction_type,
  p_category_slug varchar(96),
  p_note text
)
returns table (
  transaction_id uuid,
  amount_minor bigint,
  currency_code char(3),
  category_name text,
  note text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_transaction public.financial_transactions%rowtype;
  v_user_id uuid;
  v_category_id uuid;
  v_category_name text;
  v_now timestamptz := now();
begin
  if p_amount_minor is null or p_amount_minor <= 0 then
    raise exception 'Amount must be positive' using errcode = '22023';
  end if;

  select ca.user_id into v_user_id
  from public.channel_accounts ca
  where ca.channel = 'telegram'
    and ca.external_account_id = p_telegram_user_id
    and ca.unlinked_at is null
  limit 1;

  if v_user_id is null then
    return;
  end if;

  select ft.* into v_transaction
  from public.financial_transactions ft
  where ft.created_by_user_id = v_user_id
    and ft.status = 'confirmed'
    and ft.deleted_at is null
  order by ft.created_at desc, ft.id desc
  limit 1
  for update;

  if not found then
    return;
  end if;

  select c.id, c.name into v_category_id, v_category_name
  from public.categories c
  where c.workspace_id is null
    and c.slug = p_category_slug
    and c.transaction_type = p_transaction_type
    and c.is_active
  limit 1;

  if v_category_id is null then
    raise exception 'Unknown active category: %', p_category_slug using errcode = '22023';
  end if;

  update public.financial_transactions ft
  set transaction_type = p_transaction_type,
      amount_minor = p_amount_minor,
      currency_code = p_currency_code,
      note = nullif(trim(p_note), ''),
      version = ft.version + 1
  where ft.id = v_transaction.id;

  update public.transaction_category_assignments tca
  set valid_to = v_now
  where tca.transaction_id = v_transaction.id
    and tca.valid_to is null;

  insert into public.transaction_category_assignments (
    transaction_id, category_id, source, confidence, reason, assigned_by_user_id, valid_from
  ) values (
    v_transaction.id, v_category_id, 'user', 1, 'Opravené používateľom cez Telegram', v_user_id, v_now
  );

  insert into public.transaction_events (
    transaction_id, event_type, actor_user_id, before_state, after_state, reason
  ) values (
    v_transaction.id,
    'corrected',
    v_user_id,
    jsonb_build_object(
      'transaction_type', v_transaction.transaction_type,
      'amount_minor', v_transaction.amount_minor,
      'currency_code', v_transaction.currency_code,
      'note', v_transaction.note,
      'version', v_transaction.version
    ),
    jsonb_build_object(
      'transaction_type', p_transaction_type,
      'amount_minor', p_amount_minor,
      'currency_code', p_currency_code,
      'note', nullif(trim(p_note), ''),
      'category_slug', p_category_slug,
      'version', v_transaction.version + 1
    ),
    'Opravené používateľom cez Telegram'
  );

  return query select v_transaction.id, p_amount_minor, p_currency_code, v_category_name, nullif(trim(p_note), '');
end;
$$;

revoke all on function public.get_last_telegram_transaction(text) from public, anon, authenticated;
revoke all on function public.void_telegram_transaction(text, uuid, text) from public, anon, authenticated;
revoke all on function public.correct_last_telegram_transaction(text, bigint, char(3), public.ofa_transaction_type, varchar, text) from public, anon, authenticated;

grant execute on function public.get_last_telegram_transaction(text) to service_role;
grant execute on function public.void_telegram_transaction(text, uuid, text) to service_role;
grant execute on function public.correct_last_telegram_transaction(text, bigint, char(3), public.ofa_transaction_type, varchar, text) to service_role;
