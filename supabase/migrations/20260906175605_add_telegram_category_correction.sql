-- Category-only correction for the last Telegram transaction. The functions
-- are backend-only and preserve immutable assignment/event/audit history.

create or replace function public.get_telegram_category_correction_categories(
  p_telegram_user_id text,
  p_transaction_id uuid
)
returns table (
  category_id uuid,
  name text,
  slug varchar(96),
  icon varchar(32)
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_transaction public.financial_transactions%rowtype;
begin
  select ca.user_id into v_user_id
  from public.channel_accounts ca
  where ca.channel = 'telegram'
    and ca.external_account_id = p_telegram_user_id
    and ca.unlinked_at is null
  limit 1;

  if v_user_id is null then return; end if;

  select ft.* into v_transaction
  from public.financial_transactions ft
  where ft.created_by_user_id = v_user_id
    and ft.status = 'confirmed'
    and ft.deleted_at is null
  order by ft.created_at desc, ft.id desc
  limit 1;

  if not found or v_transaction.id <> p_transaction_id then return; end if;

  return query
  select c.id, c.name, c.slug, c.icon
  from public.categories c
  where c.is_active
    and not c.is_archived
    and c.transaction_type = v_transaction.transaction_type
    and (c.workspace_id is null or c.workspace_id = v_transaction.workspace_id)
  order by (c.workspace_id is null), c.name;
end;
$$;

create or replace function public.correct_last_telegram_transaction_category(
  p_telegram_user_id text,
  p_expected_transaction_id uuid,
  p_category_id uuid
)
returns table (
  transaction_id uuid,
  amount_minor bigint,
  currency_code char(3),
  category_name text,
  previous_category_name text,
  note text,
  was_changed boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_transaction public.financial_transactions%rowtype;
  v_category public.categories%rowtype;
  v_previous_category_id uuid;
  v_previous_category_name text;
  v_now timestamptz := now();
begin
  select ca.user_id into v_user_id
  from public.channel_accounts ca
  where ca.channel = 'telegram'
    and ca.external_account_id = p_telegram_user_id
    and ca.unlinked_at is null
  limit 1;

  if v_user_id is null then return; end if;

  -- Lock and verify the same current transaction that was shown in the picker.
  select ft.* into v_transaction
  from public.financial_transactions ft
  where ft.created_by_user_id = v_user_id
    and ft.status = 'confirmed'
    and ft.deleted_at is null
  order by ft.created_at desc, ft.id desc
  limit 1
  for update;

  if not found or v_transaction.id <> p_expected_transaction_id then return; end if;

  select c.* into v_category
  from public.categories c
  where c.id = p_category_id
    and c.is_active
    and not c.is_archived
    and c.transaction_type = v_transaction.transaction_type
    and (c.workspace_id is null or c.workspace_id = v_transaction.workspace_id)
  limit 1;

  if not found then
    raise exception 'Unknown active category for transaction' using errcode = '22023';
  end if;

  select tca.category_id, c.name into v_previous_category_id, v_previous_category_name
  from public.transaction_category_assignments tca
  join public.categories c on c.id = tca.category_id
  where tca.transaction_id = v_transaction.id
    and tca.valid_to is null
  limit 1;

  if v_previous_category_id = v_category.id then
    return query select v_transaction.id, v_transaction.amount_minor, v_transaction.currency_code,
      v_category.name, v_previous_category_name, v_transaction.note, false;
    return;
  end if;

  update public.transaction_category_assignments tca
  set valid_to = v_now
  where tca.transaction_id = v_transaction.id
    and tca.valid_to is null;

  insert into public.transaction_category_assignments (
    transaction_id, category_id, source, confidence, reason, assigned_by_user_id, valid_from
  ) values (
    v_transaction.id, v_category.id, 'user', 1,
    'Kategória opravená používateľom cez Telegram', v_user_id, v_now
  );

  insert into public.transaction_events (
    transaction_id, event_type, actor_user_id, before_state, after_state, reason
  ) values (
    v_transaction.id, 'corrected', v_user_id,
    jsonb_build_object('category_id', v_previous_category_id, 'category_name', v_previous_category_name),
    jsonb_build_object('category_id', v_category.id, 'category_name', v_category.name),
    'Kategória opravená používateľom cez Telegram'
  );

  insert into public.audit_events (
    workspace_id, actor_user_id, actor_type, action, entity_type, entity_id,
    before_data, after_data, metadata
  ) values (
    v_transaction.workspace_id, v_user_id, 'user', 'transaction.category_corrected_from_telegram',
    'financial_transaction', v_transaction.id,
    jsonb_build_object('category_id', v_previous_category_id, 'category_name', v_previous_category_name),
    jsonb_build_object('category_id', v_category.id, 'category_name', v_category.name),
    jsonb_build_object('channel', 'telegram')
  );

  return query select v_transaction.id, v_transaction.amount_minor, v_transaction.currency_code,
    v_category.name, v_previous_category_name, v_transaction.note, true;
end;
$$;

revoke all on function public.get_telegram_category_correction_categories(text, uuid) from public, anon, authenticated;
revoke all on function public.correct_last_telegram_transaction_category(text, uuid, uuid) from public, anon, authenticated;
grant execute on function public.get_telegram_category_correction_categories(text, uuid) to service_role;
grant execute on function public.correct_last_telegram_transaction_category(text, uuid, uuid) to service_role;
