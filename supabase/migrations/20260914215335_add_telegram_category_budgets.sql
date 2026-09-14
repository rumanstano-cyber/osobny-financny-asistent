-- Monthly category limits reuse the existing budgets table. These additions
-- provide durable Telegram conversation state, one-time alerts and offer choice.

create unique index if not exists budgets_one_active_monthly_category_idx
  on public.budgets (workspace_id, category_id)
  where period = 'monthly' and is_active and deleted_at is null and category_id is not null;

create table if not exists public.budget_alert_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  budget_id uuid not null references public.budgets(id) on delete restrict,
  period_start date not null,
  threshold smallint not null check (threshold in (80, 100)),
  sent_at timestamptz not null default now(),
  unique (budget_id, period_start, threshold)
);
create index if not exists budget_alert_events_workspace_period_idx on public.budget_alert_events (workspace_id, period_start desc);

create table if not exists public.telegram_budget_pending_states (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  user_id uuid not null references public.ofa_users(id) on delete restrict,
  category_id uuid not null references public.categories(id) on delete restrict,
  intent varchar(48) not null check (intent = 'awaiting_budget_amount'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create index if not exists telegram_budget_pending_states_expiry_idx on public.telegram_budget_pending_states (expires_at);

create table if not exists public.budget_preferences (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  user_id uuid not null references public.ofa_users(id) on delete restrict,
  proactive_budget_offers_enabled boolean not null default true,
  suppressed_until timestamptz,
  last_offer_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, user_id)
);
create trigger budget_preferences_set_updated_at before update on public.budget_preferences for each row execute function public.set_updated_at();

alter table public.budget_alert_events enable row level security;
alter table public.telegram_budget_pending_states enable row level security;
alter table public.budget_preferences enable row level security;

-- The web dashboard may read only its own workspace limits. Telegram writes
-- through the server's service role; no public write grants are introduced.
create policy "members can view workspace budgets"
  on public.budgets for select to authenticated
  using (public.is_current_user_workspace_member(workspace_id) and deleted_at is null);
grant select on public.budgets to authenticated;
