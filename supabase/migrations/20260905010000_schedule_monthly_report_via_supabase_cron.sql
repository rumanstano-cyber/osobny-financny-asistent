-- Trigger the Render API from Supabase. Credentials stay in Supabase Vault,
-- never in this migration or the Git repository.
create extension if not exists pg_net;
create extension if not exists pg_cron with schema pg_catalog;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'weekly_report_api_base_url') then
    raise exception 'Missing Vault secret weekly_report_api_base_url';
  end if;

  if not exists (select 1 from vault.secrets where name = 'weekly_report_internal_cron_secret') then
    raise exception 'Missing Vault secret weekly_report_internal_cron_secret';
  end if;
end;
$$;

-- pg_cron uses UTC. The command runs every 15 minutes on the first UTC day,
-- but sends only at 08:00–08:45 Europe/Bratislava. PostgreSQL's timezone data
-- automatically handles both CET and CEST. The retries are safe because the
-- monthly delivery row is unique per workspace and reported period.
select cron.schedule(
  'monthly-financial-report-bratislava',
  '*/15 * 1 * *',
  $cron$
    with local_clock as (
      select now() at time zone 'Europe/Bratislava' as local_time
    )
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_report_api_base_url')
        || '/internal/reports/monthly/run',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Internal-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_report_internal_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    )
    from local_clock
    where extract(day from local_time) = 1
      and extract(hour from local_time) = 8
      and extract(minute from local_time) in (0, 15, 30, 45);
  $cron$
);
