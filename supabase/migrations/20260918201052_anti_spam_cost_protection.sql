-- Distributed anti-spam and paid-operation cost protection. Counters contain
-- only SHA-256 scope hashes, never Telegram IDs, IP addresses, or message text.
create table public.cost_rate_limit_counters (
  scope_type varchar(32) not null,
  scope_key_hash varchar(64) not null,
  operation varchar(64) not null,
  window_seconds integer not null check (window_seconds between 1 and 604800),
  bucket_start timestamptz not null,
  usage_count integer not null default 0 check (usage_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (scope_type, scope_key_hash, operation, window_seconds, bucket_start),
  check (scope_key_hash ~ '^[0-9a-f]{64}$'),
  check (length(operation) between 1 and 64)
);

create index cost_rate_limit_counters_cleanup_idx
  on public.cost_rate_limit_counters (bucket_start);

alter table public.cost_rate_limit_counters enable row level security;
revoke all on table public.cost_rate_limit_counters from public, anon, authenticated;

create table public.telegram_update_claims (
  update_id bigint primary key,
  telegram_user_hash varchar(64) not null check (telegram_user_hash ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz not null default now()
);

create index telegram_update_claims_cleanup_idx
  on public.telegram_update_claims (claimed_at);

alter table public.telegram_update_claims enable row level security;
revoke all on table public.telegram_update_claims from public, anon, authenticated;

-- Claims each Telegram update once across all Render instances and restarts.
create or replace function public.claim_telegram_update(
  p_update_id bigint,
  p_telegram_user_hash text
)
returns boolean
language sql
security definer
set search_path = ''
as $$
  with inserted as (
    insert into public.telegram_update_claims (update_id, telegram_user_hash)
    select p_update_id, lower(p_telegram_user_hash)
    where p_update_id >= 0
      and lower(p_telegram_user_hash) ~ '^[0-9a-f]{64}$'
    on conflict (update_id) do nothing
    returning true as claimed
  )
  select coalesce((select claimed from inserted), false);
$$;

revoke all on function public.claim_telegram_update(bigint, text) from public, anon, authenticated;
grant execute on function public.claim_telegram_update(bigint, text) to service_role;

-- Atomically checks and consumes all supplied fixed-window limits. The caller
-- supplies both per-user and global policies in a deterministic order. Rows are
-- locked in that order, so parallel requests cannot oversubscribe a limit.
create or replace function public.consume_cost_rate_limits(
  p_operation text,
  p_cost integer,
  p_limits jsonb
)
returns table (allowed boolean, retry_after_seconds integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_policy jsonb;
  v_scope_type text;
  v_scope_key_hash text;
  v_window_seconds integer;
  v_limit integer;
  v_bucket_start timestamptz;
  v_current_usage integer;
  v_retry_after integer := 0;
begin
  if p_operation is null or length(p_operation) not between 1 and 64 then
    raise exception 'Invalid cost protection operation' using errcode = '22023';
  end if;
  if p_cost is null or p_cost not between 1 and 1000 then
    raise exception 'Invalid cost protection cost' using errcode = '22023';
  end if;
  if p_limits is null or jsonb_typeof(p_limits) <> 'array' or jsonb_array_length(p_limits) not between 1 and 12 then
    raise exception 'Invalid cost protection policies' using errcode = '22023';
  end if;

  -- Ensure every counter exists before acquiring locks.
  for v_policy in
    select value
    from jsonb_array_elements(p_limits)
    order by value->>'scopeType', value->>'scopeKeyHash', (value->>'windowSeconds')::integer
  loop
    v_scope_type := v_policy->>'scopeType';
    v_scope_key_hash := lower(v_policy->>'scopeKeyHash');
    v_window_seconds := (v_policy->>'windowSeconds')::integer;
    v_limit := (v_policy->>'limit')::integer;
    if length(v_scope_type) not between 1 and 32
      or v_scope_key_hash !~ '^[0-9a-f]{64}$'
      or v_window_seconds not between 1 and 604800
      or v_limit not between 1 and 10000000 then
      raise exception 'Invalid cost protection policy' using errcode = '22023';
    end if;
    v_bucket_start := to_timestamp(
      floor(extract(epoch from v_now) / v_window_seconds) * v_window_seconds
    );
    insert into public.cost_rate_limit_counters (
      scope_type, scope_key_hash, operation, window_seconds, bucket_start, usage_count
    ) values (
      v_scope_type, v_scope_key_hash, p_operation, v_window_seconds, v_bucket_start, 0
    ) on conflict do nothing;
  end loop;

  -- Lock and evaluate in the same stable order used above.
  for v_policy in
    select value
    from jsonb_array_elements(p_limits)
    order by value->>'scopeType', value->>'scopeKeyHash', (value->>'windowSeconds')::integer
  loop
    v_scope_type := v_policy->>'scopeType';
    v_scope_key_hash := lower(v_policy->>'scopeKeyHash');
    v_window_seconds := (v_policy->>'windowSeconds')::integer;
    v_limit := (v_policy->>'limit')::integer;
    v_bucket_start := to_timestamp(
      floor(extract(epoch from v_now) / v_window_seconds) * v_window_seconds
    );

    select counters.usage_count
      into v_current_usage
    from public.cost_rate_limit_counters as counters
    where counters.scope_type = v_scope_type
      and counters.scope_key_hash = v_scope_key_hash
      and counters.operation = p_operation
      and counters.window_seconds = v_window_seconds
      and counters.bucket_start = v_bucket_start
    for update;

    if v_current_usage + p_cost > v_limit then
      v_retry_after := greatest(
        v_retry_after,
        ceil(extract(epoch from (v_bucket_start + make_interval(secs => v_window_seconds) - v_now)))::integer
      );
    end if;
  end loop;

  if v_retry_after > 0 then
    return query select false, v_retry_after;
    return;
  end if;

  for v_policy in select value from jsonb_array_elements(p_limits)
  loop
    v_scope_type := v_policy->>'scopeType';
    v_scope_key_hash := lower(v_policy->>'scopeKeyHash');
    v_window_seconds := (v_policy->>'windowSeconds')::integer;
    v_bucket_start := to_timestamp(
      floor(extract(epoch from v_now) / v_window_seconds) * v_window_seconds
    );
    update public.cost_rate_limit_counters as counters
    set usage_count = counters.usage_count + p_cost,
        updated_at = v_now
    where counters.scope_type = v_scope_type
      and counters.scope_key_hash = v_scope_key_hash
      and counters.operation = p_operation
      and counters.window_seconds = v_window_seconds
      and counters.bucket_start = v_bucket_start;
  end loop;

  return query select true, 0;
end;
$$;

revoke all on function public.consume_cost_rate_limits(text, integer, jsonb) from public, anon, authenticated;
grant execute on function public.consume_cost_rate_limits(text, integer, jsonb) to service_role;

-- Bounded retention keeps the operational tables small. This deletes only
-- expired anti-abuse metadata and never touches financial or receipt records.
create or replace function public.cleanup_cost_protection()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.cost_rate_limit_counters
  where bucket_start < now() - interval '8 days';
  delete from public.telegram_update_claims
  where claimed_at < now() - interval '8 days';
end;
$$;

revoke all on function public.cleanup_cost_protection() from public, anon, authenticated;
grant execute on function public.cleanup_cost_protection() to service_role;

select cron.unschedule(jobid)
from cron.job
where jobname = 'ofa-cost-protection-cleanup';

select cron.schedule(
  'ofa-cost-protection-cleanup',
  '17 3 * * *',
  $cron$select public.cleanup_cost_protection();$cron$
);
