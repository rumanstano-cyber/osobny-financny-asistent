-- Osobný finančný asistent: initial production schema.
-- Designed for Supabase PostgreSQL. This migration only creates new objects.

create extension if not exists pgcrypto;
create extension if not exists citext;
create extension if not exists pg_trgm;

create type public.workspace_member_role as enum ('owner', 'admin', 'member', 'viewer');
create type public.membership_status as enum ('active', 'invited', 'suspended', 'removed');
create type public.auth_provider as enum ('telegram', 'whatsapp', 'email', 'apple', 'google', 'web_authn');
create type public.channel_type as enum ('telegram', 'whatsapp', 'web', 'mobile');
create type public.message_direction as enum ('inbound', 'outbound');
create type public.message_processing_status as enum ('received', 'processing', 'completed', 'failed', 'ignored');
create type public.ofa_transaction_type as enum ('income', 'expense', 'transfer');
create type public.transaction_status as enum ('confirmed', 'pending_confirmation', 'voided');
create type public.ofa_transaction_source as enum ('message', 'receipt', 'manual', 'bank_sync', 'import', 'system');
create type public.classification_source as enum ('rule', 'ai', 'ocr', 'user', 'system');
create type public.receipt_status as enum ('uploaded', 'queued', 'processing', 'completed', 'needs_review', 'failed', 'deleted');
create type public.budget_period as enum ('weekly', 'monthly', 'quarterly', 'yearly', 'custom');
create type public.notification_channel as enum ('telegram', 'whatsapp', 'push', 'email', 'in_app');
create type public.notification_status as enum ('queued', 'sent', 'failed', 'cancelled');
create type public.report_type as enum ('monthly_summary', 'custom_summary', 'category_summary', 'financial_health');
create type public.report_delivery_status as enum ('queued', 'generated', 'sent', 'failed', 'cancelled');
create type public.gdpr_request_type as enum ('export', 'erasure');
create type public.gdpr_request_status as enum ('requested', 'processing', 'completed', 'rejected', 'cancelled');

create or replace function public.set_updated_at()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.deny_event_mutation()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  raise exception 'Append-only table: % operations are not allowed', tg_table_name;
end;
$$;

create or replace function public.close_category_assignment_only()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if old.valid_to is null
     and new.valid_to is not null
     and new.valid_to >= old.valid_from
     and new.id = old.id
     and new.transaction_id = old.transaction_id
     and new.category_id = old.category_id
     and new.source = old.source
     and new.confidence is not distinct from old.confidence
     and new.reason is not distinct from old.reason
     and new.ai_run_id is not distinct from old.ai_run_id
     and new.assigned_by_user_id is not distinct from old.assigned_by_user_id
     and new.valid_from = old.valid_from
     and new.created_at = old.created_at then
    return new;
  end if;
  raise exception 'Category assignments are immutable except for closing valid_to';
end;
$$;

create table public.currencies (
  code char(3) primary key,
  numeric_code char(3) unique,
  name text not null,
  minor_unit smallint not null check (minor_unit between 0 and 6),
  is_active boolean not null default true
);

insert into public.currencies (code, numeric_code, name, minor_unit) values
  ('EUR', '978', 'Euro', 2),
  ('CZK', '203', 'Czech koruna', 2),
  ('USD', '840', 'US dollar', 2),
  ('GBP', '826', 'Pound sterling', 2),
  ('HUF', '348', 'Hungarian forint', 0),
  ('PLN', '985', 'Polish zloty', 2)
on conflict (code) do nothing;

create table public.ofa_users (
  id uuid primary key default gen_random_uuid(),
  display_name text,
  email citext,
  locale varchar(16) not null default 'sk-SK',
  time_zone varchar(64) not null default 'Europe/Bratislava',
  status varchar(24) not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index ofa_users_email_active_key on public.ofa_users (email) where email is not null and deleted_at is null;
create index ofa_users_status_last_seen_idx on public.ofa_users (status, last_seen_at desc);

create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(trim(name)) between 1 and 160),
  workspace_type varchar(16) not null check (workspace_type in ('personal', 'family')),
  base_currency_code char(3) not null references public.currencies(code),
  time_zone varchar(64) not null default 'Europe/Bratislava',
  created_by_user_id uuid not null references public.ofa_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index workspaces_creator_deleted_idx on public.workspaces (created_by_user_id, deleted_at);

create table public.workspace_members (
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  user_id uuid not null references public.ofa_users(id) on delete restrict,
  role public.workspace_member_role not null,
  status public.membership_status not null default 'active',
  invited_by_user_id uuid references public.ofa_users(id) on delete set null,
  joined_at timestamptz,
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, user_id),
  check ((status = 'active' and removed_at is null) or status <> 'active')
);
create index workspace_members_user_status_idx on public.workspace_members (user_id, status);
create unique index workspace_members_one_active_owner_idx on public.workspace_members (workspace_id)
  where role = 'owner' and status = 'active';

create table public.auth_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.ofa_users(id) on delete restrict,
  provider public.auth_provider not null,
  provider_subject text not null,
  provider_metadata jsonb not null default '{}'::jsonb,
  verified_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subject)
);
create index auth_identities_user_idx on public.auth_identities (user_id);

create table public.user_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.ofa_users(id) on delete restrict,
  platform varchar(24) not null check (platform in ('ios', 'android', 'web', 'desktop')),
  installation_id uuid not null,
  push_token_encrypted bytea,
  push_token_hash bytea,
  app_version text,
  device_label text,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, installation_id)
);
create unique index user_devices_active_push_token_idx on public.user_devices (push_token_hash)
  where push_token_hash is not null and revoked_at is null;
create index user_devices_user_last_seen_idx on public.user_devices (user_id, last_seen_at desc);

create table public.user_consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.ofa_users(id) on delete restrict,
  consent_type varchar(48) not null,
  policy_version varchar(32) not null,
  granted boolean not null,
  recorded_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  evidence jsonb not null default '{}'::jsonb,
  check (withdrawn_at is null or withdrawn_at >= recorded_at)
);
create index user_consents_lookup_idx on public.user_consents (user_id, consent_type, recorded_at desc);

create table public.channel_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.ofa_users(id) on delete restrict,
  channel public.channel_type not null,
  external_account_id text not null,
  external_username text,
  metadata jsonb not null default '{}'::jsonb,
  linked_at timestamptz not null default now(),
  unlinked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel, external_account_id),
  check (unlinked_at is null or unlinked_at >= linked_at)
);
create index channel_accounts_active_user_channel_idx on public.channel_accounts (user_id, channel) where unlinked_at is null;

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  channel public.channel_type not null,
  external_conversation_id text not null,
  conversation_type varchar(24) not null default 'direct' check (conversation_type in ('direct', 'group', 'support')),
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (channel, external_conversation_id)
);
create index conversations_workspace_recent_idx on public.conversations (workspace_id, last_message_at desc);

create table public.channel_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete restrict,
  sender_channel_account_id uuid references public.channel_accounts(id) on delete set null,
  direction public.message_direction not null,
  external_message_id text not null,
  idempotency_key varchar(255) not null,
  content_type varchar(32) not null check (content_type in ('text', 'image', 'voice', 'document', 'command')),
  content_encrypted bytea,
  content_hash bytea,
  provider_payload jsonb,
  processing_status public.message_processing_status not null default 'received',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (conversation_id, external_message_id),
  unique (idempotency_key)
);
create index channel_messages_conversation_recent_idx on public.channel_messages (conversation_id, received_at desc);
create index channel_messages_pending_idx on public.channel_messages (processing_status, received_at)
  where processing_status in ('received', 'failed');

create table public.categories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete restrict,
  parent_category_id uuid references public.categories(id) on delete restrict,
  kind varchar(16) not null check (kind in ('system', 'custom')),
  name text not null check (char_length(trim(name)) between 1 and 100),
  slug varchar(96) not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  transaction_type public.ofa_transaction_type,
  icon varchar(32),
  color varchar(32),
  is_active boolean not null default true,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  check ((kind = 'system' and workspace_id is null) or (kind = 'custom' and workspace_id is not null)),
  check (not (is_active and is_archived))
);
create unique index categories_system_slug_idx on public.categories (slug) where workspace_id is null;
create unique index categories_workspace_slug_idx on public.categories (workspace_id, slug) where workspace_id is not null;
create index categories_workspace_parent_active_idx on public.categories (workspace_id, parent_category_id, is_active);

insert into public.categories (kind, name, slug, transaction_type, icon) values
  ('system', 'Potraviny', 'potraviny', 'expense', 'shopping-cart'),
  ('system', 'Auto', 'auto', 'expense', 'car'),
  ('system', 'Bývanie', 'byvanie', 'expense', 'home'),
  ('system', 'Reštaurácie', 'restauracie', 'expense', 'utensils'),
  ('system', 'Zábava', 'zabava', 'expense', 'film'),
  ('system', 'Drogéria', 'drogeria', 'expense', 'shopping-bag'),
  ('system', 'Elektronika', 'elektronika', 'expense', 'monitor'),
  ('system', 'Oblečenie', 'oblecenie', 'expense', 'shirt'),
  ('system', 'Zdravie', 'zdravie', 'expense', 'heart-pulse'),
  ('system', 'Domácnosť', 'domacnost', 'expense', 'lamp'),
  ('system', 'Deti', 'deti', 'expense', 'baby'),
  ('system', 'Poistenie', 'poistenie', 'expense', 'shield'),
  ('system', 'Dovolenka', 'dovolenka', 'expense', 'plane'),
  ('system', 'Ostatné', 'ostatne', 'expense', 'ellipsis'),
  ('system', 'Výplata', 'vyplata', 'income', 'wallet'),
  ('system', 'Iný príjem', 'iny-prijem', 'income', 'plus-circle')
on conflict do nothing;

create table public.financial_transactions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  created_by_user_id uuid not null references public.ofa_users(id) on delete restrict,
  transaction_type public.ofa_transaction_type not null,
  status public.transaction_status not null default 'confirmed',
  amount_minor bigint not null check (amount_minor >= 0),
  currency_code char(3) not null references public.currencies(code),
  occurred_at timestamptz not null,
  time_zone varchar(64) not null,
  merchant_name text,
  note text,
  source public.ofa_transaction_source not null,
  source_message_id uuid references public.channel_messages(id) on delete set null,
  external_reference text,
  version integer not null default 1 check (version > 0),
  metadata jsonb not null default '{}'::jsonb,
  confirmed_at timestamptz,
  voided_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'voided') = (voided_at is not null)),
  check ((status <> 'confirmed') or confirmed_at is not null),
  check (confirmed_at is null or confirmed_at >= created_at)
);
create index financial_transactions_workspace_occurred_idx on public.financial_transactions (workspace_id, occurred_at desc) where deleted_at is null;
create index financial_transactions_workspace_report_idx on public.financial_transactions (workspace_id, transaction_type, occurred_at desc)
  where status = 'confirmed' and deleted_at is null;
create index financial_transactions_workspace_currency_idx on public.financial_transactions (workspace_id, currency_code, occurred_at desc);
create index financial_transactions_merchant_trgm_idx on public.financial_transactions using gin (merchant_name gin_trgm_ops);
create index financial_transactions_search_idx on public.financial_transactions using gin (to_tsvector('simple', coalesce(merchant_name, '') || ' ' || coalesce(note, '')));
create unique index financial_transactions_external_reference_idx on public.financial_transactions (workspace_id, source, external_reference)
  where external_reference is not null;

create table public.transaction_events (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.financial_transactions(id) on delete restrict,
  event_type varchar(48) not null check (event_type in ('created', 'confirmed', 'corrected', 'voided', 'restored', 'deleted')),
  actor_user_id uuid references public.ofa_users(id) on delete set null,
  before_state jsonb,
  after_state jsonb,
  reason text,
  occurred_at timestamptz not null default now()
);
create index transaction_events_recent_idx on public.transaction_events (transaction_id, occurred_at desc);

create table public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  base_currency_code char(3) not null references public.currencies(code),
  quote_currency_code char(3) not null references public.currencies(code),
  rate numeric(20,10) not null check (rate > 0),
  rate_date date not null,
  source varchar(48) not null,
  retrieved_at timestamptz not null default now(),
  unique (base_currency_code, quote_currency_code, rate_date, source),
  check (base_currency_code <> quote_currency_code)
);
create index exchange_rates_date_idx on public.exchange_rates (rate_date desc);

create table public.stored_files (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  storage_provider text not null,
  storage_key text not null,
  content_type varchar(255) not null,
  byte_size bigint not null check (byte_size > 0),
  sha256 bytea not null check (octet_length(sha256) = 32),
  encryption_key_version varchar(32),
  uploaded_by_user_id uuid references public.ofa_users(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  unique (storage_provider, storage_key)
);
create index stored_files_workspace_recent_idx on public.stored_files (workspace_id, created_at desc);
create index stored_files_workspace_hash_idx on public.stored_files (workspace_id, sha256);

create table public.ofa_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  file_id uuid not null references public.stored_files(id) on delete restrict,
  uploaded_by_user_id uuid not null references public.ofa_users(id) on delete restrict,
  source_message_id uuid references public.channel_messages(id) on delete set null,
  status public.receipt_status not null default 'uploaded',
  merchant_name text,
  receipt_date date,
  total_amount_minor bigint check (total_amount_minor >= 0),
  currency_code char(3) references public.currencies(code),
  ocr_text text,
  ocr_language varchar(16),
  processing_error_code varchar(64),
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  deleted_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (file_id),
  check ((total_amount_minor is null) = (currency_code is null))
);
create index ofa_receipts_workspace_date_idx on public.ofa_receipts (workspace_id, receipt_date desc);
create index ofa_receipts_merchant_trgm_idx on public.ofa_receipts using gin (merchant_name gin_trgm_ops);
create index ofa_receipts_ocr_search_idx on public.ofa_receipts using gin (to_tsvector('simple', coalesce(ocr_text, '')));
create index ofa_receipts_pending_idx on public.ofa_receipts (status, created_at) where status in ('uploaded', 'queued', 'failed');

create table public.receipt_ocr_runs (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references public.ofa_receipts(id) on delete restrict,
  provider varchar(48) not null,
  provider_model varchar(96),
  status varchar(24) not null check (status in ('queued', 'running', 'completed', 'failed')),
  extracted_data jsonb,
  confidence numeric(5,4) check (confidence between 0 and 1),
  error_code varchar(64),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index receipt_ocr_runs_receipt_recent_idx on public.receipt_ocr_runs (receipt_id, created_at desc);
create index receipt_ocr_runs_pending_idx on public.receipt_ocr_runs (status, created_at) where status in ('queued', 'running');

create table public.ai_runs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  purpose varchar(48) not null check (purpose in ('message_parse', 'categorization', 'receipt_extract', 'report_insight')),
  provider varchar(96) not null,
  model varchar(96) not null,
  input_hash bytea,
  output jsonb,
  status varchar(24) not null check (status in ('queued', 'running', 'completed', 'failed')),
  prompt_version varchar(64),
  input_tokens integer check (input_tokens >= 0),
  output_tokens integer check (output_tokens >= 0),
  latency_ms integer check (latency_ms >= 0),
  error_code varchar(64),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);
create index ai_runs_workspace_purpose_recent_idx on public.ai_runs (workspace_id, purpose, created_at desc);
create index ai_runs_failed_idx on public.ai_runs (created_at) where status = 'failed';

create table public.transaction_category_assignments (
  id uuid primary key default gen_random_uuid(),
  transaction_id uuid not null references public.financial_transactions(id) on delete restrict,
  category_id uuid not null references public.categories(id) on delete restrict,
  source public.classification_source not null,
  confidence numeric(5,4) check (confidence between 0 and 1),
  reason text,
  ai_run_id uuid references public.ai_runs(id) on delete set null,
  assigned_by_user_id uuid references public.ofa_users(id) on delete set null,
  valid_from timestamptz not null default now(),
  valid_to timestamptz,
  created_at timestamptz not null default now(),
  check (valid_to is null or valid_to >= valid_from)
);
create unique index transaction_category_current_idx on public.transaction_category_assignments (transaction_id) where valid_to is null;
create index transaction_category_category_recent_idx on public.transaction_category_assignments (category_id, valid_from desc);
create index transaction_category_transaction_recent_idx on public.transaction_category_assignments (transaction_id, valid_from desc);

create table public.receipt_transaction_links (
  receipt_id uuid not null references public.ofa_receipts(id) on delete restrict,
  transaction_id uuid not null references public.financial_transactions(id) on delete restrict,
  link_source public.classification_source not null,
  confidence numeric(5,4) check (confidence between 0 and 1),
  linked_by_user_id uuid references public.ofa_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unlinked_at timestamptz,
  primary key (receipt_id, transaction_id)
);
create index receipt_transaction_links_active_tx_idx on public.receipt_transaction_links (transaction_id) where unlinked_at is null;
create index receipt_transaction_links_active_receipt_idx on public.receipt_transaction_links (receipt_id) where unlinked_at is null;

create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  category_id uuid references public.categories(id) on delete restrict,
  name text not null check (char_length(trim(name)) between 1 and 160),
  period public.budget_period not null,
  period_anchor_day smallint check (period_anchor_day between 1 and 31),
  starts_on date not null,
  ends_on date,
  amount_minor bigint not null check (amount_minor > 0),
  currency_code char(3) not null references public.currencies(code),
  alert_threshold_percent smallint check (alert_threshold_percent between 1 and 100),
  is_active boolean not null default true,
  created_by_user_id uuid not null references public.ofa_users(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (ends_on is null or ends_on >= starts_on)
);
create index budgets_workspace_active_idx on public.budgets (workspace_id, is_active) where deleted_at is null;
create index budgets_category_active_idx on public.budgets (category_id, is_active) where deleted_at is null;

create table public.report_schedules (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  created_by_user_id uuid not null references public.ofa_users(id) on delete restrict,
  report_type public.report_type not null,
  schedule_expression text not null,
  time_zone varchar(64) not null,
  delivery_channel public.notification_channel not null,
  recipient_user_id uuid not null references public.ofa_users(id) on delete restrict,
  configuration jsonb not null default '{}'::jsonb,
  next_run_at timestamptz,
  last_run_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index report_schedules_due_idx on public.report_schedules (next_run_at) where is_active and deleted_at is null;
create index report_schedules_workspace_active_idx on public.report_schedules (workspace_id, is_active) where deleted_at is null;

create table public.report_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  schedule_id uuid references public.report_schedules(id) on delete set null,
  report_type public.report_type not null,
  period_start timestamptz not null,
  period_end timestamptz not null,
  base_currency_code char(3) not null references public.currencies(code),
  data_snapshot jsonb not null,
  insight_ai_run_id uuid references public.ai_runs(id) on delete set null,
  file_id uuid references public.stored_files(id) on delete set null,
  status public.report_delivery_status not null default 'queued',
  generated_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);
create index report_deliveries_workspace_period_idx on public.report_deliveries (workspace_id, period_start desc);
create index report_deliveries_schedule_recent_idx on public.report_deliveries (schedule_id, created_at desc);
create index report_deliveries_status_idx on public.report_deliveries (status, created_at);

create table public.notification_preferences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.ofa_users(id) on delete restrict,
  workspace_id uuid references public.workspaces(id) on delete restrict,
  notification_type varchar(48) not null,
  channel public.notification_channel not null,
  is_enabled boolean not null default true,
  quiet_hours jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (user_id, workspace_id, notification_type, channel)
);
create index notification_preferences_workspace_type_idx on public.notification_preferences (workspace_id, notification_type);

create table public.notification_deliveries (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete restrict,
  recipient_user_id uuid not null references public.ofa_users(id) on delete restrict,
  channel public.notification_channel not null,
  notification_type varchar(48) not null,
  payload jsonb not null default '{}'::jsonb,
  deduplication_key varchar(255) not null,
  status public.notification_status not null default 'queued',
  scheduled_for timestamptz not null default now(),
  sent_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  provider_message_id text,
  error_code text,
  unique (workspace_id, deduplication_key)
);
create index notification_deliveries_queued_idx on public.notification_deliveries (scheduled_for) where status = 'queued';
create index notification_deliveries_recipient_recent_idx on public.notification_deliveries (recipient_user_id, created_at desc);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete restrict,
  actor_user_id uuid references public.ofa_users(id) on delete set null,
  actor_type varchar(24) not null check (actor_type in ('user', 'system', 'service')),
  action varchar(96) not null,
  entity_type varchar(64) not null,
  entity_id uuid,
  request_id varchar(128),
  ip_hash varchar(128),
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);
create index audit_events_workspace_recent_idx on public.audit_events (workspace_id, occurred_at desc);
create index audit_events_entity_recent_idx on public.audit_events (entity_type, entity_id, occurred_at desc);
create index audit_events_actor_recent_idx on public.audit_events (actor_user_id, occurred_at desc);

create table public.gdpr_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.ofa_users(id) on delete restrict,
  request_type public.gdpr_request_type not null,
  status public.gdpr_request_status not null default 'requested',
  requested_at timestamptz not null default now(),
  due_at timestamptz not null,
  completed_at timestamptz,
  requested_workspace_id uuid references public.workspaces(id) on delete restrict,
  export_file_id uuid references public.stored_files(id) on delete set null,
  rejection_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index gdpr_requests_due_idx on public.gdpr_requests (status, due_at) where status in ('requested', 'processing');
create index gdpr_requests_user_recent_idx on public.gdpr_requests (user_id, requested_at desc);

create table public.async_jobs (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid references public.workspaces(id) on delete restrict,
  job_type varchar(64) not null,
  payload jsonb not null default '{}'::jsonb,
  deduplication_key varchar(255),
  status varchar(24) not null default 'queued' check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  run_after timestamptz not null default now(),
  locked_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  attempt_count smallint not null default 0 check (attempt_count >= 0),
  max_attempts smallint not null default 5 check (max_attempts > 0),
  last_error_code varchar(64)
);
create index async_jobs_queued_idx on public.async_jobs (run_after, created_at) where status = 'queued';
create unique index async_jobs_deduplication_idx on public.async_jobs (job_type, deduplication_key)
  where deduplication_key is not null and status in ('queued', 'running');

-- PostgreSQL foreign keys cannot express every tenant boundary because several
-- relations may point to system-wide rows. These triggers prevent cross-workspace
-- references while still allowing system categories.
create or replace function public.assert_active_workspace_member(p_workspace_id uuid, p_user_id uuid)
returns void language plpgsql security invoker set search_path = public as $$
begin
  if not exists (
    select 1 from public.workspace_members
    where workspace_id = p_workspace_id and user_id = p_user_id and status = 'active'
  ) then
    raise exception 'User % is not an active member of workspace %', p_user_id, p_workspace_id using errcode = '23514';
  end if;
end;
$$;

create or replace function public.validate_financial_transaction_workspace()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  perform public.assert_active_workspace_member(new.workspace_id, new.created_by_user_id);
  if new.source_message_id is not null and not exists (
    select 1 from public.channel_messages cm
    join public.conversations c on c.id = cm.conversation_id
    where cm.id = new.source_message_id and c.workspace_id = new.workspace_id
  ) then
    raise exception 'Source message belongs to a different workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_channel_message_workspace()
returns trigger language plpgsql security invoker set search_path = public as $$
declare v_workspace_id uuid;
begin
  select workspace_id into v_workspace_id from public.conversations where id = new.conversation_id;
  if new.sender_channel_account_id is not null and not exists (
    select 1 from public.channel_accounts ca
    join public.workspace_members wm on wm.user_id = ca.user_id
    where ca.id = new.sender_channel_account_id and wm.workspace_id = v_workspace_id and wm.status = 'active'
  ) then
    raise exception 'Message sender is not an active workspace member' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_receipt_workspace()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  perform public.assert_active_workspace_member(new.workspace_id, new.uploaded_by_user_id);
  if not exists (select 1 from public.stored_files where id = new.file_id and workspace_id = new.workspace_id) then
    raise exception 'Receipt file belongs to a different workspace' using errcode = '23514';
  end if;
  if new.source_message_id is not null and not exists (
    select 1 from public.channel_messages cm
    join public.conversations c on c.id = cm.conversation_id
    where cm.id = new.source_message_id and c.workspace_id = new.workspace_id
  ) then
    raise exception 'Receipt source message belongs to a different workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_category_assignment_workspace()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if not exists (
    select 1
    from public.financial_transactions ft
    join public.categories c on c.id = new.category_id
    where ft.id = new.transaction_id and (c.workspace_id is null or c.workspace_id = ft.workspace_id)
  ) then
    raise exception 'Category assignment crosses workspace boundary' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_receipt_transaction_link_workspace()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if not exists (
    select 1 from public.ofa_receipts r
    join public.financial_transactions ft on ft.id = new.transaction_id
    where r.id = new.receipt_id and r.workspace_id = ft.workspace_id
  ) then
    raise exception 'Receipt and transaction must belong to the same workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_budget_workspace()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  perform public.assert_active_workspace_member(new.workspace_id, new.created_by_user_id);
  if new.category_id is not null and not exists (
    select 1 from public.categories c where c.id = new.category_id and (c.workspace_id is null or c.workspace_id = new.workspace_id)
  ) then
    raise exception 'Budget category belongs to a different workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_report_schedule_workspace()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  perform public.assert_active_workspace_member(new.workspace_id, new.created_by_user_id);
  perform public.assert_active_workspace_member(new.workspace_id, new.recipient_user_id);
  return new;
end;
$$;

create or replace function public.validate_report_delivery_workspace()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  if new.schedule_id is not null and not exists (select 1 from public.report_schedules where id = new.schedule_id and workspace_id = new.workspace_id) then
    raise exception 'Report schedule belongs to a different workspace' using errcode = '23514';
  end if;
  if new.insight_ai_run_id is not null and not exists (select 1 from public.ai_runs where id = new.insight_ai_run_id and workspace_id = new.workspace_id) then
    raise exception 'AI run belongs to a different workspace' using errcode = '23514';
  end if;
  if new.file_id is not null and not exists (select 1 from public.stored_files where id = new.file_id and workspace_id = new.workspace_id) then
    raise exception 'Report file belongs to a different workspace' using errcode = '23514';
  end if;
  return new;
end;
$$;

create or replace function public.validate_notification_delivery_workspace()
returns trigger language plpgsql security invoker set search_path = public as $$
begin
  perform public.assert_active_workspace_member(new.workspace_id, new.recipient_user_id);
  return new;
end;
$$;

-- Atomic Telegram MVP write path. It creates the initial personal workspace on
-- first contact and makes Telegram update redelivery idempotent.
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
  where ca.channel = 'telegram' and ca.external_account_id = p_telegram_user_id and ca.unlinked_at is null;

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
    where wm.user_id = v_user_id and wm.status = 'active' and w.deleted_at is null
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
  where c.workspace_id is null and c.slug = p_category_slug and c.is_active and not c.is_archived
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

-- Keep generic timestamps consistent.
create trigger ofa_users_set_updated_at before update on public.ofa_users for each row execute function public.set_updated_at();
create trigger workspaces_set_updated_at before update on public.workspaces for each row execute function public.set_updated_at();
create trigger workspace_members_set_updated_at before update on public.workspace_members for each row execute function public.set_updated_at();
create trigger auth_identities_set_updated_at before update on public.auth_identities for each row execute function public.set_updated_at();
create trigger user_devices_set_updated_at before update on public.user_devices for each row execute function public.set_updated_at();
create trigger channel_accounts_set_updated_at before update on public.channel_accounts for each row execute function public.set_updated_at();
create trigger conversations_set_updated_at before update on public.conversations for each row execute function public.set_updated_at();
create trigger categories_set_updated_at before update on public.categories for each row execute function public.set_updated_at();
create trigger financial_transactions_set_updated_at before update on public.financial_transactions for each row execute function public.set_updated_at();
create trigger ofa_receipts_set_updated_at before update on public.ofa_receipts for each row execute function public.set_updated_at();
create trigger budgets_set_updated_at before update on public.budgets for each row execute function public.set_updated_at();
create trigger report_schedules_set_updated_at before update on public.report_schedules for each row execute function public.set_updated_at();
create trigger notification_preferences_set_updated_at before update on public.notification_preferences for each row execute function public.set_updated_at();
create trigger gdpr_requests_set_updated_at before update on public.gdpr_requests for each row execute function public.set_updated_at();

-- Tenant-bound relationships that cannot be modeled by a simple foreign key.
create trigger channel_messages_validate_workspace before insert or update on public.channel_messages for each row execute function public.validate_channel_message_workspace();
create trigger financial_transactions_validate_workspace before insert or update on public.financial_transactions for each row execute function public.validate_financial_transaction_workspace();
create trigger ofa_receipts_validate_workspace before insert or update on public.ofa_receipts for each row execute function public.validate_receipt_workspace();
create trigger transaction_category_assignments_validate_workspace before insert or update on public.transaction_category_assignments for each row execute function public.validate_category_assignment_workspace();
create trigger receipt_transaction_links_validate_workspace before insert or update on public.receipt_transaction_links for each row execute function public.validate_receipt_transaction_link_workspace();
create trigger budgets_validate_workspace before insert or update on public.budgets for each row execute function public.validate_budget_workspace();
create trigger report_schedules_validate_workspace before insert or update on public.report_schedules for each row execute function public.validate_report_schedule_workspace();
create trigger report_deliveries_validate_workspace before insert or update on public.report_deliveries for each row execute function public.validate_report_delivery_workspace();
create trigger notification_deliveries_validate_workspace before insert or update on public.notification_deliveries for each row execute function public.validate_notification_delivery_workspace();

-- Immutable history tables: only INSERT is permitted through normal application roles.
create trigger transaction_events_append_only before update or delete on public.transaction_events for each row execute function public.deny_event_mutation();
create trigger transaction_category_assignments_close_only before update on public.transaction_category_assignments for each row execute function public.close_category_assignment_only();
create trigger transaction_category_assignments_no_delete before delete on public.transaction_category_assignments for each row execute function public.deny_event_mutation();
create trigger audit_events_append_only before update or delete on public.audit_events for each row execute function public.deny_event_mutation();

-- The API currently uses the Supabase service-role key. RLS prevents accidental
-- direct client access; user-scoped policies will be added with web/mobile auth.
alter table public.ofa_users enable row level security;
alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.auth_identities enable row level security;
alter table public.user_devices enable row level security;
alter table public.user_consents enable row level security;
alter table public.channel_accounts enable row level security;
alter table public.conversations enable row level security;
alter table public.channel_messages enable row level security;
alter table public.categories enable row level security;
alter table public.financial_transactions enable row level security;
alter table public.transaction_events enable row level security;
alter table public.exchange_rates enable row level security;
alter table public.stored_files enable row level security;
alter table public.ofa_receipts enable row level security;
alter table public.receipt_ocr_runs enable row level security;
alter table public.ai_runs enable row level security;
alter table public.transaction_category_assignments enable row level security;
alter table public.receipt_transaction_links enable row level security;
alter table public.budgets enable row level security;
alter table public.report_schedules enable row level security;
alter table public.report_deliveries enable row level security;
alter table public.notification_preferences enable row level security;
alter table public.notification_deliveries enable row level security;
alter table public.audit_events enable row level security;
alter table public.gdpr_requests enable row level security;
alter table public.async_jobs enable row level security;
