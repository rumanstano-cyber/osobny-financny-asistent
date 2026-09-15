-- A Telegram callback may be delivered again, or the same inline button may be
-- tapped more than once. Keep a short-lived, privacy-preserving claim so one
-- budget button can produce at most one chat response across process restarts.
create table public.telegram_budget_callback_claims (
  claim_key char(64) primary key,
  callback_query_hash char(64) not null unique,
  flow varchar(32) not null check (flow = 'budget'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  check (expires_at > created_at)
);

create index telegram_budget_callback_claims_expiry_idx
  on public.telegram_budget_callback_claims (expires_at);

alter table public.telegram_budget_callback_claims enable row level security;

-- This state is backend-only. The API service role is the sole Data API caller.
revoke all on table public.telegram_budget_callback_claims from anon, authenticated;
grant select, insert, delete on table public.telegram_budget_callback_claims to service_role;
