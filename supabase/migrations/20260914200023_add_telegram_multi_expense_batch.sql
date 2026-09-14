-- Atomic multi-expense entries from one Telegram message. Existing transactions
-- are never changed; the new RPC links all created rows to one channel message.

create or replace function public.record_telegram_transaction_batch(
  p_telegram_user_id text,
  p_display_name text,
  p_chat_id text,
  p_message_id text,
  p_update_id text,
  p_message_text text,
  p_items jsonb,
  p_occurred_at timestamptz default now(),
  p_time_zone varchar(64) default 'Europe/Bratislava'
)
returns table (transaction_id uuid, workspace_id uuid, item_index integer, was_duplicate boolean)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user_id uuid;
  v_workspace_id uuid;
  v_account_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
  v_transaction_id uuid;
  v_category_id uuid;
  v_item jsonb;
  v_item_index integer := -1;
  v_amount_minor bigint;
  v_currency_code char(3);
  v_transaction_type public.ofa_transaction_type;
  v_category_slug varchar(96);
  v_category_source public.classification_source;
  v_category_confidence numeric(5,4);
  v_category_reason text;
  v_note text;
  v_workspace_currency char(3);
  v_idempotency_key varchar(255) := 'telegram:update:' || p_update_id;
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 2 or jsonb_array_length(p_items) > 10 then
    raise exception 'p_items must contain between 2 and 10 items' using errcode = '22023';
  end if;
  v_workspace_currency := upper(trim(p_items -> 0 ->> 'currency_code'))::char(3);

  -- A completed earlier attempt is returned exactly as it was created. Because
  -- this function is atomic, a retry can never see a partially saved batch.
  select cm.id, ft.workspace_id into v_message_id, v_workspace_id
  from public.channel_messages cm
  join public.financial_transactions ft on ft.source_message_id = cm.id
  where cm.idempotency_key = v_idempotency_key
  limit 1;
  if found then
    return query
    select ft.id, ft.workspace_id,
      coalesce((ft.metadata ->> 'telegram_batch_item_index')::integer, 0), true
    from public.financial_transactions ft
    where ft.source_message_id = v_message_id
      and ft.external_reference like v_idempotency_key || ':item:%'
    order by coalesce((ft.metadata ->> 'telegram_batch_item_index')::integer, 0);
    return;
  end if;

  select ca.user_id, ca.id into v_user_id, v_account_id
  from public.channel_accounts ca
  where ca.channel = 'telegram'
    and ca.external_account_id = p_telegram_user_id
    and ca.unlinked_at is null;

  if not found then
    insert into public.ofa_users (display_name, time_zone)
    values (nullif(p_display_name, ''), p_time_zone)
    returning id into v_user_id;

    insert into public.workspaces (name, workspace_type, base_currency_code, time_zone, created_by_user_id)
    values (coalesce(nullif(p_display_name, ''), 'Môj finančný priestor'), 'personal', v_workspace_currency, p_time_zone, v_user_id)
    returning id into v_workspace_id;

    insert into public.workspace_members (workspace_id, user_id, role, status, joined_at)
    values (v_workspace_id, v_user_id, 'owner', 'active', now());

    insert into public.channel_accounts (user_id, channel, external_account_id, external_username)
    values (v_user_id, 'telegram', p_telegram_user_id, nullif(p_display_name, ''))
    returning id into v_account_id;

    insert into public.auth_identities (user_id, provider, provider_subject, verified_at)
    values (v_user_id, 'telegram', p_telegram_user_id, now());
  else
    select wm.workspace_id into v_workspace_id
    from public.workspace_members wm
    join public.workspaces w on w.id = wm.workspace_id
    where wm.user_id = v_user_id
      and wm.status = 'active'
      and w.deleted_at is null
    order by (wm.role = 'owner') desc, w.created_at asc
    limit 1;

    if v_workspace_id is null then
      raise exception 'No active workspace for Telegram user %', p_telegram_user_id;
    end if;
  end if;

  insert into public.conversations (workspace_id, channel, external_conversation_id, conversation_type, last_message_at)
  values (v_workspace_id, 'telegram', p_chat_id, 'direct', p_occurred_at)
  on conflict (channel, external_conversation_id) do update
    set last_message_at = excluded.last_message_at
  returning id into v_conversation_id;

  insert into public.channel_messages (
    conversation_id, sender_channel_account_id, direction, external_message_id,
    idempotency_key, content_type, content_hash, processing_status, received_at, processed_at
  ) values (
    v_conversation_id, v_account_id, 'inbound', p_message_id,
    v_idempotency_key, 'text', extensions.digest(p_message_text, 'sha256'), 'completed', p_occurred_at, now()
  ) on conflict (idempotency_key) do nothing
  returning id into v_message_id;

  -- Concurrent Telegram deliveries wait for the first transaction and then
  -- return its rows instead of creating a second set of transactions.
  if v_message_id is null then
    select cm.id into v_message_id
    from public.channel_messages cm
    where cm.idempotency_key = v_idempotency_key;
    return query
    select ft.id, ft.workspace_id,
      coalesce((ft.metadata ->> 'telegram_batch_item_index')::integer, 0), true
    from public.financial_transactions ft
    where ft.source_message_id = v_message_id
      and ft.external_reference like v_idempotency_key || ':item:%'
    order by coalesce((ft.metadata ->> 'telegram_batch_item_index')::integer, 0);
    return;
  end if;

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_item_index := v_item_index + 1;
    if jsonb_typeof(v_item) <> 'object'
      or not (v_item ? 'amount_minor')
      or not (v_item ? 'currency_code')
      or not (v_item ? 'transaction_type')
      or not (v_item ? 'category_slug')
      or not (v_item ? 'note') then
      raise exception 'Invalid batch item at index %', v_item_index using errcode = '22023';
    end if;

    v_amount_minor := (v_item ->> 'amount_minor')::bigint;
    v_currency_code := upper(trim(v_item ->> 'currency_code'))::char(3);
    v_transaction_type := (v_item ->> 'transaction_type')::public.ofa_transaction_type;
    v_category_slug := nullif(trim(v_item ->> 'category_slug'), '');
    v_category_source := coalesce(nullif(trim(v_item ->> 'category_source'), ''), 'system')::public.classification_source;
    v_category_confidence := nullif(v_item ->> 'category_confidence', '')::numeric(5,4);
    v_category_reason := nullif(trim(v_item ->> 'category_reason'), '');
    v_note := nullif(trim(v_item ->> 'note'), '');

    if v_amount_minor <= 0 or v_note is null or v_category_slug is null then
      raise exception 'Invalid amount, description, or category at batch item %', v_item_index using errcode = '22023';
    end if;
    if v_transaction_type not in ('income', 'expense') then
      raise exception 'Unsupported transaction type at batch item %', v_item_index using errcode = '22023';
    end if;
    if v_category_source not in ('rule', 'ai', 'system') then
      raise exception 'Unsupported category source at batch item %', v_item_index using errcode = '22023';
    end if;

    select c.id into v_category_id
    from public.categories c
    where c.workspace_id is null
      and c.slug = v_category_slug
      and c.transaction_type = v_transaction_type
      and c.is_active
      and not c.is_archived
    limit 1;
    if v_category_id is null then
      raise exception 'Unknown active category slug at batch item %', v_item_index using errcode = '22023';
    end if;

    insert into public.financial_transactions (
      workspace_id, created_by_user_id, transaction_type, status, amount_minor,
      currency_code, occurred_at, time_zone, merchant_name, note, source,
      source_message_id, external_reference, metadata, confirmed_at
    ) values (
      v_workspace_id, v_user_id, v_transaction_type, 'confirmed', v_amount_minor,
      v_currency_code, p_occurred_at, p_time_zone, null, v_note, 'message',
      v_message_id, v_idempotency_key || ':item:' || v_item_index,
      jsonb_build_object('telegram_batch_item_index', v_item_index, 'telegram_batch_item_count', jsonb_array_length(p_items)), now()
    ) returning id into v_transaction_id;

    insert into public.transaction_category_assignments (
      transaction_id, category_id, source, confidence, reason, assigned_by_user_id
    ) values (
      v_transaction_id, v_category_id, v_category_source, v_category_confidence, v_category_reason, v_user_id
    );

    insert into public.transaction_events (transaction_id, event_type, actor_user_id, after_state)
    values (
      v_transaction_id, 'created', v_user_id,
      jsonb_build_object('amount_minor', v_amount_minor, 'currency_code', v_currency_code, 'source', 'message', 'batch_item_index', v_item_index)
    );

    insert into public.audit_events (workspace_id, actor_user_id, actor_type, action, entity_type, entity_id, metadata)
    values (
      v_workspace_id, v_user_id, 'user', 'transaction.created_from_telegram_batch', 'financial_transaction', v_transaction_id,
      jsonb_build_object('telegram_update_id', p_update_id, 'batch_item_index', v_item_index)
    );

    return query select v_transaction_id, v_workspace_id, v_item_index, false;
  end loop;
end;
$$;

revoke all on function public.record_telegram_transaction_batch(text, text, text, text, text, text, jsonb, timestamptz, varchar) from public, anon, authenticated;
grant execute on function public.record_telegram_transaction_batch(text, text, text, text, text, text, jsonb, timestamptz, varchar) to service_role;

-- Returns only the user's newest multi-expense message. It is intentionally
-- limited to the latest batch, never a historical free-text search.
create or replace function public.get_telegram_last_batch_transactions(
  p_telegram_user_id text
)
returns table (
  transaction_id uuid,
  amount_minor bigint,
  currency_code char(3),
  note text,
  merchant_name text
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with resolved_user as (
    select ca.user_id
    from public.channel_accounts ca
    where ca.channel = 'telegram'
      and ca.external_account_id = p_telegram_user_id
      and ca.unlinked_at is null
    limit 1
  ), latest_batch as (
    select ft.source_message_id
    from public.financial_transactions ft
    join resolved_user cu on cu.user_id = ft.created_by_user_id
    where ft.status = 'confirmed'
      and ft.deleted_at is null
      and ft.source_message_id is not null
      and ft.metadata ? 'telegram_batch_item_index'
    order by ft.created_at desc, ft.id desc
    limit 1
  )
  select ft.id, ft.amount_minor, ft.currency_code, ft.note, ft.merchant_name
  from public.financial_transactions ft
  join latest_batch lb on lb.source_message_id = ft.source_message_id
  where ft.status = 'confirmed'
    and ft.deleted_at is null
  order by coalesce((ft.metadata ->> 'telegram_batch_item_index')::integer, 0);
$$;

revoke all on function public.get_telegram_last_batch_transactions(text) from public, anon, authenticated;
grant execute on function public.get_telegram_last_batch_transactions(text) to service_role;

-- Existing category picker and audit flow remain intact. The allowed target is
-- widened from only the latest transaction to any member of the latest batch.
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
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user_id uuid;
  v_transaction public.financial_transactions%rowtype;
  v_latest_transaction_id uuid;
  v_latest_batch_message_id uuid;
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
  where ft.id = p_transaction_id
    and ft.created_by_user_id = v_user_id
    and ft.status = 'confirmed'
    and ft.deleted_at is null;
  if not found then return; end if;

  select ft.id into v_latest_transaction_id
  from public.financial_transactions ft
  where ft.created_by_user_id = v_user_id
    and ft.status = 'confirmed'
    and ft.deleted_at is null
  order by ft.created_at desc, ft.id desc
  limit 1;

  if v_transaction.id <> v_latest_transaction_id then
    select ft.source_message_id into v_latest_batch_message_id
    from public.financial_transactions ft
    where ft.created_by_user_id = v_user_id
      and ft.status = 'confirmed'
      and ft.deleted_at is null
      and ft.source_message_id is not null
      and ft.metadata ? 'telegram_batch_item_index'
    order by ft.created_at desc, ft.id desc
    limit 1;
    if v_latest_batch_message_id is null or v_transaction.source_message_id is distinct from v_latest_batch_message_id then
      return;
    end if;
  end if;

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
set search_path = pg_catalog, pg_temp
as $$
declare
  v_user_id uuid;
  v_transaction public.financial_transactions%rowtype;
  v_category public.categories%rowtype;
  v_previous_category_id uuid;
  v_previous_category_name text;
  v_latest_transaction_id uuid;
  v_latest_batch_message_id uuid;
  v_now timestamptz := now();
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
  where ft.id = p_expected_transaction_id
    and ft.created_by_user_id = v_user_id
    and ft.status = 'confirmed'
    and ft.deleted_at is null
  for update;
  if not found then return; end if;

  select ft.id into v_latest_transaction_id
  from public.financial_transactions ft
  where ft.created_by_user_id = v_user_id
    and ft.status = 'confirmed'
    and ft.deleted_at is null
  order by ft.created_at desc, ft.id desc
  limit 1;
  if v_transaction.id <> v_latest_transaction_id then
    select ft.source_message_id into v_latest_batch_message_id
    from public.financial_transactions ft
    where ft.created_by_user_id = v_user_id
      and ft.status = 'confirmed'
      and ft.deleted_at is null
      and ft.source_message_id is not null
      and ft.metadata ? 'telegram_batch_item_index'
    order by ft.created_at desc, ft.id desc
    limit 1;
    if v_latest_batch_message_id is null or v_transaction.source_message_id is distinct from v_latest_batch_message_id then
      return;
    end if;
  end if;

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
