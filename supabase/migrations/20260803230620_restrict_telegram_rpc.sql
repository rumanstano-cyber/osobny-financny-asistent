-- Explicitly revoke Supabase's role-level default EXECUTE grants.
-- The Telegram write path is backend-only and must use service_role.
revoke all on function public.record_telegram_transaction(
  text, text, text, text, text, text, bigint, char(3), public.ofa_transaction_type, varchar, text, timestamptz, varchar
) from public, anon, authenticated;

grant execute on function public.record_telegram_transaction(
  text, text, text, text, text, text, bigint, char(3), public.ofa_transaction_type, varchar, text, timestamptz, varchar
) to service_role;
