-- Durable, bounded recovery for scheduled report deliveries and warranty
-- reminders. Existing sent rows and financial/user data are not modified.

alter table public.report_deliveries
  add column if not exists attempt_count smallint not null default 0,
  add column if not exists max_attempts smallint not null default 5,
  add column if not exists next_attempt_at timestamptz,
  add column if not exists claimed_at timestamptz,
  add column if not exists last_error text;

update public.report_deliveries
set next_attempt_at = created_at
where next_attempt_at is null;

alter table public.report_deliveries
  alter column next_attempt_at set default pg_catalog.now(),
  alter column next_attempt_at set not null;

do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.report_deliveries'::pg_catalog.regclass
      and conname = 'report_deliveries_attempt_count_check'
  ) then
    alter table public.report_deliveries
      add constraint report_deliveries_attempt_count_check
      check (attempt_count >= 0);
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.report_deliveries'::pg_catalog.regclass
      and conname = 'report_deliveries_max_attempts_check'
  ) then
    alter table public.report_deliveries
      add constraint report_deliveries_max_attempts_check
      check (max_attempts between 1 and 10);
  end if;
end;
$$;

create index if not exists report_deliveries_recovery_due_idx
  on public.report_deliveries (next_attempt_at, created_at)
  where status in ('queued', 'generated', 'failed');

create or replace function public.claim_scheduled_report_delivery(
  p_workspace_id uuid,
  p_report_type public.report_type,
  p_period_start timestamptz,
  p_period_end timestamptz,
  p_base_currency_code character(3),
  p_data_snapshot jsonb,
  p_lease_interval interval default interval '15 minutes'
)
returns table (delivery_id uuid, data_snapshot jsonb, attempt_count smallint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery public.report_deliveries%rowtype;
begin
  if p_workspace_id is null
    or p_report_type is null
    or p_report_type not in ('weekly_summary', 'monthly_summary')
    or p_period_start is null
    or p_period_end is null
    or p_period_end < p_period_start
    or p_base_currency_code is null
    or p_data_snapshot is null
    or p_lease_interval is null
    or p_lease_interval < interval '5 minutes'
    or p_lease_interval > interval '60 minutes' then
    raise exception 'Invalid scheduled report delivery claim' using errcode = '22023';
  end if;

  insert into public.report_deliveries (
    workspace_id,
    report_type,
    period_start,
    period_end,
    base_currency_code,
    data_snapshot,
    status,
    attempt_count,
    max_attempts,
    next_attempt_at
  ) values (
    p_workspace_id,
    p_report_type,
    p_period_start,
    p_period_end,
    p_base_currency_code,
    p_data_snapshot,
    'queued',
    0,
    5,
    pg_catalog.now()
  )
  on conflict do nothing;

  select delivery.*
  into v_delivery
  from public.report_deliveries delivery
  where delivery.workspace_id = p_workspace_id
    and delivery.report_type = p_report_type
    and delivery.period_start = p_period_start
  for update;

  if not found or v_delivery.status in ('sent', 'cancelled') then
    return;
  end if;

  if v_delivery.status = 'generated'
    and v_delivery.claimed_at is not null
    and v_delivery.claimed_at >= pg_catalog.now() - p_lease_interval then
    return;
  end if;

  if v_delivery.attempt_count >= v_delivery.max_attempts then
    update public.report_deliveries delivery
    set status = 'failed',
        claimed_at = null,
        last_error = case
          when v_delivery.status = 'generated' then 'Report worker lease expired after final attempt'
          else coalesce(v_delivery.last_error, 'Report delivery attempts exhausted')
        end
    where delivery.id = v_delivery.id;
    return;
  end if;

  if v_delivery.status in ('queued', 'failed')
    and v_delivery.next_attempt_at > pg_catalog.now() then
    return;
  end if;

  update public.report_deliveries delivery
  set status = 'generated',
      generated_at = coalesce(delivery.generated_at, pg_catalog.now()),
      claimed_at = pg_catalog.now(),
      attempt_count = delivery.attempt_count + 1,
      last_error = null
  where delivery.id = v_delivery.id
  returning delivery.* into v_delivery;

  return query
  select v_delivery.id, v_delivery.data_snapshot, v_delivery.attempt_count;
end;
$$;

create or replace function public.complete_scheduled_report_delivery(
  p_delivery_id uuid,
  p_succeeded boolean,
  p_error text default null,
  p_cancelled boolean default false
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_delivery public.report_deliveries%rowtype;
  v_backoff interval;
begin
  if p_delivery_id is null or p_succeeded is null or p_cancelled is null then
    return false;
  end if;

  select delivery.*
  into v_delivery
  from public.report_deliveries delivery
  where delivery.id = p_delivery_id
  for update;

  if not found or v_delivery.status <> 'generated' then
    return false;
  end if;

  if p_cancelled then
    update public.report_deliveries delivery
    set status = 'cancelled',
        claimed_at = null,
        last_error = left(coalesce(p_error, 'No active report recipient'), 2000)
    where delivery.id = v_delivery.id;
    return true;
  end if;

  if p_succeeded then
    update public.report_deliveries delivery
    set status = 'sent',
        generated_at = coalesce(delivery.generated_at, pg_catalog.now()),
        sent_at = pg_catalog.now(),
        claimed_at = null,
        last_error = null
    where delivery.id = v_delivery.id;
    return true;
  end if;

  if v_delivery.attempt_count >= v_delivery.max_attempts then
    update public.report_deliveries delivery
    set status = 'failed',
        claimed_at = null,
        last_error = left(coalesce(p_error, 'Report delivery failed'), 2000)
    where delivery.id = v_delivery.id;
    return true;
  end if;

  v_backoff := case v_delivery.attempt_count
    when 1 then interval '15 minutes'
    when 2 then interval '30 minutes'
    when 3 then interval '60 minutes'
    else interval '120 minutes'
  end;

  update public.report_deliveries delivery
  set status = 'queued',
      claimed_at = null,
      next_attempt_at = pg_catalog.now() + v_backoff,
      last_error = left(coalesce(p_error, 'Report delivery failed'), 2000)
  where delivery.id = v_delivery.id;
  return true;
end;
$$;

-- A delivery created before all workspace access was revoked must not remain
-- recoverable forever. This only terminalizes workspaces that no longer have
-- any active user/member pair; it never changes sent deliveries.
create or replace function public.cancel_inaccessible_scheduled_report_deliveries(
  p_report_type public.report_type
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cancelled integer;
begin
  if p_report_type is null
    or p_report_type not in ('weekly_summary', 'monthly_summary') then
    raise exception 'Invalid scheduled report type' using errcode = '22023';
  end if;

  with cancelled as (
    update public.report_deliveries delivery
    set status = 'cancelled',
        claimed_at = null,
        last_error = 'No active workspace recipient'
    where delivery.report_type = p_report_type
      and delivery.status in ('queued', 'generated', 'failed')
      and not exists (
        select 1
        from public.workspace_members membership
        join public.ofa_users app_user on app_user.id = membership.user_id
        join public.workspaces workspace on workspace.id = membership.workspace_id
        where membership.workspace_id = delivery.workspace_id
          and membership.status = 'active'
          and membership.removed_at is null
          and app_user.status = 'active'
          and app_user.deleted_at is null
          and workspace.deleted_at is null
      )
    returning delivery.id
  )
  select pg_catalog.count(*)::integer into v_cancelled
  from cancelled;

  return v_cancelled;
end;
$$;

-- Once a deliberately bounded catch-up window has closed, unfinished work is
-- terminalized instead of remaining queued forever. The cutoffs are one hour
-- after the final permitted HTTP catch-up invocation.
create or replace function public.finalize_expired_scheduled_report_deliveries()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_failed integer;
begin
  with failed as (
    update public.report_deliveries delivery
    set status = 'failed',
        attempt_count = delivery.max_attempts,
        claimed_at = null,
        last_error = coalesce(delivery.last_error, 'Scheduled report catch-up window expired')
    where delivery.status in ('queued', 'generated', 'failed')
      and (
        (
          delivery.report_type = 'weekly_summary'
          and delivery.period_end + interval '21 hours' <= pg_catalog.now()
        )
        or (
          delivery.report_type = 'monthly_summary'
          and delivery.period_end + interval '45 hours' <= pg_catalog.now()
        )
      )
      and delivery.attempt_count < delivery.max_attempts
    returning delivery.id
  )
  select pg_catalog.count(*)::integer into v_failed
  from failed;

  return v_failed;
end;
$$;

revoke all on function public.claim_scheduled_report_delivery(
  uuid, public.report_type, timestamptz, timestamptz, character, jsonb, interval
) from public, anon, authenticated;
revoke all on function public.complete_scheduled_report_delivery(
  uuid, boolean, text, boolean
) from public, anon, authenticated;
revoke all on function public.cancel_inaccessible_scheduled_report_deliveries(
  public.report_type
) from public, anon, authenticated;
revoke all on function public.finalize_expired_scheduled_report_deliveries()
  from public, anon, authenticated;
grant execute on function public.claim_scheduled_report_delivery(
  uuid, public.report_type, timestamptz, timestamptz, character, jsonb, interval
) to service_role;
grant execute on function public.complete_scheduled_report_delivery(
  uuid, boolean, text, boolean
) to service_role;
grant execute on function public.cancel_inaccessible_scheduled_report_deliveries(
  public.report_type
) to service_role;
grant execute on function public.finalize_expired_scheduled_report_deliveries()
  to service_role;

-- A stale final reminder claim must terminate instead of being reclaimed
-- forever after repeated worker crashes.
create or replace function public.claim_due_receipt_purchase_protection_reminders(p_limit integer default 100)
returns table (reminder_id uuid, telegram_user_id text, milestone_days smallint)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'p_limit must be between 1 and 200' using errcode = '22023';
  end if;

  return query
  with exhausted as (
    update public.receipt_purchase_protection_reminders reminder
    set status = 'failed',
        claimed_at = null,
        last_error = coalesce(reminder.last_error, 'Reminder worker lease expired after final attempt')
    where reminder.attempt_count >= 5
      and (
        (reminder.status = 'sending' and reminder.claimed_at < pg_catalog.now() - interval '15 minutes')
        or (reminder.status = 'queued' and reminder.next_attempt_at <= pg_catalog.now())
      )
    returning reminder.id
  ), candidate as (
    select reminder.id
    from public.receipt_purchase_protection_reminders reminder
    join public.receipt_purchase_protections protection on protection.id = reminder.protection_id
    join public.ofa_receipts receipt on receipt.id = protection.receipt_id
    join public.financial_transactions financial_transaction on financial_transaction.id = protection.transaction_id
    where reminder.attempt_count < 5
      and (
        (reminder.status = 'queued' and reminder.next_attempt_at <= pg_catalog.now())
        or (reminder.status = 'sending' and reminder.claimed_at < pg_catalog.now() - interval '15 minutes')
      )
      and reminder.scheduled_for <= (pg_catalog.now() at time zone 'Europe/Bratislava')::date
      and protection.status = 'active'
      and receipt.archive_status = 'archived'
      and receipt.deleted_at is null
      and financial_transaction.status = 'confirmed'
      and financial_transaction.deleted_at is null
      and exists (
        select 1
        from public.channel_accounts account
        where account.user_id = reminder.recipient_user_id
          and account.channel = 'telegram'
          and account.unlinked_at is null
      )
    order by reminder.scheduled_for, reminder.created_at
    for update of reminder skip locked
    limit p_limit
  ), claimed as (
    update public.receipt_purchase_protection_reminders reminder
    set status = 'sending',
        claimed_at = pg_catalog.now(),
        attempt_count = reminder.attempt_count + 1
    from candidate
    where reminder.id = candidate.id
    returning reminder.id, reminder.recipient_user_id, reminder.milestone_days
  )
  select claimed.id, account.external_account_id, claimed.milestone_days
  from claimed
  join lateral (
    select channel_account.external_account_id
    from public.channel_accounts channel_account
    where channel_account.user_id = claimed.recipient_user_id
      and channel_account.channel = 'telegram'
      and channel_account.unlinked_at is null
    order by channel_account.created_at desc
    limit 1
  ) account on true;
end;
$$;

revoke all on function public.claim_due_receipt_purchase_protection_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.claim_due_receipt_purchase_protection_reminders(integer)
  to service_role;

-- Keep the existing protected API endpoints and Vault secrets. Only widen the
-- bounded retry/catch-up windows; no historical periods are enumerated.
select cron.unschedule(jobid)
from cron.job
where jobname = 'weekly-financial-report-bratislava';

select cron.schedule(
  'weekly-financial-report-bratislava',
  '*/30 * * * *',
  $cron$
    select public.finalize_expired_scheduled_report_deliveries();

    with local_clock as (
      select pg_catalog.now() at time zone 'Europe/Bratislava' as local_time
    )
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_report_api_base_url')
        || '/internal/reports/weekly/run',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Internal-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_report_internal_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    )
    from local_clock
    where extract(isodow from local_time) = 1
      and (
        extract(hour from local_time) between 8 and 19
        or (
          extract(hour from local_time) = 20
          and extract(minute from local_time) = 0
        )
      );
  $cron$
);

select cron.unschedule(jobid)
from cron.job
where jobname = 'monthly-financial-report-bratislava';

select cron.schedule(
  'monthly-financial-report-bratislava',
  '0 * * * *',
  $cron$
    select public.finalize_expired_scheduled_report_deliveries();

    with local_clock as (
      select pg_catalog.now() at time zone 'Europe/Bratislava' as local_time
    )
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_report_api_base_url')
        || '/internal/reports/monthly/run',
      headers := pg_catalog.jsonb_build_object(
        'Content-Type', 'application/json',
        'X-Internal-Cron-Secret', (select decrypted_secret from vault.decrypted_secrets where name = 'weekly_report_internal_cron_secret')
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 120000
    )
    from local_clock
    where extract(day from local_time) in (1, 2)
      and extract(hour from local_time) between 8 and 20;
  $cron$
);
