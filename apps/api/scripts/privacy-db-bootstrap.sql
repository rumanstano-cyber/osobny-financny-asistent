\set ON_ERROR_STOP on

-- The standalone Supabase Postgres image does not initialize the separate
-- Storage service tables. These minimal relations exist only in disposable CI.
-- The image itself supplies auth.users, auth.uid(), Vault, pg_cron and pg_net.
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
