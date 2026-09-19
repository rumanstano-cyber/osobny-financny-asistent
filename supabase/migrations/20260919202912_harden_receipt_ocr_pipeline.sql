-- Atomically finalizes receipt metadata after the private Storage object has
-- been moved to its deterministic workspace-scoped key. Retrying the same
-- Telegram update returns the already linked receipt instead of duplicating
-- receipt, OCR, line-item, or audit rows.
create or replace function public.finalize_telegram_receipt(
  p_workspace_id uuid,
  p_transaction_id uuid,
  p_uploaded_by_user_id uuid,
  p_storage_key text,
  p_content_type varchar,
  p_byte_size bigint,
  p_sha256_hex text,
  p_merchant_name text,
  p_receipt_date date,
  p_total_amount_minor bigint,
  p_currency_code char(3),
  p_ocr_text text,
  p_ocr_language varchar,
  p_items jsonb,
  p_provider varchar,
  p_provider_model varchar,
  p_confidence numeric,
  p_retention_until timestamptz
)
returns table (receipt_id uuid, was_duplicate boolean)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_transaction public.financial_transactions%rowtype;
  v_file public.stored_files%rowtype;
  v_receipt_id uuid;
  v_item jsonb;
  v_line_number integer := 0;
  v_sha256 bytea;
begin
  if p_storage_key is null
    or p_storage_key not like p_workspace_id::text || '/%'
    or p_storage_key like '%..%'
    or char_length(p_storage_key) > 512 then
    raise exception 'Invalid workspace-scoped receipt storage key' using errcode = '22023';
  end if;
  if p_content_type <> 'image/jpeg' or p_byte_size <= 0 or p_byte_size > 10485760 then
    raise exception 'Invalid receipt file metadata' using errcode = '22023';
  end if;
  if p_sha256_hex !~ '^[0-9a-f]{64}$' then
    raise exception 'Invalid receipt checksum' using errcode = '22023';
  end if;
  if p_total_amount_minor is null or p_total_amount_minor <= 0 or p_total_amount_minor > 10000000000 then
    raise exception 'Invalid receipt amount' using errcode = '22023';
  end if;
  if p_retention_until is null or p_retention_until <= now() or p_retention_until > now() + interval '90 days' then
    raise exception 'Invalid receipt retention window' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 80 then
    raise exception 'Invalid receipt line items' using errcode = '22023';
  end if;

  select ft.* into v_transaction
  from public.financial_transactions ft
  where ft.id = p_transaction_id
  for update;

  if not found
    or v_transaction.workspace_id <> p_workspace_id
    or v_transaction.created_by_user_id <> p_uploaded_by_user_id then
    raise exception 'Receipt transaction boundary mismatch' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.ofa_users u
    join public.workspace_members wm
      on wm.user_id = u.id
     and wm.workspace_id = p_workspace_id
     and wm.status = 'active'
     and wm.removed_at is null
    join public.workspaces w on w.id = wm.workspace_id and w.deleted_at is null
    where u.id = p_uploaded_by_user_id
      and u.status = 'active'
      and u.deleted_at is null
  ) then
    raise exception 'Receipt uploader no longer has active workspace access' using errcode = '42501';
  end if;

  select rtl.receipt_id into v_receipt_id
  from public.receipt_transaction_links rtl
  join public.ofa_receipts r on r.id = rtl.receipt_id
  where rtl.transaction_id = p_transaction_id
    and rtl.unlinked_at is null
    and r.workspace_id = p_workspace_id
    and r.deleted_at is null
  order by r.created_at
  limit 1;
  if v_receipt_id is not null then
    return query select v_receipt_id, true;
    return;
  end if;

  v_sha256 := decode(p_sha256_hex, 'hex');
  select sf.* into v_file
  from public.stored_files sf
  where sf.storage_provider = 'supabase_storage'
    and sf.storage_key = p_storage_key
  for update;

  if found then
    if v_file.workspace_id <> p_workspace_id
      or v_file.sha256 <> v_sha256
      or v_file.deleted_at is not null then
      raise exception 'Existing receipt file metadata does not match' using errcode = '23505';
    end if;
  else
    insert into public.stored_files (
      workspace_id, storage_provider, storage_key, content_type, byte_size, sha256, uploaded_by_user_id
    ) values (
      p_workspace_id, 'supabase_storage', p_storage_key, p_content_type, p_byte_size, v_sha256, p_uploaded_by_user_id
    ) returning * into v_file;
  end if;

  insert into public.ofa_receipts (
    workspace_id, file_id, uploaded_by_user_id, status, archive_status, retention_until,
    merchant_name, receipt_date, total_amount_minor, currency_code, ocr_text, ocr_language, processed_at
  ) values (
    p_workspace_id, v_file.id, p_uploaded_by_user_id, 'completed', 'decision_pending', p_retention_until,
    nullif(left(trim(p_merchant_name), 300), ''), p_receipt_date, p_total_amount_minor,
    p_currency_code, left(coalesce(p_ocr_text, ''), 50000), left(coalesce(p_ocr_language, ''), 16), now()
  ) returning id into v_receipt_id;

  for v_item in select value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) loop
    v_line_number := v_line_number + 1;
    if jsonb_typeof(v_item) <> 'object'
      or nullif(trim(v_item->>'name'), '') is null
      or char_length(trim(v_item->>'name')) > 500 then
      raise exception 'Invalid receipt line item' using errcode = '22023';
    end if;
    insert into public.receipt_line_items (
      workspace_id, receipt_id, line_number, item_name, quantity,
      unit_amount_minor, total_amount_minor, currency_code
    ) values (
      p_workspace_id, v_receipt_id, v_line_number, trim(v_item->>'name'),
      nullif(v_item->>'quantity', '')::numeric,
      nullif(v_item->>'unitAmountMinor', '')::bigint,
      nullif(v_item->>'totalAmountMinor', '')::bigint,
      p_currency_code
    );
  end loop;

  insert into public.receipt_ocr_runs (
    receipt_id, provider, provider_model, status, extracted_data, confidence, completed_at
  ) values (
    v_receipt_id, left(p_provider, 48), left(p_provider_model, 96), 'completed',
    jsonb_build_object(
      'merchantName', nullif(left(trim(p_merchant_name), 300), ''),
      'receiptDate', p_receipt_date,
      'amountMinor', p_total_amount_minor,
      'currencyCode', p_currency_code,
      'items', coalesce(p_items, '[]'::jsonb),
      'ocrText', left(coalesce(p_ocr_text, ''), 50000)
    ), p_confidence, now()
  );

  insert into public.receipt_transaction_links (receipt_id, transaction_id, link_source, confidence, linked_by_user_id)
  values (v_receipt_id, p_transaction_id, 'ocr', p_confidence, p_uploaded_by_user_id);

  insert into public.audit_events (workspace_id, actor_user_id, actor_type, action, entity_type, entity_id)
  values (p_workspace_id, p_uploaded_by_user_id, 'user', 'receipt.finalized_from_telegram', 'receipt', v_receipt_id);

  return query select v_receipt_id, false;
end;
$$;

revoke all on function public.finalize_telegram_receipt(
  uuid, uuid, uuid, text, varchar, bigint, text, text, date, bigint, char(3), text,
  varchar, jsonb, varchar, varchar, numeric, timestamptz
) from public, anon, authenticated;
grant execute on function public.finalize_telegram_receipt(
  uuid, uuid, uuid, text, varchar, bigint, text, text, date, bigint, char(3), text,
  varchar, jsonb, varchar, varchar, numeric, timestamptz
) to service_role;
