-- Reconcile only deterministic receipt objects that became orphaned after a
-- worker crash. The storage schema is treated as read-only; physical deletion
-- remains exclusively in the application through the Supabase Storage API.
create table public.receipt_storage_orphan_cleanup_runs (
  singleton boolean primary key default true check (singleton),
  lease_token uuid,
  lease_expires_at timestamptz,
  minimum_age interval not null default interval '24 hours'
    check (minimum_age >= interval '24 hours'),
  candidate_keys text[] not null default '{}'::text[]
    check (cardinality(candidate_keys) <= 50),
  started_at timestamptz,
  completed_at timestamptz,
  deleted_count integer not null default 0 check (deleted_count >= 0),
  last_error text
);

insert into public.receipt_storage_orphan_cleanup_runs (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.receipt_storage_orphan_cleanup_runs enable row level security;
revoke all on table public.receipt_storage_orphan_cleanup_runs from public, anon, authenticated;

create or replace function public.is_receipt_storage_orphan_candidate(
  p_storage_key text,
  p_minimum_age interval
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_minimum_age >= interval '24 hours'
    and p_storage_key is not null
    and (
      p_storage_key ~ '^incoming/telegram/[0-9]+-[0-9a-f]{16}\.jpg$'
      or p_storage_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9]+-[0-9a-f]{16}\.jpg$'
    )
    and exists (
      select 1
      from storage.objects storage_object
      where storage_object.bucket_id = 'ofa-receipts'
        and storage_object.name = p_storage_key
        and storage_object.created_at < pg_catalog.now() - p_minimum_age
    )
    and not exists (
      select 1
      from public.stored_files stored_file
      where stored_file.storage_key = p_storage_key
    )
    and not exists (
      select 1
      from public.async_jobs job
      where job.job_type = 'telegram_media'
        and job.status in ('queued', 'running')
        and job.payload->>'kind' = 'receipt'
        and job.payload->>'updateId' = case
          when p_storage_key like 'incoming/telegram/%'
            then split_part(split_part(p_storage_key, '/', 3), '-', 1)
          else split_part(split_part(p_storage_key, '/', 2), '-', 1)
        end
    );
$$;

create or replace function public.claim_receipt_storage_orphan_cleanup(
  p_minimum_age interval default interval '24 hours',
  p_limit integer default 25,
  p_lease_interval interval default interval '10 minutes'
)
returns table (run_token uuid, storage_key text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.receipt_storage_orphan_cleanup_runs%rowtype;
  v_token uuid;
  v_candidates text[];
begin
  if p_minimum_age is null
    or p_limit is null
    or p_lease_interval is null
    or p_minimum_age < interval '24 hours'
    or p_minimum_age > interval '30 days'
    or p_limit < 1
    or p_limit > 50
    or p_lease_interval < interval '1 minute'
    or p_lease_interval > interval '30 minutes' then
    raise exception 'Invalid receipt orphan cleanup parameters' using errcode = '22023';
  end if;

  select cleanup_run.*
  into v_run
  from public.receipt_storage_orphan_cleanup_runs cleanup_run
  where cleanup_run.singleton = true
  for update;

  if v_run.lease_token is not null
    and v_run.lease_expires_at > pg_catalog.now() then
    return;
  end if;

  select coalesce(pg_catalog.array_agg(candidate.name order by candidate.created_at), '{}'::text[])
  into v_candidates
  from (
    select storage_object.name, storage_object.created_at
    from storage.objects storage_object
    where storage_object.bucket_id = 'ofa-receipts'
      and public.is_receipt_storage_orphan_candidate(storage_object.name, p_minimum_age)
    order by storage_object.created_at, storage_object.name
    limit p_limit
  ) candidate;

  if pg_catalog.cardinality(v_candidates) = 0 then
    return;
  end if;

  v_token := extensions.gen_random_uuid();
  update public.receipt_storage_orphan_cleanup_runs cleanup_run
  set lease_token = v_token,
      lease_expires_at = pg_catalog.now() + p_lease_interval,
      minimum_age = p_minimum_age,
      candidate_keys = v_candidates,
      started_at = pg_catalog.now(),
      completed_at = null,
      deleted_count = 0,
      last_error = null
  where cleanup_run.singleton = true;

  return query
  select v_token, candidate_key
  from pg_catalog.unnest(v_candidates) candidate_key;
end;
$$;

create or replace function public.confirm_receipt_storage_orphan_deletion(
  p_run_token uuid,
  p_storage_key text
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run public.receipt_storage_orphan_cleanup_runs%rowtype;
begin
  if p_run_token is null or p_storage_key is null then
    return false;
  end if;

  select cleanup_run.*
  into v_run
  from public.receipt_storage_orphan_cleanup_runs cleanup_run
  where cleanup_run.singleton = true
  for update;

  if v_run.lease_token is distinct from p_run_token
    or v_run.lease_expires_at <= pg_catalog.now()
    or not (p_storage_key = any(v_run.candidate_keys)) then
    return false;
  end if;

  return public.is_receipt_storage_orphan_candidate(p_storage_key, v_run.minimum_age);
end;
$$;

create or replace function public.complete_receipt_storage_orphan_cleanup(
  p_run_token uuid,
  p_deleted_count integer,
  p_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_run_token is null or p_deleted_count is null or p_deleted_count < 0 or p_deleted_count > 50 then
    return false;
  end if;

  update public.receipt_storage_orphan_cleanup_runs cleanup_run
  set lease_token = null,
      lease_expires_at = null,
      candidate_keys = '{}'::text[],
      completed_at = pg_catalog.now(),
      deleted_count = p_deleted_count,
      last_error = nullif(left(coalesce(p_error, ''), 500), '')
  where cleanup_run.singleton = true
    and cleanup_run.lease_token = p_run_token;

  return found;
end;
$$;

revoke all on function public.is_receipt_storage_orphan_candidate(text, interval) from public, anon, authenticated, service_role;
revoke all on function public.claim_receipt_storage_orphan_cleanup(interval, integer, interval) from public, anon, authenticated;
revoke all on function public.confirm_receipt_storage_orphan_deletion(uuid, text) from public, anon, authenticated;
revoke all on function public.complete_receipt_storage_orphan_cleanup(uuid, integer, text) from public, anon, authenticated;

grant execute on function public.claim_receipt_storage_orphan_cleanup(interval, integer, interval) to service_role;
grant execute on function public.confirm_receipt_storage_orphan_deletion(uuid, text) to service_role;
grant execute on function public.complete_receipt_storage_orphan_cleanup(uuid, integer, text) to service_role;
