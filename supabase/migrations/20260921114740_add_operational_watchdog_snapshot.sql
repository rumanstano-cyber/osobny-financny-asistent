-- Read-only, privacy-minimised operational snapshot for the external watchdog.
-- It exposes no user content or identifiers and is callable only by service_role.
create or replace function public.get_operational_watchdog_snapshot()
returns jsonb
language sql
security definer
set search_path = ''
as $$
  with expected_jobs(jobname, max_age) as (
    values
      ('weekly-financial-report-bratislava'::text, interval '90 minutes'),
      ('monthly-financial-report-bratislava'::text, interval '2 hours'),
      ('receipt-purchase-protection-maintenance'::text, interval '2 hours'),
      ('ofa-cost-protection-cleanup'::text, interval '36 hours')
  ), cron_state as (
    select
      expected.jobname,
      expected.max_age,
      job.jobid,
      coalesce(job.active, false) as active,
      pg_catalog.max(run.end_time) filter (where run.status = 'succeeded') as last_success_at,
      pg_catalog.count(run.runid) filter (
        where run.status not in ('succeeded', 'running')
          and run.start_time >= pg_catalog.now() - expected.max_age
      )::integer as recent_failure_count
    from expected_jobs expected
    left join cron.job job on job.jobname = expected.jobname
    left join cron.job_run_details run on run.jobid = job.jobid
    group by expected.jobname, expected.max_age, job.jobid, job.active
  ), cron_incidents as (
    select pg_catalog.jsonb_build_object(
      'code', case
        when state.jobid is null then 'critical_cron_missing'
        when not state.active then 'critical_cron_inactive'
        when state.last_success_at is null or state.last_success_at < pg_catalog.now() - state.max_age then 'critical_cron_overdue'
        else 'critical_cron_repeated_failures'
      end,
      'fingerprint', pg_catalog.encode(extensions.digest(
        'operational-watchdog:cron:' || state.jobname || ':' || case
          when state.jobid is null then 'missing'
          when not state.active then 'inactive'
          when state.last_success_at is null or state.last_success_at < pg_catalog.now() - state.max_age then 'overdue'
          else 'failed'
        end,
        'sha256'
      ), 'hex'),
      'observedAt', pg_catalog.now(),
      'autoResolve', true
    ) as incident
    from cron_state state
    where state.jobid is null
      or not state.active
      or state.last_success_at is null
      or state.last_success_at < pg_catalog.now() - state.max_age
      or state.recent_failure_count >= 2
  ), async_incidents as (
    select pg_catalog.jsonb_build_object(
      'code', 'terminal_async_job_failed',
      'fingerprint', pg_catalog.encode(extensions.digest('operational-watchdog:async:' || job.id::text, 'sha256'), 'hex'),
      'observedAt', coalesce(job.completed_at, job.created_at),
      'autoResolve', false
    ) as incident
    from public.async_jobs job
    where job.status = 'failed'
      and coalesce(job.completed_at, job.created_at) >= pg_catalog.now() - interval '35 days'
    order by coalesce(job.completed_at, job.created_at) desc
    limit 100
  ), report_incidents as (
    select pg_catalog.jsonb_build_object(
      'code', 'terminal_report_delivery_failed',
      'fingerprint', pg_catalog.encode(extensions.digest('operational-watchdog:report:' || delivery.id::text, 'sha256'), 'hex'),
      'observedAt', coalesce(delivery.claimed_at, delivery.generated_at, delivery.created_at),
      'autoResolve', false
    ) as incident
    from public.report_deliveries delivery
    where delivery.status = 'failed'
      and delivery.created_at >= pg_catalog.now() - interval '35 days'
    order by delivery.created_at desc
    limit 100
  ), reminder_incidents as (
    select pg_catalog.jsonb_build_object(
      'code', 'terminal_warranty_reminder_failed',
      'fingerprint', pg_catalog.encode(extensions.digest('operational-watchdog:reminder:' || reminder.id::text, 'sha256'), 'hex'),
      'observedAt', reminder.updated_at,
      'autoResolve', false
    ) as incident
    from public.receipt_purchase_protection_reminders reminder
    where reminder.status = 'failed'
      and reminder.updated_at >= pg_catalog.now() - interval '35 days'
    order by reminder.updated_at desc
    limit 100
  ), all_incidents as (
    select incident from cron_incidents
    union all select incident from async_incidents
    union all select incident from report_incidents
    union all select incident from reminder_incidents
  )
  select pg_catalog.jsonb_build_object(
    'generatedAt', pg_catalog.now(),
    'incidents', coalesce(pg_catalog.jsonb_agg(incident), '[]'::jsonb)
  )
  from all_incidents;
$$;

revoke all on function public.get_operational_watchdog_snapshot() from public, anon, authenticated;
grant execute on function public.get_operational_watchdog_snapshot() to service_role;
