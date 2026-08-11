-- Defense-in-depth RLS enforcement for every current public table.
-- This is idempotent: enabling RLS again does not alter existing policies.
-- It intentionally includes legacy test tables (transactions, users, receipts,
-- monthly_reports) without changing their schema or data.

alter table public.ai_runs enable row level security;
alter table public.async_jobs enable row level security;
alter table public.audit_events enable row level security;
alter table public.auth_identities enable row level security;
alter table public.budgets enable row level security;
alter table public.categories enable row level security;
alter table public.category_rules enable row level security;
alter table public.channel_accounts enable row level security;
alter table public.channel_messages enable row level security;
alter table public.conversations enable row level security;
alter table public.currencies enable row level security;
alter table public.exchange_rates enable row level security;
alter table public.financial_transactions enable row level security;
alter table public.gdpr_requests enable row level security;
alter table public.monthly_reports enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.ofa_receipts enable row level security;
alter table public.ofa_users enable row level security;
alter table public.receipt_ocr_runs enable row level security;
alter table public.receipt_transaction_links enable row level security;
alter table public.receipts enable row level security;
alter table public.report_deliveries enable row level security;
alter table public.report_schedules enable row level security;
alter table public.stored_files enable row level security;
alter table public.telegram_link_codes enable row level security;
alter table public.transaction_category_assignments enable row level security;
alter table public.transaction_events enable row level security;
alter table public.transactions enable row level security;
alter table public.user_consents enable row level security;
alter table public.user_devices enable row level security;
alter table public.users enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspaces enable row level security;
