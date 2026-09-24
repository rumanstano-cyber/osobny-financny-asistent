\set ON_ERROR_STOP on

-- The standalone Supabase Postgres image does not initialize the separate
-- Storage service tables. These minimal relations exist only in disposable CI.
-- The image itself supplies auth.users, auth.uid(), Vault, pg_cron and pg_net.
-- Its placeholder auth.users relation omits columns supplied by the Auth
-- service in a full Supabase stack. Add only those needed by app migrations.
alter table auth.users
  add column if not exists email text,
  add column if not exists email_confirmed_at timestamptz,
  add column if not exists raw_user_meta_data jsonb not null default '{}'::jsonb;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[]
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (bucket_id, name)
);

-- These four legacy test relations predate the append-only application
-- migration history. The production migration set deliberately preserves and
-- restricts them; synthetic CI needs empty stand-ins to replay that history.
create table if not exists public.users (id uuid primary key);
create table if not exists public.transactions (id uuid primary key);
create table if not exists public.receipts (id uuid primary key);
create table if not exists public.monthly_reports (id uuid primary key);
create or replace view public.v_monthly_summary as
  select transaction.id from public.transactions transaction;
