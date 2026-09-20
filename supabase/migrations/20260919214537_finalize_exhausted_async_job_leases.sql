-- A worker can die after the final claim and before application code records a
-- terminal failure. Expired final leases must not remain `running` forever.
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
set search_path = ''
as $$
begin
  if p_job_type is null or char_length(p_job_type) < 1 or char_length(p_job_type) > 64
    or p_lease_interval < interval '1 minute' or p_lease_interval > interval '1 hour' then
    raise exception 'Invalid async job claim parameters' using errcode = '22023';
  end if;

  update public.async_jobs j
  set status = 'failed',
      completed_at = pg_catalog.now(),
      locked_at = null,
      last_error_code = 'worker_lease_exhausted',
      last_error = 'Worker lease expired after the final processing attempt'
  where j.job_type = p_job_type
    and j.status = 'running'
    and j.attempt_count >= j.max_attempts
    and j.locked_at < pg_catalog.now() - p_lease_interval;

  return query
  with candidate as (
    select j.id
    from public.async_jobs j
    where j.job_type = p_job_type
      and j.attempt_count < j.max_attempts
      and (
        (j.status = 'queued' and j.run_after <= pg_catalog.now())
        or (j.status = 'running' and j.locked_at < pg_catalog.now() - p_lease_interval)
      )
    order by j.run_after, j.created_at
    for update skip locked
    limit 1
  )
  update public.async_jobs j
  set status = 'running',
      locked_at = pg_catalog.now(),
      attempt_count = j.attempt_count + 1,
      last_error_code = null,
      last_error = null
  from candidate
  where j.id = candidate.id
  returning j.id, j.job_type::text, j.payload, j.attempt_count, j.max_attempts;
end;
$$;

revoke all on function public.claim_async_job(text, interval) from public, anon, authenticated;
grant execute on function public.claim_async_job(text, interval) to service_role;
