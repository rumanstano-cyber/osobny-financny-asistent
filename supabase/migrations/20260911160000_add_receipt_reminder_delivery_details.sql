-- Delivery metadata is resolved only after a durable reminder was claimed.
-- This keeps existing claim/retry/idempotency semantics unchanged while giving
-- the API enough information to name and attach the archived receipt.
create function public.get_receipt_purchase_protection_reminder_delivery(
  p_reminder_id uuid
)
returns table (
  merchant_name text,
  receipt_date date,
  storage_key text
)
language sql
security definer
set search_path = public, pg_catalog
stable
as $$
  select
    nullif(trim(receipt.merchant_name), '') as merchant_name,
    receipt.receipt_date,
    stored_file.storage_key
  from public.receipt_purchase_protection_reminders reminder
  join public.receipt_purchase_protections protection on protection.id = reminder.protection_id
  join public.ofa_receipts receipt on receipt.id = protection.receipt_id
  left join public.stored_files stored_file
    on stored_file.id = receipt.file_id
    and stored_file.deleted_at is null
  where reminder.id = p_reminder_id
    and reminder.status = 'sending'
    and protection.status = 'active'
    and receipt.archive_status = 'archived'
    and receipt.deleted_at is null
  limit 1;
$$;

revoke all on function public.get_receipt_purchase_protection_reminder_delivery(uuid) from public, anon, authenticated;
grant execute on function public.get_receipt_purchase_protection_reminder_delivery(uuid) to service_role;
