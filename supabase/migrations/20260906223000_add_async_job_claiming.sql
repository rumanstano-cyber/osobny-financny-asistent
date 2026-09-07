-- Durable media-job claiming for the Telegram worker. This migration creates
-- no financial records and does not alter existing jobs or transactions.
alter table public.async_jobs
  add column if not exists last_error text;

create or replace function public.claim_async_job(
  p_job_type text,
  p_lease_interval interval default interval '15 minutes'
)
returns table (
  id uuid,
  job_type text,
  payload jsonb,
  attempt_count smallint,
  max_attempts smallint
)
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with candidate as (
    select j.id
    from public.async_jobs j
    where j.job_type = p_job_type
      and j.attempt_count < j.max_attempts
      and (
        (j.status = 'queued' and j.run_after <= now())
        or (j.status = 'running' and j.locked_at < now() - p_lease_interval)
      )
    order by j.run_after, j.created_at
    for update skip locked
    limit 1
  )
  update public.async_jobs j
  set status = 'running', locked_at = now(), attempt_count = j.attempt_count + 1, last_error_code = null, last_error = null
  from candidate
  where j.id = candidate.id
  returning j.id, j.job_type, j.payload, j.attempt_count, j.max_attempts;
end;
$$;

revoke all on function public.claim_async_job(text, interval) from public, anon, authenticated;
grant execute on function public.claim_async_job(text, interval) to service_role;
