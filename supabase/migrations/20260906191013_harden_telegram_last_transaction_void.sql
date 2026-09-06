-- Void only the current last confirmed Telegram transaction. This preserves
-- the transaction and writes immutable event + audit records; it never deletes.

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
  v_now timestamptz := now();
begin
  select ca.user_id into v_user_id
  from public.channel_accounts ca
  where ca.channel = 'telegram'
    and ca.external_account_id = p_telegram_user_id
    and ca.unlinked_at is null
  limit 1;

  if v_user_id is null then return; end if;

  -- Lock exactly one record: the user's current last confirmed transaction.
  select ft.* into v_transaction
  from public.financial_transactions ft
  where ft.created_by_user_id = v_user_id
    and ft.status = 'confirmed'
    and ft.deleted_at is null
  order by ft.created_at desc, ft.id desc
  limit 1
  for update;

  -- An old/replayed button cannot void an earlier transaction.
  if not found or v_transaction.id <> p_transaction_id then return; end if;

  update public.financial_transactions ft
  set status = 'voided',
      voided_at = v_now,
      version = ft.version + 1
  where ft.id = v_transaction.id;

  insert into public.transaction_events (
    transaction_id, event_type, actor_user_id, before_state, after_state, reason
  ) values (
    v_transaction.id, 'voided', v_user_id,
    jsonb_build_object(
      'transaction_type', v_transaction.transaction_type,
      'amount_minor', v_transaction.amount_minor,
      'currency_code', v_transaction.currency_code,
      'merchant_name', v_transaction.merchant_name,
      'note', v_transaction.note,
      'status', v_transaction.status,
      'version', v_transaction.version
    ),
    jsonb_build_object('status', 'voided', 'voided_at', v_now, 'version', v_transaction.version + 1),
    nullif(trim(p_reason), '')
  );

  insert into public.audit_events (
    workspace_id, actor_user_id, actor_type, action, entity_type, entity_id,
    before_data, after_data, metadata
  ) values (
    v_transaction.workspace_id, v_user_id, 'user', 'transaction.voided_from_telegram',
    'financial_transaction', v_transaction.id,
    jsonb_build_object(
      'transaction_type', v_transaction.transaction_type,
      'amount_minor', v_transaction.amount_minor,
      'currency_code', v_transaction.currency_code,
      'merchant_name', v_transaction.merchant_name,
      'note', v_transaction.note,
      'status', v_transaction.status,
      'version', v_transaction.version
    ),
    jsonb_build_object('status', 'voided', 'voided_at', v_now, 'version', v_transaction.version + 1),
    jsonb_build_object('channel', 'telegram')
  );

  return query select v_transaction.id, v_transaction.amount_minor, v_transaction.currency_code, v_transaction.note;
end;
$$;

revoke all on function public.void_telegram_transaction(text, uuid, text) from public, anon, authenticated;
grant execute on function public.void_telegram_transaction(text, uuid, text) to service_role;
