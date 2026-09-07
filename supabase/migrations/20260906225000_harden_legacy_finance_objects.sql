-- Legacy objects are retained temporarily for rollback and forensic review,
-- but must not be readable by public-facing database roles. The current
-- application uses public.financial_transactions instead.
revoke all privileges on table public.transactions from anon, authenticated;
revoke all privileges on table public.v_monthly_summary from anon, authenticated;

-- Do not let the legacy view bypass the caller's row-level-security context.
alter view public.v_monthly_summary set (security_invoker = true);
