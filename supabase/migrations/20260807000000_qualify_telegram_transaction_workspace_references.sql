-- The function's TABLE return declaration exposes a `workspace_id` PL/pgSQL
-- variable.  Always qualify table columns in its query expressions so the
-- database cannot confuse that output variable with a table column.
create or replace function public.record_telegram_transaction(
  p_telegram_user_id text,
  p_display_name text,
  p_chat_id text,
  p_message_id text,
  p_update_id text,
  p_message_text text,
  p_amount_minor bigint,
  p_currency_code char(3),
  p_transaction_type public.ofa_transaction_type,
  p_category_slug varchar(96),
  p_note text,
  p_occurred_at timestamptz default now(),
  p_time_zone varchar(64) default 'Europe/Bratislava'
)
returns table (transaction_id uuid, workspace_id uuid, was_duplicate boolean)
language plpgsql
security definer
set search_path = pg_catalog, extensions
as $$
declare
  v_user_id uuid;
  v_workspace_id uuid;
  v_account_id uuid;
  v_conversation_id uuid;
  v_message_id uuid;
  v_transaction_id uuid;
  v_category_id uuid;
  v_idempotency_key varchar(255) := 'telegram:update:' || p_update_id;
begin
  if p_amount_minor < 0 then
    raise exception 'p_amount_minor must be non-negative';
  end if;

  select ft.id, ft.workspace_id into v_transaction_id, v_workspace_id
  from public.channel_messages cm
  join public.financial_transactions ft on ft.source_message_id = cm.id
  where cm.idempotency_key = v_idempotency_key;
  if found then
    return query select v_transaction_id, v_workspace_id, true;
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
    values (coalesce(nullif(p_display_name, ''), 'Môj finančný priestor'), 'personal', p_currency_code, p_time_zone, v_user_id)
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
  ) returning id into v_message_id;

  select c.id into v_category_id
  from public.categories c
  where c.workspace_id is null
    and c.slug = p_category_slug
    and c.is_active
    and not c.is_archived
  limit 1;
  if v_category_id is null then
    raise exception 'Unknown system category slug: %', p_category_slug;
  end if;

  insert into public.financial_transactions (
    workspace_id, created_by_user_id, transaction_type, status, amount_minor,
    currency_code, occurred_at, time_zone, merchant_name, note, source,
    source_message_id, confirmed_at
  ) values (
    v_workspace_id, v_user_id, p_transaction_type, 'confirmed', p_amount_minor,
    p_currency_code, p_occurred_at, p_time_zone, null, nullif(p_note, ''), 'message',
    v_message_id, now()
  ) returning id into v_transaction_id;

  insert into public.transaction_category_assignments (
    transaction_id, category_id, source, confidence, reason, assigned_by_user_id
  ) values (
    v_transaction_id, v_category_id, 'rule', 1, 'Telegram MVP deterministic parser', v_user_id
  );

  insert into public.transaction_events (transaction_id, event_type, actor_user_id, after_state)
  values (
    v_transaction_id, 'created', v_user_id,
    jsonb_build_object('amount_minor', p_amount_minor, 'currency_code', p_currency_code, 'source', 'message')
  );

  insert into public.audit_events (workspace_id, actor_user_id, actor_type, action, entity_type, entity_id)
  values (v_workspace_id, v_user_id, 'user', 'transaction.created_from_telegram', 'financial_transaction', v_transaction_id);

  return query select v_transaction_id, v_workspace_id, false;
end;
$$;

revoke all on function public.record_telegram_transaction(text, text, text, text, text, text, bigint, char(3), public.ofa_transaction_type, varchar, text, timestamptz, varchar) from public, anon, authenticated;
grant execute on function public.record_telegram_transaction(text, text, text, text, text, text, bigint, char(3), public.ofa_transaction_type, varchar, text, timestamptz, varchar) to service_role;
